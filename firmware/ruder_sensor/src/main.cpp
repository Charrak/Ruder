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
#include <ESPmDNS.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <WiFi.h>
#include <esp_timer.h>

#include "config.h"
#include "pulse_filter.h"

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
  gWebSocket.broadcastTXT(line);
}

void announceToClient(uint8_t client) {
  char greeting[48];
  snprintf(greeting, sizeof(greeting), "B,%lu,%lu\n", static_cast<unsigned long>(gBootId),
           static_cast<unsigned long>(millis()));
  gWebSocket.sendTXT(client, greeting);
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
        gWebSocket.sendTXT(client, diag);
      }
      break;
    }

    default:
      break;
  }
}

void connectWifi() {
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
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("# WLAN verbinden");
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
    if (millis() - start > 30000) {
      Serial.println();
      Serial.println("# WLAN nicht erreichbar.");
      Serial.println("# Prüfen: include/config.h (SSID/Passwort), 2,4-GHz-Netz.");
      Serial.println("# Das Gerät startet in 10 s neu und versucht es erneut.");
      delay(10000);
      ESP.restart();
    }
  }
  Serial.printf("\n# WLAN verbunden: %s (Kanal %d, %d dBm)\n", WiFi.localIP().toString().c_str(),
                WiFi.channel(), WiFi.RSSI());
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

/**
 * Diagnoseseite für die Werkbank: genau die Zahlen, die man beim
 * Ausrichten des Magneten braucht.
 */
void setupHttp() {
  gHttp.on("/", HTTP_GET, []() {
    const ruder::PulseStats stats = statsSnapshot();
    const float rate = stats.minPeriodUs > 0 && stats.minPeriodUs != UINT32_MAX
                           ? 1000000.0F / static_cast<float>(stats.minPeriodUs)
                           : 0.0F;
    String html = F("<!doctype html><meta charset=utf-8><title>Ruder-Sensor</title>");
    html += F("<meta name=viewport content='width=device-width,initial-scale=1'>");
    html += F("<style>body{font:16px system-ui;background:#082543;color:#f4f7fa;padding:24px}");
    html += F("h1{color:#b5e900;font-size:1.1rem;letter-spacing:.1em;text-transform:uppercase}");
    html += F("td{padding:5px 18px 5px 0}td:first-child{color:#9fb3c8}");
    html += F("small{color:#9fb3c8}</style>");
    html += F("<h1>Ruder-Sensor</h1><table>");
    html += "<tr><td>IP</td><td>" + WiFi.localIP().toString() + "</td></tr>";
    html += "<tr><td>WLAN</td><td>" + String(WiFi.RSSI()) + " dBm</td></tr>";
    html += "<tr><td>Dashboards</td><td>" + String(gWebSocket.connectedClients()) + "</td></tr>";
    html += "<tr><td>Impulse gesamt</td><td>" + String(stats.accepted) + "</td></tr>";
    html += "<tr><td>Prellen verworfen</td><td>" + String(stats.bounced) + "</td></tr>";
    html += "<tr><td>Puffer verworfen</td><td>" + String(stats.dropped) + "</td></tr>";
    html += "<tr><td>Kürzester Abstand</td><td>" + String(stats.minPeriodUs / 1000.0F) + " ms</td></tr>";
    html += "<tr><td>Max. Impulse/s</td><td>" + String(rate, 1) + "</td></tr>";
    html += "<tr><td>Laufzeit</td><td>" + String(millis() / 1000) + " s</td></tr>";
    html += F("</table><p><small>WebSocket: ws://");
    html += WiFi.localIP().toString() + ":" + String(WS_PORT) + F("/<br>");
    html += F("Dashboard im Studio: Adresse dort unter Einstellungen eintragen.</small></p>");
    gHttp.send(200, "text/html; charset=utf-8", html);
  });

  gHttp.onNotFound([]() { gHttp.send(404, "text/plain", "nicht gefunden"); });
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

  connectWifi();
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
    connectWifi();
  }

  // Kurz schlafen: gibt dem WLAN-Stack Zeit, ohne die Latenz zu erhöhen.
  delay(2);
}
