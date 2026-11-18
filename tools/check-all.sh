#!/usr/bin/env bash
# Prüft in einem Durchlauf, ob das Repository vollständig und lauffähig ist.
# Aufruf: tools/check-all.sh
#
# Geprüft wird:
#   1. Dateien, die es geben muss (Dashboard, Firmware, CI, Doku)
#   2. Typprüfung des Dashboards
#   3. Dashboard-Tests
#   4. Produktions-Build (nur wenn dist/ noch nicht existiert oder --build)
#   5. Firmware: Host-Tests + Syntaxprüfung in der Toolchain-Sprache
#   6. CI-Workflow (Action-Versionen, Job-IDs, Schritte)
#
# Rückgabe 0 = alles vorhanden und grün, 1 = mindestens eine Lücke.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FEHLER=0
WARNUNG=0
MIT_BUILD=0
[ "${1:-}" = "--build" ] && MIT_BUILD=1

gruen() { printf '  \033[32mok\033[0m    %s\n' "$1"; }
rot()   { printf '  \033[31mFEHLT\033[0m %s\n' "$1"; FEHLER=$((FEHLER + 1)); }
gelb()  { printf '  \033[33mwarn\033[0m  %s\n' "$1"; WARNUNG=$((WARNUNG + 1)); }
kopf()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
kopf "1. Dateien"
PFLICHT=(
  "index.html:Startseite"
  "package.json:npm-Projekt"
  "vite.config.ts:Vite-Konfiguration"
  "src/main.ts:Einstiegspunkt"
  "src/styles.css:Marke und Layout"
  "src/core/engine.ts:Ruder-Physik"
  "src/core/controller.ts:Zustandsmaschine"
  "src/core/session.ts:Training und Splits"
  "src/core/format.ts:Anzeigeformate"
  "src/core/simulator.ts:Demo-Modus"
  "src/input/protocol.ts:Zeilenformat"
  "src/input/sources.ts:Sensorquellen"
  "src/input/heartRate.ts:Brustgurt"
  "src/ui/dashboard.ts:Anzeige"
  "src/ui/icons.ts:Symbole"
  "public/brand/logo-mark.png:Logo (Hell auf Dunkel)"
  "public/brand/logo-full.png:Logo mit Wortmarke"
  "firmware/Makefile:Host-Tests und Syntaxprüfung"
  "firmware/ruder_sensor/platformio.ini:PlatformIO-Projekt"
  "firmware/ruder_sensor/src/main.cpp:Firmware"
  "firmware/ruder_sensor/include/pulse_filter.h:Entprellung"
  "firmware/ruder_sensor/include/config.example.h:Konfigurationsvorlage"
  "firmware/ruder_sensor/include/config.model-c-pm2.h:Model C mit PM2"
  ".github/workflows/firmware.yml:CI"
  "tools/device-emulator.mjs:Sensor simulieren"

  "tools/sensor-server.mjs:ESP32 samt Anzeige simulieren"
  "tools/embed-dashboard.mjs:Dashboard in die Firmware einbetten"
  "tools/check-embedding.mjs:Einbettung prüfen"
  "tools/check-workflow.py:CI prüfen"
  "firmware/ruder_sensor/include/dashboard_assets.h:eingebettete Anzeige"
  "public/brand/web/logo-mark-light.png:Marke (web-optimiert)"
  "test/sensorauslieferung.test.ts:Auslieferung durch den ESP32"
  "docs/inbetriebnahme.md:Inbetriebnahme"
  "docs/hardware.md:Hardware"
  "docs/protocol.md:Protokoll"
  "README.md:Übersicht"
)
for eintrag in "${PFLICHT[@]}"; do
  datei="${eintrag%%:*}"
  zweck="${eintrag#*:}"
  if [ -f "$datei" ]; then
    gruen "$datei ($zweck)"
  else
    rot "$datei ($zweck)"
  fi
done

# Streuner: Stubs gehören unter firmware/stubs/, nicht in die Wurzel.
for streuner in esp_system.h esp_random.h Arduino.h freertos; do
  [ -e "$streuner" ] && rot "$streuner liegt in der Wurzel statt unter firmware/stubs/"
done

# config.h darf nicht eingecheckt sein (enthält Zugangsdaten).
if [ -f firmware/ruder_sensor/include/config.h ]; then
  if git ls-files --error-unmatch firmware/ruder_sensor/include/config.h >/dev/null 2>&1; then
    rot "firmware/ruder_sensor/include/config.h ist eingecheckt – enthält WLAN-Zugangsdaten"
  else
    gruen "config.h liegt lokal und ist ignoriert (gut so)"
  fi
fi

