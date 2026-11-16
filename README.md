# Ruder – Live-Dashboard für das physio & fit VitalZentrum Eschweiler

Ein Dashboard fürs Ruderergometer, das im Studio auf einem Tablet oder
Fernseher läuft: Split, Leistung, Schlagzahl, Strecke, Herzfrequenz und
Splits – in der Marke von **physio & fit VitalZentrum Eschweiler**.

Zugeschnitten auf einen **Concept2 Model C ohne USB**. Das alte PM2/PM3 hat
keine Datenschnittstelle, deshalb kommen die Messwerte aus einem ESP32, der
die Magnetimpulse des Schwungrads abgreift. Die Firmware liegt mit im
Repository. Ohne Hardware läuft alles im **Demo-Modus**.

## Schnellstart

```bash
npm install
npm run dev        # http://localhost:5173
```

Drei Wege, das Dashboard zu füttern:

| Modus | Aufwand | Wofür |
| --- | --- | --- |
| **Demo** | keiner | Anzeige ansehen, Schulung, Entwicklung |
| **ESP32 im WLAN** | Sensor + Firmware | der Betrieb im Studio |
| **ESP32 per USB** | Kabel | Werkbank, erstes Ausprobieren |

Für den WLAN-Weg ohne Hardware lässt sich der Sensor simulieren:

```bash
npm run emulator                                  # ws://localhost:8081/
node tools/device-emulator.mjs --spm 32 --pace 104
```

Danach im Dashboard unter Einstellungen `localhost:8081` eintragen.

## Befehle

| Befehl | Zweck |
| --- | --- |
| `npm run dev` | Entwicklungsserver, im ganzen WLAN erreichbar |
| `npm run build` | Typprüfung + Produktions-Build nach `dist/` |
| `npm run preview` | gebauten Stand ausliefern |
| `npm test` | 70 Tests (Physik, Protokoll, Wiederverbinden, UI, Integration) |
| `npm run emulator` | ESP32-Sensor simulieren |
| `cd firmware && make test` | Firmware-Logik auf dem Rechner testen |
| `cd firmware && make check-syntax` | `main.cpp` gegen Arduino-Stubs prüfen |
| `cd firmware/ruder_sensor && pio run -t upload` | Firmware selbst bauen und flashen |
| `python3 tools/check-workflow.py` | CI-Workflow vorab prüfen (Action-Versionen, Job-IDs) |

Für ein **Model C mit PM3** liegt eine vorbereitete Vorlage bereit:

```bash
cd firmware/ruder_sensor
cp include/config.model-c-pm3.h include/config.h   # dann Passwörter eintragen
```

Das PM3 bleibt dabei am Gerät und wird nicht angefasst; der Sensor kommt als
zweite Quelle an den Rahmen. Details und das Einmessen der Strecke gegen das
PM3 stehen in [docs/inbetriebnahme.md](docs/inbetriebnahme.md).

## Was es kann

- **Split / 500 m** als große Kennzahl, mit Prognose für Distanz- und
  Zeittrainings.
- **Leistung, Schlagzahl, Strecke, Zeit, Herzfrequenz** mit Trainingszone.
- **Splits** im 500-m-Raster inkl. Differenz zum vorherigen Abschnitt.
- **Tempo-Verlauf** der letzten 5 Minuten.
- **Zieltrainings** von 500 m bis 10 km oder 1–30 Minuten.
- **Zusammenfassung** am Trainingsende (Ø-Split, Ø-Leistung, Ø-HF, kcal).
- **Brustgurt** über Web Bluetooth (Garmin HRM, Polar H10, Wahoo TICKR …).
- **Kiosk-Modus** (`?kiosk=1`) für den Dauerbetrieb am Tablet.
- **Selbstheilende Verbindung**: WLAN-Abriss, Sensor-Neustart und stille
  Verbindungen werden erkannt, die Anzeige verbindet selbst neu.

## Fertige Firmware (.bin) ohne Entwicklungsumgebung

Die CI baut bei jedem Lauf auf `main` und bei jedem Tag `v*` flashfertige
Dateien — **Actions → Firmware ESP32 → Artifacts**. Bei Tags landen sie
zusätzlich in einem Release. Im Paket:

| Datei | Adresse |
| --- | --- |
| `ruder-sensor-esp32dev.bin` | `0x10000` |
| `ruder-sensor-esp32dev-bootloader.bin` | `0x1000` |
| `ruder-sensor-esp32dev-partitions.bin` | `0x8000` |
| `ruder-sensor-esp32dev-boot_app0.bin` | `0xe000` |
| `flashen.sh` / `flashen.bat` | fertige Befehle mit diesen Adressen |

