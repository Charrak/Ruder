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

## 2. Firmware flashen

```bash
cd firmware/ruder_sensor
cp include/config.example.h include/config.h
# config.h öffnen: WLAN-Name, Passwort, ggf. SENSOR_PIN anpassen

pio run -t upload
pio device monitor
```

Nach dem Start erscheint im Monitor:

```
# physio & fit – Ruder-Sensor
# WLAN verbunden: 192.168.1.50 (Kanal 6, -58 dBm)
# Im Netz erreichbar als ruder-sensor.local
# WebSocket bereit auf Port 81
```

Kommt statt dessen `WLAN nicht erreichbar`: SSID/Passwort prüfen und
sicherstellen, dass es ein **2,4-GHz-Netz** ist – der ESP32 kann kein 5 GHz.

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

## 4. Dashboard verbinden

Auf dem Studio-Tablet (Chrome oder Edge):

1. Dashboard öffnen, Zahnrad → **Sensor: ESP32 im WLAN**.
2. Adresse eintragen: `ruder-sensor.local` genügt, Port und Protokoll
   ergänzt das Dashboard selbst.
3. **Verbinden**. Die Statuspille oben rechts wird grün und zeigt den
   Sensornamen, darunter erscheinen WLAN-Pegel, Impulse/s und
   „Uhr abgeglichen: ja".

Die Einstellung wird im Browser gespeichert. Nach einem Neustart des
Tablets verbindet das Dashboard von allein.

## 5. Kiosk-Betrieb einrichten

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

## 6. Täglicher Betrieb

1. Dashboard ist im Kiosk-Modus – man muss nichts tun.
2. Trainierender drückt **Start** (oder Leertaste), rudert los.
3. Am Trainingsende bleibt die Zusammenfassung stehen, bis jemand
   **Neues Training** wählt.

Bricht das WLAN weg, zeigt die Statuspille das an und das Dashboard
verbindet automatisch neu. Bis dahin läuft die Anzeige mit dem
Demo-Sensor weiter – **die Zahlen sind dann nicht echt**. Das ist Absicht
(eine tote Anzeige ist schlimmer), aber es muss sichtbar bleiben: die
Pille ist dann rot und die Meldung nennt den Grund.

## 7. Wenn etwas nicht geht

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
