/**
 * Ruder-Sensor: ESP32-Firmware für das physio & fit Ruder-Dashboard.
 *
 * Aufgabe: Impulse vom Schwungrad zählen und als ASCII-Zeilen über WLAN
 * (WebSocket) und USB (Serial) verschicken. Alles Weitere – Leistung,
 * Split, Schlagzahl – rechnet das Dashboard.
 *
 * Nachrichtenformat (eine Zeile pro Nachricht, Zeilenende "\n"):
 *
 *   B,<bootId>,<millis>      beim Verbinden: Bootkennung + Gerätezeit
 *   P,<millis>               Impuls mit Gerätezeit
 *   S,<rssi>,<clients>,<pps> alle 5 s: Status
 *   T,<ms>                   kürzester Impulsabstand, nur auf Anfrage
 *
 * Befehle vom Dashboard: "boot?" und "diag?".
 *
 * Warum Zeitstempel statt nur "I": Der Zeitstempel entsteht direkt im
 * Interrupt, also ohne Verzögerung durch WLAN oder Batching. Das Dashboard
 * rechnet die Übertragungszeit heraus und erkennt Schläge auch dann noch
 * sauber, wenn das WLAN 30 ms jittert.
 */

#include <Arduino.h>
#include <ArduinoOTA.h>
#include <Preferences.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <WiFi.h>
#include <cstring>          // strlen(), memcmp()

#include <esp_random.h>       // esp_random()
#include <esp_system.h>       // esp_reset_reason()
#include <esp_timer.h>        // esp_timer_get_time()
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

// Lokale Zugangsdaten (nicht im Repository). Fehlt die Datei – etwa im
// CI-Build – greifen die Standardwerte direkt in der Firmware, sodass ohne
// weitere Schritte eine lauffähige .bin entsteht.
#if defined(__has_include)
#if __has_include("config.h")
#include "config.h"
#define RUDER_HAS_USER_CONFIG 1
#endif
#endif
#ifndef RUDER_HAS_USER_CONFIG
#define RUDER_HAS_USER_CONFIG 0
#endif

#include "pulse_filter.h"

// Das gebaute Dashboard, eingebettet von tools/embed-dashboard.mjs.
// Fehlt der Header (frischer Checkout ohne npm run build), startet die
// Firmware trotzdem – dann gibt es nur die Diagnoseseite.
#if defined(__has_include)
#if __has_include("dashboard_assets.h")
#include "dashboard_assets.h"
#define RUDER_HAS_DASHBOARD 1
#endif
#endif
#ifndef RUDER_HAS_DASHBOARD
#define RUDER_HAS_DASHBOARD 0
#endif

/* ---------- Standardwerte ----------
 * Bewusst schwach: ein Werksgerät hat kein WLAN und startet deshalb im
 * Einrichtungsmodus (access point "ruder-sensor-setup"). Wer die Firmware
 * selbst baut, kann in include/config.h alles vorgeben – dann entfällt die
 * Einrichtung am Gerät.
 *
 * Diese #ifndef-Blöcke füllen nur, was config.h nicht gesetzt hat.
 */
#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif
#ifndef USE_STATIC_IP
#define USE_STATIC_IP false
#endif
#ifndef STATIC_IP
#define STATIC_IP "0.0.0.0"
#endif
#ifndef STATIC_GATEWAY
#define STATIC_GATEWAY "0.0.0.0"
#endif
#ifndef STATIC_SUBNET
#define STATIC_SUBNET "255.255.255.0"
#endif
#ifndef STATIC_DNS
#define STATIC_DNS "0.0.0.0"
#endif
#ifndef MDNS_HOSTNAME
#define MDNS_HOSTNAME "ruder-sensor"
#endif
#ifndef SENSOR_PIN
#define SENSOR_PIN 27
#endif
#ifndef SENSOR_USE_INTERNAL_PULLUP
#define SENSOR_USE_INTERNAL_PULLUP true
#endif
#ifndef SENSOR_TRIGGER_RISING
#define SENSOR_TRIGGER_RISING true
#endif
#ifndef DEBOUNCE_US
#define DEBOUNCE_US 3000
#endif
#ifndef PULSE_BUFFER_SIZE
#define PULSE_BUFFER_SIZE 128
#endif
#ifndef WS_PORT
#define WS_PORT 81
#endif
#ifndef HTTP_PORT
#define HTTP_PORT 80
#endif
#ifndef STATUS_INTERVAL_MS
#define STATUS_INTERVAL_MS 5000
#endif
#ifndef WS_SEND_BATCH
#define WS_SEND_BATCH 12
#endif
#ifndef MAX_WS_CLIENTS
#define MAX_WS_CLIENTS 4
#endif
#ifndef OTA_ENABLED
#define OTA_ENABLED true
#endif
#ifndef OTA_HOSTNAME
#define OTA_HOSTNAME "ruder-sensor"
#endif
#ifndef OTA_PASSWORD
#define OTA_PASSWORD "ruder-ota"
#endif
#ifndef SERIAL_MIRROR
#define SERIAL_MIRROR true
#endif
#ifndef WIFI_TIMEOUT_MS
#define WIFI_TIMEOUT_MS 20000
#endif
// Dashboard direkt vom ESP32 ausliefern (http://ruder-sensor.local/).
// Kostet rund 30 kB Flash, dafür braucht im Studio kein Laptop zu laufen.
#ifndef DASHBOARD_AUSLIEFERN
#define DASHBOARD_AUSLIEFERN true
#endif

