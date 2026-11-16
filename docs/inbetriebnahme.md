# Inbetriebnahme im Studio

Diese Anleitung führt von der Hardware bis zum laufenden Dashboard am
Tablet. Rechenzeit: etwa eine Stunde, davon die meiste Zeit für das
Ausrichten des Sensors.

## 1. Sensor am Model C montieren

Der Sensor sitzt **fest am Rahmen**, der Magnet **auf dem Schwungrad**.
Sonst misst man den Fahrer, nicht das Gerät.

1. Schwungrad von Hand drehen und eine Stelle suchen, an der 6 Magnete
   (alle 60°) ohne Kollision am Rahmen vorbeikommen.
2. Hall-Sensor (A3144/OH137) mit 3–8 mm Abstand montieren – stabil, nicht
   geklebt-und-gehofft. Ein 3D-Druck-Halter oder ein Aluwinkel mit
   Kabelbinder ist besser als Heißkleber.
3. Kabel geschützt verlegen: am Rahmen entlang, weg vom Kettenspanner und
   von beweglichen Teilen.

Verdrahtung und Alternativen (Reed, Lichtschranke): [hardware.md](hardware.md).

### Das PM3 bleibt am Gerät

Das PM3 wird **nicht** ausgebaut und **nicht** elektrisch angefasst. Es
zeigt weiter Split, Schlagzahl und Kalorien an – der ESP32 ist eine zweite
Quelle, keine Ersatzschaltung. Das hat zwei Vorteile: Wer ohne Dashboard
rudert, sieht trotzdem seine Werte, und ein Ausfall des Sensors kostet
nicht das ganze Training.

Das PM3 taugt außerdem als Referenz zum Einmessen:

| Anzeige | Vergleich | Was daraus folgt |
| --- | --- | --- |
| Strecke | 1.000 m laut PM3 vs. Dashboard | Streckenfaktor nachziehen, siehe unten |
| Split | gleiche Einheit auf beiden | weicht er konstant ab: Drag-Faktor im Dashboard |
| Schlagzahl | muss übereinstimmen | weicht sie ab: Magnete/Entprellung prüfen |

Die Watt-Anzeige des PM3 ist eine **Ableitung** aus der Bremsleistung, keine
Messung. Kleine Unterschiede zum Dashboard sind normal und kein Fehler.

**Strecke einmessen** (die einzige Stellschraube, wenn die Meter nicht
passen): `DISTANCE_PER_REV` in `src/core/engine.ts` ist mit 2,5 m ein
Community-Richtwert, nicht von Concept2 bestätigt.

```
DISTANCE_PER_REV = 2,5 * (PM3-Meter / Dashboard-Meter)
```

Beispiel: PM3 zeigt 1.000 m, das Dashboard 980 m → `2,5 * 1000/980 = 2,551`.
Danach den Split gegen das PM3 prüfen. Die Leistung hängt an der
Winkelgeschwindigkeit und ändert sich dadurch nicht.

## 2. Firmware aufs Board bringen

Es gibt zwei Wege. Wer nur das Board flashen will, nimmt **A** und braucht
keine Entwicklungsumgebung.

### A) Fertige .bin flashen (empfohlen)

Die CI baut bei jedem Tag und jedem Lauf auf `main` fertige Dateien:

- **Actions → Firmware ESP32 → letzter grüner Lauf → Artifacts →
  `ruder-sensor-esp32dev`**
- oder direkt am **Release** (bei Tags `v*`)

Artefakte entstehen nur bei Läufen, die **nicht** von einem Pull Request
kommen (also auf `main` oder per „Run workflow“). Bei einem PR-Lauf steht in
der Zusammenfassung nur die Dateiliste — das ist normal, die Dateien selbst
gibt es dort bewusst nicht.

Wenn kein passender Lauf da ist: **Actions → Firmware ESP32 → Run workflow →
Branch `main` → Run**. Nach etwa zwei Minuten hängt das Paket am Lauf.

Im Paket liegen die `.bin`-Dateien, `flashen.sh`, `flashen.bat`,
`LIESMICH.txt` und `SHA256SUMS.txt`.

```bash
pip install esptool
./flashen.sh /dev/ttyUSB0      # Linux/macOS
flashen.bat COM3               # Windows
```

Die Skripte setzen die richtigen Adressen (`0x1000` Bootloader, `0x8000`
Partitionen, `0xe000` boot_app0, `0x10000` Anwendung). Wer es selbst tippt:

```bash
esptool.py --chip esp32 --port /dev/ttyUSB0 --baud 460800 \
  write_flash -z --flash_mode dio --flash_freq 40m --flash_size detect \
  0x1000  ruder-sensor-esp32dev-bootloader.bin \
  0x8000  ruder-sensor-esp32dev-partitions.bin \
  0xe000  ruder-sensor-esp32dev-boot_app0.bin \
  0x10000 ruder-sensor-esp32dev.bin
```

