/**
 * Konfiguration für: Concept2 Model C mit PM2, Sensor-Nachrüstung am Schwungrad.
 *
 * Übernehmen:
 *   cp include/config.model-c-pm2.h include/config.h
 *   # config.h öffnen und Passwörter eintragen
 *
 * Warum diese Werte für das Model C mit PM2:
 *
 * - Das PM2 bleibt als eigene Anzeige am Gerät und wird NICHT elektrisch
 *   angefasst. Der Hall-Sensor kommt als zweiter Aufnehmer an den Rahmen,
 *   der Magnet auf das Schwungrad. Damit ist das PM2 weiter nutzbar, auch
 *   wenn der ESP32 aus ist.
 * - Der Rahmen des Model C ist offener als beim Model D: Kette und
 *   Schwungrad laufen frei, der Sensor sitzt mechanisch unruhiger. Die
 *   Entprellung ist deshalb bewusst nicht auf Anschlag gedreht, sondern
 *   auf dem Standardwert – bei Geisterimpulsen zuerst den Abstand des
 *   Magneten prüfen, dann DEBOUNCE_US erhöhen.
 * - Feste IP erleichtert den Dauerbetrieb: die Adresse steht einmal im
 *   Dashboard und bleibt gültig, auch wenn der Router neu startet.
 *
 * Streckenkalibrierung: Das Dashboard rechnet mit 2,5 m pro
 * Schwungradumdrehung (Richtwert aus der Community, nicht von Concept2
 * bestätigt). Gegenprobe: eine bekannte Strecke auf dem PM2 fahren und die
 * Meter im Dashboard ablesen. Bei Abweichung DISTANCE_PER_REV in
 * src/core/engine.ts nachziehen:
 *   2,5 * (PM2-Meter / Dashboard-Meter)
 *
 * Was das PM2 anzeigt – und was hier verglichen werden kann:
 *
 *   Anzeige                 Vergleich mit dem Dashboard
 *   Zeit                    identisch
 *   Schlagzahl (spm)        muss exakt übereinstimmen
 *   Split /500 m            stimmt bei passendem Drag-Faktor
 *   Watt                    PM2 zeigt die Leistung des letzten Schlags, das
 *                           Dashboard den gleitenden Mittelwert – kurz nach
 *                           dem Anfahren weichen sie deshalb ab
 *   Strecke (m)             Referenz für DISTANCE_PER_REV
 *   Kalorien                andere Formel, nicht vergleichbar
 *
 * Drag-Faktor: Das PM2 kann ihn anzeigen (READY halten → Display), das
 * Dashboard kennt ihn nur als Einstellung. Denselben Wert im Dashboard
 * eintragen – 120 ist ein üblicher Wert für ein sauberes Model C.
 *
 * Das PM2 hat keine Datenschnittstelle. Ein Umbau auf PM5 (USB/LogCard)
 * ist möglich, aber ein anderes Gerät – diese Firmware bleibt beim
 * Impuls-Weg und braucht kein PM-Upgrade.
 */
#pragma once

// ---------- WLAN ----------
// Leer lassen ("") = Einrichtungsmodus beim Start. Gespeicherte Zugangsdaten
// aus der Weboberfläche haben Vorrang vor diesen Werten.
#define WIFI_SSID "VitalZentrum"
#define WIFI_PASSWORD "hier-das-passwort"

// Feste IP im Studio-WLAN. Die Adresse im Router außerhalb des
// DHCP-Bereichs halten, sonst kollidiert sie irgendwann.
#define USE_STATIC_IP true
#define STATIC_IP "192.168.1.50"
#define STATIC_GATEWAY "192.168.1.1"
#define STATIC_SUBNET "255.255.255.0"
#define STATIC_DNS "192.168.1.1"

#define MDNS_HOSTNAME "ruder-sensor"

// ---------- Sensor ----------
// A3144/OH137 am Rahmen, 3–8 mm Abstand zum Magneten auf dem Schwungrad.
// GPIO 34-39 sind input-only ohne internen Pull-up: dort 10 kΩ nach 3V3.
#define SENSOR_PIN 27
#define SENSOR_USE_INTERNAL_PULLUP true
#define SENSOR_TRIGGER_RISING true

// 3 ms = bis 333 Impulse/s. Am Schwungrad sind bei 40 U/min und 6 Magneten
// etwa 4 Impulse/s zu erwarten; alles darüber ist Prellen oder Störung.
#define DEBOUNCE_US 3000

// 128 Impulse puffern: über eine Sekunde bei Höchstfrequenz. Ein kurzer
// WLAN-Hänger verschluckt damit keine Impulse.
#define PULSE_BUFFER_SIZE 128

// ---------- Netzwerk ----------
#define WS_PORT 81
#define HTTP_PORT 80
#define STATUS_INTERVAL_MS 5000
#define WS_SEND_BATCH 12
#define MAX_WS_CLIENTS 4

// ---------- Diagnose/Update ----------
// OTA per WLAN: praktisch im Studio, weil das Gerät am Rahmen verschraubt
// ist. Vor dem Einbau das Passwort ändern – das Standardpasswort steht im
// Repository.
#define OTA_ENABLED true
#define OTA_HOSTNAME "ruder-sensor"
#define OTA_PASSWORD "ruder-ota-aendern"

// Zeilen zusätzlich auf USB-Serial spiegeln (Werkbank, Fehlersuche).
#define SERIAL_MIRROR true