// Zugangsdaten fehlen -> Einrichtungsmodus. So ist eine frisch geflashte
// .bin ohne eigene config.h sofort benutzbar statt in einer Neustart-
// schleife zu hängen.
#define WIFI_CONFIGURED (sizeof(WIFI_SSID) > 1)

namespace {

ruder::PulseFilter<PULSE_BUFFER_SIZE> gFilter(ruder::FilterConfig{DEBOUNCE_US});
portMUX_TYPE gMux = portMUX_INITIALIZER_UNLOCKED;

WebSocketsServer gWebSocket(WS_PORT);
WebServer gHttp(HTTP_PORT);
uint32_t gBootId = 0;

/**
 * Nur der Interrupt fasst den Filter an, `loop()` liest ihn unter derselben
 * Sperre. Kein Serial/WebSocket im Interrupt – das blockiert bei 240 MHz
 * schnell für Millisekunden und verfälscht die Impulsabstände.
 */
void IRAM_ATTR onSensorPulse() {
  const uint32_t micros = static_cast<uint32_t>(esp_timer_get_time());
  portENTER_CRITICAL_ISR(&gMux);
  gFilter.accept(micros);
  portEXIT_CRITICAL_ISR(&gMux);
}

size_t drainPulses(ruder::TimedPulse *out, size_t max) {
  portENTER_CRITICAL(&gMux);
  const size_t count = gFilter.drain(out, max);
  portEXIT_CRITICAL(&gMux);
  return count;
}

ruder::PulseStats statsSnapshot() {
  portENTER_CRITICAL(&gMux);
  const ruder::PulseStats copy = gFilter.stats();
  const float rate = gFilter.maxRateHz();
  portEXIT_CRITICAL(&gMux);
  // rate wird über den Rückgabewert nicht transportiert; die Diagnose
  // rechnet aus minPeriodUs, damit hier nichts verloren geht.
  (void)rate;
  return copy;
}

void sendLine(const String &line) {
#if SERIAL_MIRROR
  Serial.print(line);
#endif
  gWebSocket.broadcastTXT(reinterpret_cast<const uint8_t *>(line.c_str()), line.length());
}

void announceToClient(uint8_t client) {
  char greeting[48];
  snprintf(greeting, sizeof(greeting), "B,%lu,%lu\n", static_cast<unsigned long>(gBootId),
           static_cast<unsigned long>(millis()));
  gWebSocket.sendTXT(client, reinterpret_cast<uint8_t *>(greeting), strlen(greeting));
}

void handleSocketEvent(uint8_t client, WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("# Dashboard verbunden: %s\n", gWebSocket.remoteIP(client).toString().c_str());
      announceToClient(client);
      break;

    case WStype_DISCONNECTED:
      Serial.printf("# Dashboard getrennt: %u\n", client);
      break;

    case WStype_TEXT: {
      String command(reinterpret_cast<char *>(payload), length);
      command.trim();
      if (command == "boot?") {
        announceToClient(client);
      } else if (command == "diag?") {
        const ruder::PulseStats stats = statsSnapshot();
        char diag[32];
        snprintf(diag, sizeof(diag), "T,%.3f\n", stats.minPeriodUs / 1000.0F);
        gWebSocket.sendTXT(client, reinterpret_cast<uint8_t *>(diag), strlen(diag));
      }
      break;
    }

    default:
      break;
  }
}