**Erste Einrichtung direkt nach dem Flashen:**

1. Das Board öffnet das WLAN **`ruder-sensor-setup`** (kein Passwort).
2. Damit verbinden, im Browser **`http://192.168.4.1/`** aufrufen.
3. Studio-WLAN (2,4 GHz) und Passwort eintragen, speichern.
4. Das Gerät startet neu und ist als `http://ruder-sensor.local/` erreichbar.

Die Zugangsdaten liegen im NVS des ESP32 und bleiben bei späteren
Firmware-Updates erhalten. Deshalb enthalten die Release-Dateien bewusst
**kein** WLAN – sonst müsste für jedes Studio eine eigene .bin gebaut werden.

### B) Selbst bauen und flashen

Für eigene Anpassungen (Pins, Entprellzeit, fest eingetragene Zugangsdaten):

```bash
cd firmware/ruder_sensor

# Model C mit PM3: vorbereitete Vorlage nehmen
cp include/config.model-c-pm3.h include/config.h
# oder für ein anderes Gerät:
# cp include/config.example.h include/config.h

# config.h öffnen: WLAN-Name, Passwort, OTA-Passwort anpassen

pio run -t upload
pio device monitor
```

`config.h` ist gitignored – Passwörter landen nicht im Repository. Die
Vorlage `config.model-c-pm3.h` enthält die Erklärungen zu jedem Wert
(warum 3 ms Entprellung, warum feste IP, wo der Sensor sitzt).

Der Einrichtungsmodus entfällt, wenn `WIFI_SSID` in `config.h` gesetzt ist.
Eine im Browser gespeicherte Zugangsdaten-Kombination hat trotzdem Vorrang –
so lässt sich ein Gerät im Feld umziehen, ohne neu zu flashen.

Nach dem Start erscheint im Monitor:

```
# physio & fit – Ruder-Sensor
# WLAN verbunden: 192.168.1.50 (Kanal 6, -58 dBm)
# Im Netz erreichbar als ruder-sensor.local
# WebSocket bereit auf Port 81
```

Ohne Zugangsdaten steht dort stattdessen:

```
# ===== EINRICHTUNGSMODUS =====
# WLAN "ruder-sensor-setup" öffnen (kein Passwort)
# Danach http://192.168.4.1/ aufrufen
# =============================
```

Findet das Gerät ein bekanntes Netz nicht (WLAN umbenannt, Passwort
geändert), startet es ebenfalls im Einrichtungsmodus – statt in einer
Neustartschleife zu hängen.

!!! warning "Nur 2,4 GHz"
    Der ESP32 kann kein 5-GHz-Netz. Wenn das Studio-WLAN auf 5 GHz läuft,
    im Router ein 2,4-GHz-Netz für die Geräte einschalten.

Wenn der Upload scheitert: USB-Kabel (muss Daten übertragen, nicht nur
laden), Treiber (CP2102/CH340) und Port prüfen. Beim ESP32-DevKit oft
`/dev/ttyUSB0` (Linux), `COM3` (Windows), `/dev/cu.usbserial-*` (macOS).

## 3. Sensor prüfen, bevor das Dashboard kommt

Diagnoseseite im Browser öffnen: `http://ruder-sensor.local/` oder
`http://<IP>/`. Dort steht, was man zum Ausrichten braucht:

| Anzeige | Sollwert | Bedeutung |
| --- | --- | --- |
| Impulse gesamt | steigt beim Kurbeln | Sensor sieht das Schwungrad |
| Prellen verworfen | 0 oder wenige | viele = Sensor zu nah/zu weit weg, Störung |
| Puffer verworfen | 0 | > 0 = WLAN hängt, siehe unten |
| Kürzester Abstand | 20–60 ms | unter 5 ms = Prellen, über 200 ms = Magnet schwach |

Steigt „Impulse gesamt" nicht, obwohl gedreht wird: Abstand zum Magneten
prüfen, Polarität des Magneten umdrehen, Pull-up kontrollieren.

## 4. Dashboard aufs Tablet bringen

Das Dashboard ist eine Webseite. Sie muss irgendwo liegen, wo das Tablet sie
per WLAN erreicht — drei Wege, alle ohne Cloud:

| Weg | Adresse am Tablet | Wofür |
| --- | --- | --- |
| **Laptop im Studio** | `http://<laptop-ip>:4173` | der schnellste Weg, Laptop bleibt an |
| **Einmal gebaut, irgendwo ausgeliefert** | `http://<server-ip>` | Dauerbetrieb, z. B. auf dem Studio-NAS |
| **Auf dem ESP32 selbst** | `http://ruder-sensor.local/` | nur die Diagnoseseite — die volle Anzeige passt nicht in den Flash |

**Weg 1 – Laptop im Studio (empfohlen zum Start):**

```bash
npm install
npm run build      # Typprüfung + Build nach dist/
npm run preview    # liefert dist/ aus, im ganzen WLAN erreichbar
```

