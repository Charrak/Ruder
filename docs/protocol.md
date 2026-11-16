# Protokoll: Sensor → Dashboard

Eine Nachricht pro Zeile, Zeilenende `\n`, ASCII. Der ESP32 schickt, das
Dashboard hört zu – Ausnahmen sind zwei Befehle, die das Dashboard schicken
darf. Zahlen mit Dezimalpunkt (`48123.5`); das Komma trennt Felder.

## Nachrichten des Sensors

| Zeile | Bedeutung | Pflicht |
| --- | --- | --- |
| `I` | Impuls jetzt – Empfangszeit wird verwendet | ja, einfachste Form |
| `P,<ms>` | Impuls zum Gerätezeitpunkt `<ms>` (`millis()`) | empfohlen |
| `B,<boot>,<ms>` | Begrüßung: Bootkennung und aktuelle Gerätezeit | empfohlen |
| `S,<rssi>,<clients>,<pps>` | Status: WLAN-Pegel in dBm, Zuschauer, Impulse/s | optional |
| `T,<ms>` | kürzester gemessener Impulsabstand (Diagnose) | optional |

```text
B,32718,12
P,42
P,118
P,195
S,-62,1,9.6
```

### Warum Zeitstempel statt nur `I`

Die Impulsabstände sind die eigentliche Messgröße. Kommen die Impulse
gebündelt über WLAN, verfälscht die Übertragung die Abstände. Mit `P,<ms>`
entsteht der Zeitstempel im Interrupt auf dem ESP32; das Dashboard rechnet
die Übertragungszeit heraus (`DeviceClock` in `src/input/protocol.ts`).

### Warum die Bootkennung

`millis()` beginnt nach jedem Neustart bei null. Ändert sich `<boot>`,
verwirft das Dashboard seine Uhrabweichung und kalibriert neu. Ohne
`B`-Zeile erkennt es einen Neustart nur an einem Sprung über 5 Sekunden.

## Befehle des Dashboards

| Zeile | Wirkung |
| --- | --- |
| `boot?` | Sensor schickt erneut `B,<boot>,<ms>` |
| `diag?` | Sensor schickt `T,<ms>` |

Der Sensor darf unbekannte Zeilen ignorieren.

## Toleranzen

Das Dashboard ist absichtlich nachsichtig, damit ältere Bastel-Firmware
weiterläuft:

- eine nackte Zahl (`1234.5`) gilt als Gerätezeit
- Leerzeilen und Zeilen mit `#` werden verworfen
- unbekannte Zeilen werden ignoriert, nicht als Fehler behandelt
- `P` ohne Zahl zählt als Impuls mit Empfangszeit

## Grenzen

- **Kein Rückkanal für Konfiguration.** Drag-Faktor und Ziel bleiben im
  Dashboard; der Sensor weiß nichts davon.
- **Keine Authentifizierung.** Im Studio-WLAN ist das vertretbar, in einem
  offenen Netz könnte jeder Impulse einspeisen. Wer das braucht: WPA2 und
  ein separates Netz für die Geräte.
- **`S` alle 5 s** reicht für eine Diagnosezeile, nicht für Live-Anzeigen.