/* ---------- Einrichtungsmodus ----------
 * Eine frisch geflashte .bin kennt kein WLAN. Statt endlos neu zu starten,
 * öffnet das Gerät einen Access Point mit einer kleinen Seite: Netz wählen,
 * Passwort eingeben, fertig. Die Zugangsdaten liegen im NVS und überleben
 * Firmware-Updates.
 */

Preferences gConfig;
bool gSetupMode = false;
String gSavedSsid;
String gSavedPassword;

const char *kPreferenceNamespace = "ruder";

void loadSavedWifi() {
  gConfig.begin(kPreferenceNamespace, true);
  gSavedSsid = gConfig.getString("ssid", "");
  gSavedPassword = gConfig.getString("pass", "");
  gConfig.end();
}

void saveWifi(const String &ssid, const String &password) {
  gConfig.begin(kPreferenceNamespace, false);
  gConfig.putString("ssid", ssid);
  gConfig.putString("pass", password);
  gConfig.end();
}

/**
 * WLAN-Zugangsdaten, die tatsächlich verwendet werden.
 * Rückgabe als Kopie: ein Verweis auf ein temporäres String-Objekt wäre
 * nach demreturn ungültig.
 */
String activeSsid() {
  return gSavedSsid.length() > 0 ? gSavedSsid : String(WIFI_SSID);
}

String activePassword() {
  return gSavedSsid.length() > 0 ? gSavedPassword : String(WIFI_PASSWORD);
}

String htmlEscape(const String &value) {
  String out;
  out.reserve(value.length());
  for (size_t i = 0; i < value.length(); i++) {
    const char c = value[i];
    if (c == '&') {
      out += F("&amp;");
    } else if (c == '<') {
      out += F("&lt;");
    } else if (c == '"') {
      out += F("&quot;");
    } else {
      out += c;
    }
  }
  return out;
}

bool connectWifi() {
#if USE_STATIC_IP
  IPAddress ip, gateway, subnet, dns;
  ip.fromString(STATIC_IP);
  gateway.fromString(STATIC_GATEWAY);
  subnet.fromString(STATIC_SUBNET);
  dns.fromString(STATIC_DNS);
  if (!WiFi.config(ip, gateway, subnet, dns)) {
    Serial.println("# Feste IP ungültig, nutze DHCP");
  }
#endif

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(MDNS_HOSTNAME);
  // Modem-Schlaf spart Strom, kostet aber Latenz und Jitter – im Studio
  // hängt das Gerät am Netzteil.
  WiFi.setSleep(false);

  const String ssid = activeSsid();
  WiFi.begin(ssid.c_str(), activePassword().c_str());

  Serial.printf("# WLAN verbinden mit \"%s\"", ssid.c_str());
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
    if (millis() - start > WIFI_TIMEOUT_MS) {
      Serial.println();
      Serial.println("# WLAN nicht erreichbar.");
      return false;
    }
  }
  Serial.printf("\n# WLAN verbunden: %s (Kanal %d, %d dBm)\n", WiFi.localIP().toString().c_str(),
                WiFi.channel(), WiFi.RSSI());
  return true;
}

void startMdns() {
  if (!MDNS.begin(MDNS_HOSTNAME)) {
    Serial.println("# mDNS fehlgeschlagen – IP-Adresse direkt nutzen");
    return;
  }
  MDNS.addService("http", "tcp", HTTP_PORT);
  MDNS.addService("ws", "tcp", WS_PORT);
  Serial.printf("# Im Netz erreichbar als %s.local\n", MDNS_HOSTNAME);
}

/* ---------- Dashboard ausliefern ----------
 * Das Tablet öffnet nur die Adresse des Geräts und bekommt die komplette
 * Anzeige. Die Seite verbindet sich danach mit Port 81 auf derselben
 * Adresse – deshalb ist im Dashboard keine Einstellung nötig.
 *
 * Die Dateien liegen unkomprimiert im Flash (PROGMEM). Sie liessen sich auf
 * ein Drittel drücken, das kostete aber beim Ausliefern einen Puffer in
 * Größe des JS-Bundles im RAM – ohne PSRAM knapp. Flash ist hier reichlich
 * (App-Partition ~1,3 MB, Firmware ~580 kB), RAM nicht.
 *
 * Der HTTP-Stack liest PROGMEM selbst, deshalb kein Kopieren und kein
 * malloc: ausliefern ist ein Zeiger plus Länge.
 */
#if RUDER_HAS_DASHBOARD && DASHBOARD_AUSLIEFERN