```bash
pip install esptool
./flashen.sh /dev/ttyUSB0        # Windows: flashen.bat COM3
```

Die Dateien enthalten **kein WLAN**. Nach dem Flashen öffnet das Board das
WLAN `ruder-sensor-setup`; darüber wird das Studio-Netz eingetragen und im
NVS gespeichert — es überlebt weitere Updates. Details in
[docs/inbetriebnahme.md](docs/inbetriebnahme.md).

## Aufbau

```
src/
  core/engine.ts        Physik: Impulse -> Leistung, Split, Schlagzahl
  core/simulator.ts     Ruderzug-Modell für den Demo-Modus
  core/session.ts       Trainingszeit, Splits, Zielverfolgung
  core/controller.ts    Sensor -> Engine -> Oberfläche, Einstellungen
  core/format.ts        deutsche Zahlen- und Zeitformate
  input/protocol.ts     Zeilenprotokoll und Uhrabgleich
  input/sources.ts      Demo-, USB- und WLAN-Sensor (mit Wiederverbinden)
  input/heartRate.ts    Brustgurt (BLE Heart Rate Service) + Zonen
  ui/dashboard.ts       Aufbau und Aktualisierung der Anzeige
  styles.css            Design in den Markenfarben
firmware/ruder_sensor/  ESP32-Firmware (PlatformIO)
firmware/test/          Host-Test der Impulsverarbeitung
firmware/stubs/         Arduino-Stubs für die Syntaxprüfung ohne Toolchain
tools/check-workflow.py CI-Workflow vorab prüfen
.github/workflows/      CI: Firmware bauen, .bin als Artefakt, Release bei Tags
tools/device-emulator.mjs  Sensor ohne Hardware simulieren
docs/                   Protokoll, Hardware, Inbetriebnahme
public/brand/           Logo-Dateien aus dem Original-Logo abgeleitet
```

### Physik in einem Absatz

Der Sensor liefert nur Zeitstempel. Aus dem Abstand zweier Impulse folgt die
Winkelgeschwindigkeit ω des Schwungrads, daraus die Leistung `P = c·ω³` mit
`c = Drag-Faktor · 0,0014575` (kalibriert auf die Concept2-Kennlinie: bei
Drag-Faktor 120 entspricht 1:45,0/500 m rund 300 W). Die Geschwindigkeit
kommt aus einem gleitenden 6-Sekunden-Fenster über die Impulszahl pro Zeit –
bei wechselnder Drehzahl exakt, im Gegensatz zum Mittelwert der Abstände.
Ein Schlag beginnt dort, wo der Impulsabstand sein Minimum hat: höchste
Drehzahl des Schwungrads, also das Ende des Durchzugs.

## Dokumentation

- [docs/inbetriebnahme.md](docs/inbetriebnahme.md) – von der Montage bis
  zum Kiosk-Tablet, inklusive Fehlersuche.
- [docs/hardware.md](docs/hardware.md) – Sensorvarianten, Verdrahtung,
  Drag-Faktor-Tabelle.
- [docs/protocol.md](docs/protocol.md) – Zeilenformat zwischen Sensor und
  Dashboard.

## Grenzen

- **Web Serial und Web Bluetooth** brauchen Chrome oder Edge am Desktop und
  eine sichere Herkunft. Auf dem iPad läuft nur der WLAN-Weg.
- **Die Firmware ist hier nicht kompiliert** (die ESP32-Toolchain ließ sich
  in der Entwicklungsumgebung nicht laden). Die Impulsverarbeitung ist als
  Host-Test abgedeckt (`cd firmware && make test`), der Rest ist sorgfältig
  geschrieben, aber vor dem ersten Einsatz einmal `pio run` laufen lassen.
- **Kein TLS am Sensor.** Ein per `https` geladenes Dashboard darf keine
  `ws://`-Verbindung öffnen – das ist eine Browser-Regel. Für den
  Studiobetrieb deshalb über `http://` im lokalen Netz ausliefern.
- **Die Leistungskalibrierung** ist eine Concept2-Näherung, kein am Gerät
  gemessener Drag-Faktor. Wer es genauer braucht, misst den Nachlauf aus
  und zieht `DRAG_COEFF_PER_DF` in `src/core/engine.ts` nach.
