/**
 * Konfiguration – als include/config.h kopieren und anpassen.
 *
 *   cp include/config.example.h include/config.h
 *
 * config.h steht in .gitignore, damit Zugangsdaten nicht im Repository landen.
 */
#pragma once

// ---------- WLAN ----------
#define WIFI_SSID "VitalZentrum"
#define WIFI_PASSWORD "geheim"

// Optional: feste IP im Studio-WLAN (schnellerer Verbindungsaufbau,
// stabilere Erreichbarkeit als DHCP). Sonst 0.0.0.0 eintragen.
#define USE_STATIC_IP false
#define STATIC_IP "192.168.1.50"
#define STATIC_GATEWAY "192.168.1.1"
#define STATIC_SUBNET "255.255.255.0"
#define STATIC_DNS "192.168.1.1"

// Name im Netz: erreichbar als ruder-sensor.local
#define MDNS_HOSTNAME "ruder-sensor"

// ---------- Sensor ----------
// GPIO des Hall-Sensors / Reed-Kontakts. GPIO 34-39 sind input-only und
// haben keinen internen Pull-up – dort einen externen 10 kΩ nach 3V3 setzen.
#define SENSOR_PIN 27
#define SENSOR_USE_INTERNAL_PULLUP true
#define SENSOR_TRIGGER_RISING true

// Entprellzeit: Impulse dichter als das sind Prellen/Rauschen.
// 3 ms erlaubt theoretisch 333 Impulse/s – weit mehr als am Schwungrad möglich.
#define DEBOUNCE_US 3000

// Ringpuffer im Speicher; 128 Impulse reichen für über eine Sekunde
// Höchstfrequenz, auch wenn das WLAN kurz hakt.
#define PULSE_BUFFER_SIZE 128

// ---------- Netzwerk ----------
#define WS_PORT 81
#define HTTP_PORT 80
#define STATUS_INTERVAL_MS 5000
#define WS_SEND_BATCH 12       // Impulse pro WebSocket-Nachricht
#define MAX_WS_CLIENTS 4

// ---------- Diagnose/Update ----------
// OTA passwortgeschützt; Passwort ändern, bevor das Gerät ins Studio geht.
#define OTA_ENABLED true
#define OTA_HOSTNAME "ruder-sensor"
#define OTA_PASSWORD "ruder-ota"

// Spiegelt alle Zeilen zusätzlich auf USB-Serial (für die Werkbank).
#define SERIAL_MIRROR true