/**
 * Kennung einer Datei für den Zwischenspeicher (ETag). Das Tablet fragt beim
 * Neuladen nur diese Kennung ab statt aller Dateien. Wichtig, weil das
 * Dashboard aus einem Dutzend Teilen besteht und der ESP32 schmal ist.
 */
String etagFuer(const EingebetteteDatei *datei) {
  return String(datei->pfad) + String("-") + String(kDashboardStand);
}

/** Datei im eingebetteten Satz suchen (Pfad ohne fuehrenden Schraegstrich). */
const EingebetteteDatei *findeDatei(const String &pfad) {
  for (size_t i = 0; i < kDashboardDateiAnzahl; i++) {
    if (pfad == kDashboardDateien[i].pfad) return &kDashboardDateien[i];
  }
  return nullptr;
}

/**
 * Eine Datei ausliefern. Rueckgabe false = Pfad unbekannt; es wurde nichts
 * gesendet.
 */
bool sendeDatei(const EingebetteteDatei *datei) {
  // Unveraendert? Dann nur "304 Nicht geaendert" und keine Daten.
  const String kennung = gHttp.header("If-None-Match");
  if (kennung.length() > 0 && kennung == etagFuer(datei)) {
    gHttp.sendHeader("ETag", etagFuer(datei));
    gHttp.send(304, datei->typ, "");
    return true;
  }

  gHttp.sendHeader("ETag", etagFuer(datei));
  // no-cache heisst nicht "nicht speichern", sondern "jedes Mal fragen" –
  // mit dem ETag ist die Antwort dann meist ein kurzes 304.
  gHttp.sendHeader("Cache-Control", "no-cache");
  gHttp.setContentLength(datei->laenge);
  gHttp.send_P(200, datei->typ, reinterpret_cast<PGM_P>(datei->daten), datei->laenge);
  return true;
}

/**
 * Datei anhand des angefragten Pfads ausliefern.
 * Rueckgabe false = Pfad unbekannt (dann 404 oder Diagnoseseite).
 */
bool sendeDashboard(const String &pfad) {
  String name = pfad;
  if (name.startsWith("/")) name = name.substring(1);
  const int frage = name.indexOf('?');
  if (frage >= 0) name = name.substring(0, frage);
  if (name.length() == 0) name = "index.html";

  const EingebetteteDatei *datei = findeDatei(name);
  if (datei == nullptr) return false;
  return sendeDatei(datei);
}

#else  // kein eingebettetes Dashboard (Header fehlt oder abgeschaltet)

bool sendeDashboard(const String &) { return false; }

#endif  // RUDER_HAS_DASHBOARD && DASHBOARD_AUSLIEFERN

void startOta() {
#if OTA_ENABLED
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() { Serial.println("# OTA: Update startet"); });
  ArduinoOTA.onEnd([]() { Serial.println("\n# OTA: fertig"); });
  ArduinoOTA.onError([](ota_error_t error) { Serial.printf("# OTA-Fehler %u\n", error); });
  ArduinoOTA.begin();
#endif
}

void sendeStatusSeite() {
  const ruder::PulseStats stats = statsSnapshot();
  const float rate = stats.minPeriodUs > 0 && stats.minPeriodUs != UINT32_MAX
                         ? 1000000.0F / static_cast<float>(stats.minPeriodUs)
                         : 0.0F;
  String html = F("<!doctype html><meta charset=utf-8><title>Ruder-Sensor</title>");
  html += F("<meta name=viewport content='width=device-width,initial-scale=1'>");
  html += F("<style>body{font:16px system-ui;background:#082543;color:#f4f7fa;padding:24px}");
  html += F("h1{color:#b5e900;font-size:1.1rem;letter-spacing:.1em;text-transform:uppercase}");
  html += F("td{padding:5px 18px 5px 0}td:first-child{color:#9fb3c8}");
  html += F("a{color:#b5e900}small{color:#9fb3c8;line-height:1.6}</style>");
  html += F("<h1>Ruder-Sensor – Diagnose</h1><table>");
  html += "<tr><td>IP</td><td>" + WiFi.localIP().toString() + "</td></tr>";
  html += "<tr><td>WLAN</td><td>" + String(WiFi.RSSI()) + " dBm</td></tr>";
  html += "<tr><td>Dashboards</td><td>" + String(gWebSocket.connectedClients()) + "</td></tr>";
  html += "<tr><td>Impulse gesamt</td><td>" + String(stats.accepted) + "</td></tr>";
  html += "<tr><td>Prellen verworfen</td><td>" + String(stats.bounced) + "</td></tr>";
  html += "<tr><td>Puffer verworfen</td><td>" + String(stats.dropped) + "</td></tr>";
  html += "<tr><td>Kürzester Abstand</td><td>" + String(stats.minPeriodUs / 1000.0F) + " ms</td></tr>";
  html += "<tr><td>Max. Impulse/s</td><td>" + String(rate, 1) + "</td></tr>";
  html += "<tr><td>Laufzeit</td><td>" + String(millis() / 1000) + " s</td></tr>";
  html += "<tr><td>Freier Speicher</td><td>" + String(ESP.getFreeHeap()) + " Byte</td></tr>";
  html += F("</table><p><small>Anzeige: <a href=\"/\">http://");
  html += WiFi.localIP().toString();
  html += F("/</a><br>WebSocket: ws://");
  html += WiFi.localIP().toString() + ":" + String(WS_PORT) + F("/<br>");
  html += F("Am Tablet einfach <b>ruder-sensor.local</b> eintippen.</small></p>");
  gHttp.send(200, "text/html; charset=utf-8", html);
}

