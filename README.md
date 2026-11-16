# Ruder – Live-Dashboard für das physio & fit VitalZentrum Eschweiler

Ein Dashboard fürs Ruderergometer, das im Studio auf einem Tablet oder
Fernseher läuft: Split, Leistung, Schlagzahl, Strecke, Herzfrequenz und
Splits – in der Marke von **physio & fit VitalZentrum Eschweiler**.

Das Dashboard ist auf einen **Concept2 Model C ohne USB-Anschluss**
zugeschnitten. Das alte PM2/PM3 hat keine Datenschnittstelle, deshalb
kommen die Messwerte aus einem kleinen ESP32, der die Magnetimpulse des
Schwungrads abgreift (siehe [docs/hardware.md](docs/hardware.md)).
Ohne Hardware läuft das Dashboard im **Demo-Modus** mit einem physikalisch
modellierten Ruderzug.

## Schnellstart

```bash
npm install
npm run dev        # http://localhost:5173
```

| Befehl | Zweck |
| --- | --- |
| `npm run dev` | Entwicklungsserver (erreichbar im ganzen WLAN) |
| `npm run build` | Typprüfung + Produktions-Build nach `dist/` |
| `npm run preview` | gebauten Stand lokal ausliefern |
| `npm test` | 46 Tests (Physik, Formatierung, Sensorprotokoll, UI, Pause, Integration) |
| `npm run typecheck` | nur TypeScript |

Im Dashboard: **Start** (oder Leertaste), **R** setzt zurück. Über das
Zahnrad kommen Sensorwahl, Drag-Faktor, Zieltraining und der Brustgurt.

## Was das Dashboard kann

- **Split / 500 m** als große Kennzahl, mit Live-Prognose für Distanz- und
  Zeittrainings.
- **Leistung, Schlagzahl, Strecke, Zeit, Herzfrequenz** inkl. Trainingszone.
- **Splits** im 500-m-Raster mit Differenz zum vorherigen Abschnitt
  (grün = schneller, rot = langsamer).
- **Tempo-Verlauf** der letzten 5 Minuten.
- **Zieltrainings**: 500 m bis 10 km oder 1–30 Minuten, mit Fortschritt
  und Prognose.
- **Zusammenfassung** am Trainingsende (Ø-Split, Ø-Leistung, Ø-HF, kcal).
- **Brustgurt** über Web Bluetooth (Garmin HRM, Polar H10, Wahoo TICKR …).

## Aufbau

```
src/
  core/engine.ts        Physik: Impulse -> Leistung, Split, Schlagzahl
  core/simulator.ts     Ruderzug-Modell für den Demo-Modus
  core/session.ts       Trainingszeit, Splits, Zielverfolgung
  core/controller.ts    verbindet Sensor -> Engine -> Oberfläche
  core/format.ts        deutsche Zahlen- und Zeitformate
  input/sources.ts      Demo-, Web-Serial- und WebSocket-Sensor
  input/heartRate.ts    Brustgurt (BLE Heart Rate Service) + Zonen
  ui/dashboard.ts       Aufbau und Aktualisierung der Anzeige
  styles.css            Design in den Markenfarben
public/brand/           Logo-Dateien aus dem Original-Logo abgeleitet
docs/hardware.md        ESP32 am Model C: Aufnehmer, Verdrahtung, Firmware
```

### Physik in einem Absatz

Der Sensor liefert nur Zeitstempel. Aus dem Abstand zweier Impulse folgt
die Winkelgeschwindigkeit ω des Schwungrads, daraus die Leistung
`P = c·ω³` mit `c = Drag-Faktor · 0,0014575` (so kalibriert, dass Drag-Faktor
120 bei 1:45,0/500 m rund 300 W ergibt, wie bei Concept2). Die
Geschwindigkeit wird über ein gleitendes 6-Sekunden-Fenster aus Impulsen
pro Zeiteinheit gerechnet – bei veränderlicher Drehzahl ist das exakt und
nicht durch die Stichprobenverteilung der Abstände verzerrt. Ein Schlag
beginnt dort, wo der Impulsabstand sein Minimum hat: höchste
Schwungrad-Drehzahl, also Ende des Durchzugs.

## Grenzen

- **Web Serial und Web Bluetooth brauchen Chrome oder Edge am Desktop**
  und eine sichere Herkunft (`https://` oder `localhost`). Auf dem iPad
  läuft nur der Demo-Modus bzw. der WLAN-Sensor.
- Der **WLAN-Weg ist noch nicht gebaut**: `WebSocketSensor` spricht das
  Protokoll, eine passende Firmware-Seite fehlt aber noch.
- Die Kalibrierung ist eine Concept2-Näherung, kein am Gerät gemessener
  Drag-Faktor. Wer es genauer braucht, misst den Nachlauf aus und setzt
  `DRAG_COEFF_PER_DF` in `src/core/engine.ts` neu.