# ---------------------------------------------------------------------------
kopf "2. Dashboard: Typprüfung"
if [ -x node_modules/.bin/tsc ] || [ -x node_modules/.bin/vitest ]; then
  if ./node_modules/.bin/tsc --noEmit >/tmp/check-all-tsc.log 2>&1; then
    gruen "tsc --noEmit"
  else
    rot "tsc --noEmit:"
    sed 's/^/        /' /tmp/check-all-tsc.log | head -20
  fi
else
  gelb "node_modules fehlt – erst 'npm install', Typprüfung und Tests übersprungen"
fi

kopf "3. Dashboard: Tests"
if [ -x node_modules/.bin/vitest ]; then
  AUSGABE="$(./node_modules/.bin/vitest run 2>&1)"
  STATUS=$?
  TREFFER="$(printf '%s\n' "$AUSGABE" | grep -E '^ *Tests +[0-9]+' | tail -1)"
  DATEIEN="$(printf '%s\n' "$AUSGABE" | grep -E '^ *Test Files +' | tail -1)"
  if [ "$STATUS" -ne 0 ]; then
    # Auch fehlgeschlagene Suiten (kaputte Imports) zählen als Fehler –
    # dort steht oft gar keine "Tests"-Zeile.
    rot "Dashboard-Tests (Exit $STATUS):${TREFFER:+ $TREFFER}"
    printf '%s\n' "$AUSGABE" | grep -E 'FAIL|Failed Suites|Does the file exist' |
      head -5 | sed 's/^/        /'
  else
    gruen "Dashboard-Tests:${DATEIEN:+$DATEIEN}${TREFFER:+ ·$TREFFER}"
  fi
  printf '%s\n' "$AUSGABE" | grep -q "Unhandled" &&
    gelb "Tests melden unbehandelte Fehler (unhandled rejection)"
fi

# ---------------------------------------------------------------------------
kopf "4. Produktions-Build"
if [ "$MIT_BUILD" = "1" ] || [ ! -d dist ]; then
  if [ -x node_modules/.bin/vite ]; then
    if ./node_modules/.bin/vite build >/tmp/check-all-build.log 2>&1; then
      GROESSE="$(du -sh dist 2>/dev/null | cut -f1)"
      gruen "vite build (dist/ $GROESSE)"
    else
      rot "vite build:"
      tail -10 /tmp/check-all-build.log | sed 's/^/        /'
    fi
  else
    gelb "vite fehlt – Build übersprungen"
  fi
else
  gruen "dist/ vorhanden (mit --build neu erzeugen)"
fi

# ---------------------------------------------------------------------------

kopf "5. Dashboard in der Firmware"
if [ -f firmware/ruder_sensor/include/dashboard_assets.h ]; then
  if node tools/check-embedding.mjs >/tmp/check-all-embed.log 2>&1; then
    KURZ="$(grep -oE '[0-9]+ Dateien, [0-9]+ kB' /tmp/check-all-embed.log | tail -1)"
    gruen "Einbettung: ${KURZ:-geprüft}"
  else
    rot "Einbettung:"
    grep -E "FEHLER" /tmp/check-all-embed.log | head -8 | sed 's/^/        /'
  fi
  if node tools/embed-dashboard.mjs --pruefen >/dev/null 2>&1; then
    gruen "dashboard_assets.h passt zum Build in dist/"
  else
    rot "dashboard_assets.h ist veraltet – 'npm run build' erzeugt es neu"
  fi
else
  rot "firmware/.../dashboard_assets.h fehlt – der ESP32 kann dann nur die Diagnoseseite"
fi

kopf "6. Firmware"
if make -C firmware all >/tmp/check-all-firmware.log 2>&1; then
  TESTS="$(grep -cE '^(ok|PASS|bestanden)' /tmp/check-all-firmware.log || true)"
  gruen "Host-Tests und Syntaxprüfung (gnu++11)"
else
  rot "Firmware-Prüfung:"
  tail -15 /tmp/check-all-firmware.log | sed 's/^/        /'
fi

# ---------------------------------------------------------------------------

kopf "7. CI-Workflow"
if python3 -c "import yaml" >/dev/null 2>&1; then
  if python3 tools/check-workflow.py >/tmp/check-all-ci.log 2>&1; then
    gruen "tools/check-workflow.py"
  else
    rot "tools/check-workflow.py:"
    tail -15 /tmp/check-all-ci.log | sed 's/^/        /'
  fi
else
  gelb "PyYAML fehlt – 'pip install pyyaml', Workflow-Prüfung übersprungen"
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FEHLER" -gt 0 ]; then
  printf '\033[31m%d Lücke(n) gefunden\033[0m' "$FEHLER"
  [ "$WARNUNG" -gt 0 ] && printf ', %d Warnung(en)' "$WARNUNG"
  printf '\n'
  exit 1
fi
printf '\033[32mAlles vorhanden und grün\033[0m'
[ "$WARNUNG" -gt 0 ] && printf ' – %d Warnung(en)' "$WARNUNG"
printf '\n'