void setupHttp() {
  gHttp.on("/", HTTP_GET, []() { sendeDashboard("/index.html"); });
  gHttp.on("/index.html", HTTP_GET, []() { sendeDashboard("/index.html"); });
  gHttp.onNotFound([]() {
    const String pfad = gHttp.uri();
    if (pfad == "/status" || pfad == "/diagnose") {
      sendeStatusSeite();
      return;
    }
    if (sendeDashboard(pfad)) return;
    gHttp.send(404, "text/plain; charset=utf-8", "nicht gefunden");
  });
  gHttp.begin();
}

void startSetupMode() {
  gSetupMode = true;
  WiFi.mode(WIFI_AP);
  const String apName = String("ruder-sensor-setup");
  WiFi.softAP(apName.c_str());
  Serial.println();
  Serial.println("# ===== EINRICHTUNGSMODUS =====");
  Serial.printf("# WLAN \"%s\" öffnen (kein Passwort)\n", apName.c_str());
  Serial.printf("# Danach http://%s/ aufrufen\n", WiFi.softAPIP().toString().c_str());
  Serial.println("# =============================");

  gHttp.on("/", HTTP_GET, []() {
    String html = F("<!doctype html><meta charset=utf-8><title>Ruder-Sensor einrichten</title>");
    html += F("<meta name=viewport content='width=device-width,initial-scale=1'>");
    html += F("<style>body{font:16px system-ui;background:#082543;color:#f4f7fa;padding:24px;max-width:520px;margin:auto}");
    html += F("h1{color:#b5e900;font-size:1.1rem;letter-spacing:.1em;text-transform:uppercase}");
    html += F("label{display:block;margin:16px 0 6px;color:#9fb3c8;font-size:.8rem;letter-spacing:.1em;text-transform:uppercase}");
    html += F("input{width:100%;padding:11px;border-radius:8px;border:1px solid #1d4a76;background:#0d2f52;color:#f4f7fa;font-size:1rem}");
    html += F("button{margin-top:20px;width:100%;padding:14px;border:0;border-radius:8px;background:#b5e900;color:#04172a;font-weight:700;font-size:1rem}");
    html += F("small{color:#9fb3c8;display:block;margin-top:14px;line-height:1.5}</style>");
    html += F("<h1>Ruder-Sensor einrichten</h1><form method=post action=/save>");
    html += F("<label>WLAN-Name (2,4 GHz)</label><input name=ssid required maxlength=32>");
    html += F("<label>Passwort</label><input name=pass type=password maxlength=64>");
    html += F("<button type=submit>Speichern und neu starten</button></form>");
    html += F("<small>Der ESP32 kann nur 2,4-GHz-Netze. Nach dem Speichern startet das Gerät neu und meldet sich als ");
    html += F("ruder-sensor.local.</small>");
    gHttp.send(200, "text/html; charset=utf-8", html);
  });

  gHttp.on("/save", HTTP_POST, []() {
    const String ssid = gHttp.arg("ssid");
    const String password = gHttp.arg("pass");
    if (ssid.length() == 0) {
      gHttp.send(400, "text/plain; charset=utf-8", "WLAN-Name fehlt");
      return;
    }
    saveWifi(ssid, password);
    String html = F("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>");
    html += F("<body style='font:16px system-ui;background:#082543;color:#f4f7fa;padding:24px'>");
    html += F("<h1 style='color:#b5e900'>Gespeichert</h1><p>Das Gerät startet neu und verbindet mit ");
    html += htmlEscape(ssid);
    html += F(".</p><p>Danach: <code>http://ruder-sensor.local/</code></p></body>");
    gHttp.send(200, "text/html; charset=utf-8", html);
    Serial.printf("# WLAN-Zugangsdaten für \"%s\" gespeichert, Neustart\n", ssid.c_str());
    delay(1200);
    ESP.restart();
  });

  gHttp.begin();
}

