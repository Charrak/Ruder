# Arduino-Stubs für die Syntaxprüfung

Diese Header sind **keine** Ersatz-Bibliotheken. Sie enthalten nur die
Deklarationen, die `src/main.cpp` anfasst, damit sich die Firmware mit einem
normalen Compiler übersetzen lässt:

```bash
cd firmware && make check-syntax
```

Damit fallen Syntaxfehler, falsche Argumente und Tippfehler in wenigen
Sekunden auf – ohne PlatformIO, ESP32-Toolchain oder Hardware. Was hier
**nicht** geprüft wird:

- Linken (die Funktionen haben keine Implementierung)
- Bibliotheksversionen (`lib_deps` in `platformio.ini`)
- Speicherverbrauch, Stack, Interrupt-Verhalten

Der echte Build läuft in der CI und beim Flashen. Diese Stubs sind die
schnelle Vorprüfung davor.