`npm run preview` zeigt beim Start die Adresse an, z. B.
`http://192.168.1.20:4173`. Diese Adresse auf dem Tablet eintippen, fertig.
Der Laptop darf danach nicht in den Ruhezustand (Netzteil anschließen).

**Weg 2 – fester Platz im Netz:** den Inhalt von `dist/` auf einen
Webserver im Studio kopieren (jeder beliebige Webserver, keine
Sonderbehandlung nötig — es sind nur statische Dateien). Wichtig: die Seite
muss über **`http`** ausgeliefert werden, nicht `https`, sonst blockiert der
Browser die unverschlüsselte Sensor-Verbindung.

> Der Sensor läuft bewusst auf `ws://`. Deshalb Dashboard und Sensor im
> selben Netz über `http` betreiben — oder beides hinter einen Reverse-Proxy
> mit TLS legen. Gemischt (`https`-Seite, `ws`-Sensor) blockiert Chrome.

## 5. Dashboard verbinden

Auf dem Studio-Tablet (Chrome oder Edge):

1. Dashboard öffnen, Zahnrad → **Sensor: ESP32 im WLAN**.
2. Adresse eintragen: `ruder-sensor.local` genügt, Port und Protokoll
   ergänzt das Dashboard selbst.
3. **Verbinden**. Die Statuspille oben rechts wird grün und zeigt den
   Sensornamen, darunter erscheinen WLAN-Pegel, Impulse/s und
   „Uhr abgeglichen: ja".

Die Einstellung wird im Browser gespeichert. Nach einem Neustart des
Tablets verbindet das Dashboard von allein.

## 6. Kiosk-Betrieb einrichten

Die Anzeige soll von selbst starten und niemanden bedienen müssen.

**Vollbild:** Knopf oben rechts oder Taste `F`.

**Automatischer Start (Chrome/Edge):**

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --kiosk "https://<dashboard-adresse>/?kiosk=1"

# macOS
open -a "Google Chrome" --args --kiosk "https://<dashboard-adresse>/?kiosk=1"
```

`?kiosk=1` blendet Steuerung und Einstellungen aus; eine Berührung holt
sie für 6 Sekunden zurück. `--kiosk` verhindert, dass jemand die Seite
versehentlich schließt.

**Tablet wachhalten:** Bildschirmsperre im Betriebssystem auf „nie"
stellen und das Gerät am Netzteil betreiben. Webseiten dürfen den
Bildschirm nicht selbst wachhalten (`Wake Lock` ist in dieser Version
nicht eingebaut, weil es auf älteren Tablets unzuverlässig ist).

**Bedienung am Gerät:** Leertaste startet und pausiert, `R` setzt zurück,
`F` schaltet Vollbild. Mit angeschlossener Tastatur lässt sich das
Dashboard ohne Anfassen bedienen.

## 7. Täglicher Betrieb

1. Dashboard ist im Kiosk-Modus – man muss nichts tun.
2. Trainierender drückt **Start** (oder Leertaste), rudert los.
3. Am Trainingsende bleibt die Zusammenfassung stehen, bis jemand
   **Neues Training** wählt.

Bricht das WLAN weg, zeigt die Statuspille das an und das Dashboard
verbindet automatisch neu. Bis dahin läuft die Anzeige mit dem
Demo-Sensor weiter – **die Zahlen sind dann nicht echt**. Das ist Absicht
(eine tote Anzeige ist schlimmer), aber es muss sichtbar bleiben: die
Pille ist dann rot und die Meldung nennt den Grund.

## 8. Wenn etwas nicht geht

| Symptom | Ursache | Abhilfe |
| --- | --- | --- |
| Dashboard verbindet nicht | falsche Adresse | IP auf der Sensordiagnose ablesen und eintragen |
| `wss://` schlägt fehl | Sensor spricht nur `ws://` | im Dashboard `ws://IP/` verwenden |
| Seite lädt, aber Werte bleiben null | Kiosk-Seite ist per `https` geladen, Sensor per `ws` | Dashboard und Sensor im selben Netz über `http` betreiben, oder einen Reverse-Proxy mit TLS davor setzen |
| Schlagzahl zu hoch | Prellen | `DEBOUNCE_US` in `config.h` auf 5000 erhöhen |
| Split weicht von PM ab | Drag-Faktor falsch | Drag-Faktor im Dashboard auf Wert der Klappenstellung setzen |

**Bekannte Einschränkung:** Browser verbieten einer `https`-Seite, eine
unverschlüsselte `ws`-Verbindung zu öffnen. Für den Studiobetrieb heißt
das: Dashboard über `http://` im lokalen Netz ausliefern (so ist es
gedacht) oder TLS für beides einrichten. Ein öffentlich erreichbares
Dashboard mit `https` und einem Sensor ohne TLS funktioniert nicht – das
ist eine Browser-Regel, keine Einstellung.
