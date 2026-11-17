#!/usr/bin/env python3
"""Vorabprüfung des Firmware-Workflows.

    pip install pyyaml
    python3 tools/check-workflow.py

GitHub prüft Workflow-Dateien erst beim Lauf. Ein Tippfehler in einer
Action-Version oder ein Umlaut in einer Job-ID führt dann zu einem Lauf
ohne einen einzigen Job – und die Fehlermeldung sagt nicht, warum
(„This run likely failed because of a workflow file issue“). Dieses Skript
prüft vorher:

- sind Job-IDs ASCII und alle `needs`-Verweise gültig
- existieren die verwendeten Action-Tags wirklich
- stehen Heredocs so, wie YAML sie beim Runner ankommen lässt
- hat die Firmware die Voraussetzungen, die der Build braucht
  (config.h optional, keine ungenutzten lib_deps)

Ohne Netzzugang werden die Action-Tags als „nicht prüfbar“ gemeldet, nicht
als fehlend – ein Offline-Rechner soll nicht fälschlich rot werden.
"""

import subprocess
import sys

import yaml

FEHLER = []
NETZ_WORTE = ("eof", "handshake", "timed out", "network", "could not resolve",
              "temporary failure", "unable to access")


def pruefe(bedingung, meldung):
    if bedingung:
        print(f"  ok    {meldung}")
    else:
        print(f"  FEHLT {meldung}")
        FEHLER.append(meldung)


def repo_basis():
    return subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def tag_existiert(repo, tag):
    """True/False, oder None wenn die Prüfung nicht möglich war."""
    try:
        ergebnis = subprocess.run(
            ["gh", "api", f"repos/{repo}/git/ref/tags/{tag}"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if ergebnis.returncode == 0:
        return True
    ausgabe = (ergebnis.stdout + ergebnis.stderr).lower()
    if any(wort in ausgabe for wort in NETZ_WORTE):
        return None
    return False


def main():
    basis = repo_basis()
    datei = f"{basis}/.github/workflows/firmware.yml"
    d = yaml.safe_load(open(datei))

    print("Actions-Versionen prüfen")
    gesehen = set()
    for job in d["jobs"].values():
        for schritt in job["steps"]:
            uses = schritt.get("uses")
            if not uses or uses.startswith("./"):
                continue
            repo, tag = uses.split("@")
            if (repo, tag) in gesehen:
                continue
            gesehen.add((repo, tag))
            status = tag_existiert(repo, tag)
            if status is None:
                print(f"  offen {repo}@{tag} nicht prüfbar (kein Netz)")
            else:
                pruefe(status, f"{repo}@{tag} existiert")

    print("\nJob-IDs und Verknüpfung")
    ids = set(d["jobs"].keys())
    for name, job in d["jobs"].items():
        pruefe(name.isascii(), f"Job-ID {name!r} ist ASCII")
        needs = job.get("needs")
        if needs:
            for n in ([needs] if isinstance(needs, str) else needs):
                pruefe(n in ids, f"{name} braucht vorhandenen Job {n}")

    print("\nHeredoc-Einrückung")
    bau_job = d["jobs"].get("build") or d["jobs"]["bauen"]
    script = [s for s in bau_job["steps"] if s.get("name") == "Flaschanleitung erzeugen"][0]["run"]
    # In YAML-Blöcken (|) bleibt die relative Einrückung erhalten; ein
    # <<'EOF' muss auf Spalte 0 der Runner-Sicht stehen.
    zeilen = script.split("\n")
    einzug = min(len(z) - len(z.lstrip()) for z in zeilen if z.strip())
    relativ = [z[einzug:] for z in zeilen]
    for i, zeile in enumerate(relativ):
        if "<<'EOF'" in zeile:
            pruefe(zeile.startswith("cat >"), f"Heredoc-Start in Spalte 0: {zeile[:40]}")
        if zeile.strip() == "EOF":
            pruefe(not zeile.startswith(" "), f"Heredoc-Ende ohne Einrückung (Zeile {i + 1})")

    print("\nBuild-Schritt")
    build = [s for s in bau_job["steps"] if s.get("name") == "Firmware bauen"][0]
    pruefe(build["working-directory"] == "${{ env.FIRMWARE_DIR }}", "baut im Firmware-Verzeichnis")
    pruefe("pio run" in build["run"], "nutzt pio run")

    print("\nVoraussetzungen der Firmware")
    ini = open(f"{basis}/firmware/ruder_sensor/platformio.ini").read()
    pruefe("ArduinoJson" not in ini, "keine ungenutzte Abhängigkeit in lib_deps")
    main_cpp = open(f"{basis}/firmware/ruder_sensor/src/main.cpp").read()
    pruefe('__has_include("config.h")' in main_cpp, "config.h ist optional (CI hat keine)")
    pruefe('WIFI_SSID ""' in main_cpp, "Standard ohne WLAN-Zugangsdaten vorhanden")
    pruefe("startSetupMode" in main_cpp, "Einrichtungsmodus vorhanden")

    # Das Dashboard steckt in der Firmware und wird beim Bauen eingebettet.
    # Fehlt der Schritt, entsteht eine .bin ohne Anzeige - das faellt sonst
    # erst am Tablet im Studio auf.
    bau_steps = [s.get("name", "") for s in bau_job["steps"]]
    pruefe(
        any("einbetten" in name.lower() or "Dashboard bauen" in name for name in bau_steps),
        "Dashboard wird vor dem Firmware-Bau eingebettet",
    )
    pruefe(
        'if __has_include("dashboard_assets.h")' in main_cpp
        or "__has_include(\"dashboard_assets.h\")" in main_cpp,
        "Firmware baut auch ohne eingebettetes Dashboard",
    )
    pruefe(
        "sendeDashboard" in main_cpp and "send_P" in main_cpp,
        "Firmware liefert das Dashboard aus (PROGMEM, ohne Kopie im RAM)",
    )

    # Pfad-Filter: der Workflow muss auch anspringen, wenn sich das
    # Dashboard oder die Einbettung aendert.
    # PyYAML liest den Schlüssel "on" als True.
    trigger = d.get(True) if True in d else d.get("on", {})
    pull = trigger.get("pull_request", {}) if isinstance(trigger, dict) else {}
    pfade = pull.get("paths", []) if isinstance(pull, dict) else []
    pruefe(
        any(p.startswith("src/") for p in pfade),
        "Workflow startet auch bei Aenderungen am Dashboard (src/**)",
    )
    pruefe(
        "tools/embed-dashboard.mjs" in pfade,
        "Workflow startet bei Aenderungen an der Einbettung",
    )

    print()
    if FEHLER:
        print(f"{len(FEHLER)} Probleme")
        return 1
    print("Alles in Ordnung")
    return 0


if __name__ == "__main__":
    sys.exit(main())
