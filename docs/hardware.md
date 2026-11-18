# Hardware: Concept2 Model C ohne USB am ESP32

Das Model C (ab 1993) wurde mit dem **PM2** ausgeliefert – ohne
Datenschnittstelle, ohne USB, ohne Aufzeichnung. Später wurden viele Geräte
auf PM3 oder PM5 umgerüstet. Statt den Monitor zu ersetzen, greift man die
Drehung des Schwungrads ab und rechnet alles im Dashboard. Dieses Dokument
beschreibt den Weg vom Magneten bis zur Anzeige.

Für diese Firmware ist der Unterschied zwischen PM2 und PM3/PM5 unerheblich:
in beiden Fällen kommt kein Signal aus dem Monitor, sondern vom eigenen
Sensor am Schwungrad.

## 1. Signal abnehmen

Drei erprobte Varianten, von einfach nach sauber:

| Variante | Aufwand | Auflösung | Bemerkung |
| --- | --- | --- | --- |
| **Reed-Kontakt** am Schwungrad | gering | 1 Impuls/Umdrehung | prellt, mechanisch verschleißt |
| **Hall-Sensor** (z. B. A3144, OH137) + Magnet | gering | 1–6 Impulse/Umdrehung | Standard in der Ruder-Community |
| **Optisch** (Reflexlichtschranke TCRT5000) | mittel | bis 18 Impulse/Umdrehung | braucht saubere Blende, staubempfindlich |

Für ein brauchbares Tempo-Messergebnis reichen **6 Impulse pro
Schwungradumdrehung** (alle 60° ein Magnet). Das Dashboard rechnet mit
`PULSES_PER_REV = 6` und `DISTANCE_PER_REV = 2.5 m`; beides ist in
`src/core/engine.ts` änderbar.

!!! warning "Nicht in die Elektronik des PM eingreifen"
    Der Sensor wird **parallel** montiert, nicht am PM2 angeschlossen.
    Der Monitor bleibt funktionsfähig, das Dashboard ist eine Zusatzanzeige.

## 2. Verdrahtung

Beispiel mit ESP32-DevKit und Hall-Sensor A3144 (Open-Collector, braucht
einen Pull-up):

```
A3144 VCC   -> 3V3
A3144 GND   -> GND
A3144 OUT   -> GPIO 27   (10 kΩ nach 3V3, interner Pull-up reicht meist)
```

Der Sensor sieht einen Magneten pro 60°-Schritt am Schwungrad. Abstand
Magnet–Sensor 3–8 mm. Wichtig: Der Sensor muss **fest am Rahmen** sitzen,
der Magnet **auf dem Schwungrad** – sonst misst man den Fahrer, nicht das
Gerät.

Optionale Ergänzungen:

- **Taster** an GPIO 32: Start/Pause direkt am Gerät.
- **OLED** (SSD1306, I²C): zeigt Impulsrate und WLAN-Status vor Ort.
- **Brustgurt**: nicht am ESP32 nötig, das Dashboard verbindet sich per
  Web Bluetooth direkt mit dem Gurt.

## 3. Firmware (Minimalfassung)

Der ESP32 schickt nichts als Impulszeilen. Das Dashboard akzeptiert
`I` (Impuls jetzt) oder `P,<ms>` (Impuls mit Gerätezeit) über USB-Serial
oder WebSocket.

```cpp
#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsServer.h>

constexpr uint8_t kSensorPin = 27;
constexpr bool kSendDeviceTime = false;   // true -> "P,<ms>" statt "I"

WebSocketsServer ws(81);
volatile uint32_t gPulses = 0;
portMUX_TYPE gMux = portMUX_INITIALIZER_UNLOCKED;

void IRAM_ATTR onPulse() {
  portENTER_CRITICAL_ISR(&gMux);
  gPulses++;
  portEXIT_CRITICAL_ISR(&gMux);
}

void setup() {
  Serial.begin(115200);
  pinMode(kSensorPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(kSensorPin), onPulse, RISING);

  WiFi.begin("SSID", "PASSWORT");
  while (WiFi.status() != WL_CONNECTED) delay(200);
  ws.begin();
  ws.onEvent([](uint8_t client, WStype_t type, uint8_t*, size_t) {
    if (type == WStype_CONNECTED) {
      ws.sendTXT(client, "ready\n");   // Dashboard ignoriert unbekannte Zeilen
    }
  });
}

void loop() {
  ws.loop();

  static uint32_t lastSeen = 0;
  uint32_t seen;
  portENTER_CRITICAL(&gMux);
  seen = gPulses;
  portEXIT_CRITICAL(&gMux);

  if (seen != lastSeen) {
    lastSeen = seen;
    char line[24];
    if (kSendDeviceTime) snprintf(line, sizeof(line), "P,%lu\n", (unsigned long)millis());
    else snprintf(line, sizeof(line), "I\n");
    Serial.print(line);
    ws.broadcastTXT(line);
  }
  delay(1);
}
```

Zwei Dinge sind hier bewusst einfach gehalten:

1. **Entprellung fehlt.** Prellen erzeugt Impulse im Abstand von
   Mikrosekunden. Das Dashboard verwirft alles unter 20 ms
   (`MIN_PERIOD_MS`), aber sauberer ist ein RC-Glied (10 kΩ / 100 nF) am
   Sensoreingang.
2. **Kein Zeitstempel im WLAN-Modus.** `I` lässt das Dashboard die
   Empfangszeit nehmen; bei gleichmäßigem WLAN ist das genau genug. Wer
   es exakter will, setzt `kSendDeviceTime = true`, dann liefert der ESP32
   `millis()`. Die Umrechnung auf die Browser-Zeitachse ist in
   `parseSerialLine()` bewusst konservativ (siehe Grenzen unten).

## 4. Drag-Faktor bestimmen

Der Drag-Faktor ersetzt beim Model C die fehlende PM-Kalibrierung. Er
hängt von der Luftklappe ab:

| Klappe | Drag-Faktor (Richtwert) |
| --- | --- |
| 1 (leicht) | 100–110 |
| 3 | 120–130 |
| 5 | 145–160 |
| 10 (schwer) | 190–210 |

Einstellen im Dashboard unter **Einstellungen → Drag-Faktor**. Wer es
genau wissen will, macht den Nachlauf-Test: Schwungrad auf eine bekannte
Drehzahl bringen, abbremsen lassen und aus dem Abklingen von ω den
Widerstandsbeiwert bestimmen; `DRAG_COEFF_PER_DF` in
`src/core/engine.ts` entsprechend nachziehen.

## 5. Grenzen des Aufbaus

- **Web Serial** funktioniert nur in Chrome/Edge am Desktop und nur über
  `https://` oder `localhost`.
- **Web Bluetooth** (Brustgurt) ebenso; auf iPad/Safari nicht verfügbar.
- Der `WebSocketSensor` ist implementiert, aber die Firmware-Seite oben
  ist ein Beispiel, kein gehärteter Code. Für den Studiobetrieb fehlen
  Reconnect-Logik, Authentifizierung und ein fester Hostname
  (z. B. `ruder.local` per mDNS).
- Die Gerätezeit-Umrechnung (`toHostClock`) ist eine Näherung und für
  lange Einheiten nicht empfohlen; im Zweifel `I` senden.