void reportStatus() {
  static uint32_t lastReport = 0;
  static uint32_t lastAccepted = 0;
  const uint32_t now = millis();
  if (now - lastReport < STATUS_INTERVAL_MS) return;

  const uint32_t accepted = statsSnapshot().accepted;
  const float perSecond = (accepted - lastAccepted) * 1000.0F / static_cast<float>(now - lastReport);
  lastAccepted = accepted;
  lastReport = now;

  char line[64];
  snprintf(line, sizeof(line), "S,%d,%u,%.1f\n", WiFi.RSSI(), gWebSocket.connectedClients(),
           static_cast<double>(perSecond));
  sendLine(line);
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(150);
  Serial.println();
  Serial.println("# physio & fit – Ruder-Sensor");

  // Zufällige Bootkennung: das Dashboard erkennt daran einen Neustart und
  // setzt seine Uhrschätzung zurück, statt mit falscher Zeitachse zu rechnen.
  gBootId = esp_random() & 0xFFFF;
  Serial.printf("# Startgrund %d, Bootkennung %lu\n", static_cast<int>(esp_reset_reason()),
                static_cast<unsigned long>(gBootId));

  pinMode(SENSOR_PIN, SENSOR_USE_INTERNAL_PULLUP ? INPUT_PULLUP : INPUT);
  attachInterrupt(digitalPinToInterrupt(SENSOR_PIN), onSensorPulse,
                  SENSOR_TRIGGER_RISING ? RISING : FALLING);

  loadSavedWifi();

  // Ohne Zugangsdaten (frisch geflashte .bin, CI-Build) in den
  // Einrichtungsmodus. Gespeicherte Zugangsdaten haben Vorrang vor der
  // config.h, damit ein Gerät im Feld per Weboberfläche umziehen kann.
  const bool haveCredentials = activeSsid().length() > 0;
  if (!haveCredentials) {
    startSetupMode();
    return;
  }

  if (!connectWifi()) {
    // Zugangsdaten vorhanden, aber Netz weg: Einrichtung erneut anbieten,
    // statt das Gerät in einer Neustartschleife zu lassen.
    Serial.println("# Einrichtungsmodus startet – Netz prüfen und neu eingeben.");
    startSetupMode();
    return;
  }

  startMdns();
  setupHttp();
  startOta();

  gWebSocket.begin();
  gWebSocket.onEvent(handleSocketEvent);
  gWebSocket.enableHeartbeat(15000, 3000, 2);

  Serial.printf("# WebSocket bereit auf Port %d\n", WS_PORT);
  Serial.printf("# Diagnose: http://%s/\n", WiFi.localIP().toString().c_str());
}

void loop() {
  if (gSetupMode) {
    gHttp.handleClient();
    delay(2);
    return;
  }

  gWebSocket.loop();
  gHttp.handleClient();
#if OTA_ENABLED
  ArduinoOTA.handle();
#endif

  // Impulse gesammelt verschicken: eine Nachricht pro 12 Impulse spart
  // Funkzeit. Der Zeitstempel bleibt der des Interrupts.
  ruder::TimedPulse batch[WS_SEND_BATCH];
  const size_t count = drainPulses(batch, WS_SEND_BATCH);
  if (count > 0) {
    String payload;
    payload.reserve(count * 14);
    for (size_t i = 0; i < count; i++) {
      payload += 'P';
      payload += ',';
      payload += String(batch[i].millis);
      payload += '\n';
    }
    sendLine(payload);
  }

  reportStatus();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("# WLAN verloren – verbinde neu");
    WiFi.disconnect();
    if (!connectWifi()) {
      Serial.println("# Kein Netz – Einrichtungsmodus startet nach Neustart");
      ESP.restart();
    }
  }

  // Kurz schlafen: gibt dem WLAN-Stack Zeit, ohne die Latenz zu erhöhen.
  delay(2);
}
