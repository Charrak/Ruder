#!/usr/bin/env node
// Bettet das gebaute Dashboard in die Firmware ein.
//
// Der ESP32 liefert damit die komplette Anzeige selbst aus: Tablet oder
// Fernseher öffnen nur noch http://ruder-sensor.local/ – kein Laptop, kein
// Webserver, kein Internet im Studio nötig.
//
// Aufruf:
//   node tools/embed-dashboard.mjs            # dist/ einbetten
//   node tools/embed-dashboard.mjs --pruefen  # nur prüfen, ob aktuell
//
// Ergebnis: firmware/ruder_sensor/include/dashboard_assets.h
//
// Warum unkomprimiert: HTML, JS und CSS liessen sich per gzip von 72 kB auf
// 28 kB druecken, das spart 44 kB Flash. Dafuer muesste das Geraet bei jeder
// Anfrage einen Puffer im RAM anlegen und den Stream entpacken - und ein
// Puffer in Groesse des JS-Bundles (50 kB) ist ohne PSRAM knapp. Flash ist
// hier der billige Rohstoff: die App-Partition hat ~1,3 MB, die Firmware
// braucht ~580 kB. Roh ausliefern heisst: kein malloc, kein zlib, keine
// Fehlerquelle. Reicht der Platz eines Tages nicht, steht hier der Hebel.
//
// Das Dashboard verbindet sich mit dem Sensor auf derselben Adresse
// (Port 81). Deshalb funktioniert die Seite ohne jede Einstellung, sobald
// sie vom Gerät selbst kommt.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(WURZEL, 'dist');
const ZIEL = join(WURZEL, 'firmware/ruder_sensor/include/dashboard_assets.h');

// Nur diese Dateitypen kommen auf das Gerät. Alles andere (Quellkarten,
// Lizenztexte, unbenutzte Markenvarianten) würde nur Flash kosten.
const ERLAUBT = new Map([
  ['.html', { typ: 'text/html; charset=utf-8' }],
  ['.js', { typ: 'application/javascript; charset=utf-8' }],
  ['.css', { typ: 'text/css; charset=utf-8' }],
  ['.png', { typ: 'image/png' }],
  ['.svg', { typ: 'image/svg+xml' }],
  ['.ico', { typ: 'image/x-icon' }],
  ['.webmanifest', { typ: 'application/manifest+json' }],
]);

const pruefen = process.argv.includes('--pruefen');

if (!existsSync(DIST)) {
  console.error('dist/ fehlt. Erst "npm run build" laufen lassen.');
  process.exit(1);
}

/** Alle Dateien unter dist/ einsammeln, Pfade relativ und ohne dist/. */
function sammle(verzeichnis) {
  const dateien = [];
  for (const eintrag of readdirSync(verzeichnis).sort()) {
    const pfad = join(verzeichnis, eintrag);
    if (statSync(pfad).isDirectory()) {
      dateien.push(...sammle(pfad));
    } else {
      dateien.push(pfad);
    }
  }
  return dateien;
}

const alle = sammle(DIST);
const dateien = [];
const ignoriert = [];

for (const pfad of alle) {
  const endung = extname(pfad).toLowerCase();
  const info = ERLAUBT.get(endung);
  const rel = relative(DIST, pfad).split('\\').join('/');
  if (!info) {
    ignoriert.push(rel);
    continue;
  }
  dateien.push({ pfad, rel, info });
}

/**
 * Nur einbetten, was die Seite wirklich lädt.
 *
 * public/ enthält die Marken-Originale in Druckauflösung (bis 146 kB).
 * Über HTTP ist das egal – auf dem Gerät wäre es verschwendeter Flash.
 * Welche Datei gebraucht wird, steht in index.html und im gebauten JS/CSS.
 */
function wirdGeladen(rel) {
  const text = dateien
    .filter((d) => /\.(html|js|css)$/.test(d.rel))
    .map((d) => readFileSync(d.pfad, 'utf8'))
    .join('\n');
  // Vergleich über den ganzen Pfad: "brand/web/icon.png" darf nicht
  // "brand/icon.png" mitziehen, nur weil der Dateiname gleich ist.
  return text.includes(`/${rel}`) || text.includes(rel);
}

const ungenutzt = [];
for (let i = dateien.length - 1; i >= 0; i--) {
  const d = dateien[i];
  if (d.rel === 'index.html') continue;
  if (!wirdGeladen(d.rel)) {
    ungenutzt.push(d.rel);
    dateien.splice(i, 1);
  }
}
ungenutzt.sort();

if (dateien.length === 0) {
  console.error('Keine einbettbaren Dateien in dist/ gefunden.');
  process.exit(1);
}

/** C-Array aus Bytes, 16 pro Zeile – lesbar und kompakt genug. */
function alsArray(bytes, einzug = '  ') {
  const zeilen = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const teil = Array.from(bytes.subarray(i, i + 16))
      .map((b) => `0x${b.toString(16).padStart(2, '0')}`)
      .join(', ');
    zeilen.push(`${einzug}${teil},`);
  }
  return zeilen.join('\n');
}

const eintraege = [];
let rohBytes = 0;
let uebertragen = 0;

for (const datei of dateien) {
  const daten = readFileSync(datei.pfad);
  const name = datei.rel.replace(/[^a-zA-Z0-9]/g, '_');

  rohBytes += daten.length;
  uebertragen += daten.length;

  eintraege.push({
    ...datei,
    name,
    daten,
    hash: createHash('sha256').update(daten).digest('hex').slice(0, 12),
  });
}

const gesamt = uebertragen;
const kopf = `// Automatisch erzeugt von tools/embed-dashboard.mjs – nicht von Hand ändern.
//
// Inhalt: das gebaute Dashboard aus dist/, ${dateien.length} Datei(en),
// ${rohBytes} Bytes roh, ${gesamt} Bytes auf dem Gerät${ungenutzt.length ? `\n// Ungenutzte Markendateien weggelassen: ${ungenutzt.join(', ')}` : ''}${ignoriert.length ? `\n// Kein Webformat: ${ignoriert.join(', ')}` : ''}
//
// Erzeugen:  npm run build && node tools/embed-dashboard.mjs
`;

/** Stabile Reihenfolge: index.html zuerst, dann alphabetisch. */
eintraege.sort((a, b) => {
  if (a.rel === 'index.html') return -1;
  if (b.rel === 'index.html') return 1;
  return a.rel.localeCompare(b.rel);
});

const inhalt = [];

for (const e of eintraege) {
  inhalt.push(`// ${e.rel} (${e.daten.length} Bytes)`);
  inhalt.push(`static const uint8_t kDatei_${e.name}[] PROGMEM = {`);
  inhalt.push(alsArray(e.daten));
  inhalt.push('};');
  inhalt.push('');
}

inhalt.push('struct EingebetteteDatei {');
inhalt.push('  const char *pfad;        // Pfad ohne fuehrenden Schraegstrich');
inhalt.push('  const char *typ;         // Content-Type');
inhalt.push('  const uint8_t *daten;    // PROGMEM, roh');
inhalt.push('  size_t laenge;           // Laenge der gespeicherten Daten');
inhalt.push('};');
inhalt.push('');
inhalt.push('static const EingebetteteDatei kDashboardDateien[] = {');
for (const e of eintraege) {
  inhalt.push(
    `  {"${e.rel}", "${e.info.typ}", kDatei_${e.name}, sizeof(kDatei_${e.name})},`,
  );
}
inhalt.push('};');
inhalt.push('');
inhalt.push(`static const size_t kDashboardDateiAnzahl = ${eintraege.length};`);
inhalt.push(`static const size_t kDashboardBytes = ${gesamt};`);
inhalt.push(`static const char kDashboardStand[] = "${new Date().toISOString().slice(0, 16).replace('T', ' ')}";`);
inhalt.push('');

const text = `${kopf}\n#pragma once\n#include <Arduino.h>\n#include <cstddef>\n\n${inhalt.join('\n')}`;

if (pruefen) {
  const vorhanden = existsSync(ZIEL) ? readFileSync(ZIEL, 'utf8') : '';
  // Der Zeitstempel ändert sich bei jedem Lauf, deshalb wird er beim
  // Vergleich ausgeblendet.
  const ohneStand = (s) => s.replace(/static const char kDashboardStand\[\] = "[^"]*";/, '');
  if (ohneStand(vorhanden) === ohneStand(text)) {
    console.log('dashboard_assets.h ist aktuell.');
    process.exit(0);
  }
  console.error('dashboard_assets.h passt nicht zu dist/. Bitte neu erzeugen:');
  console.error('  node tools/embed-dashboard.mjs');
  process.exit(1);
}

writeFileSync(ZIEL, text);
console.log(`dashboard_assets.h geschrieben: ${dateien.length} Datei(en)`);
console.log(`  roh:          ${rohBytes} Bytes`);
console.log(`  auf dem Gerät: ${gesamt} Bytes (${Math.round((gesamt / rohBytes) * 100)} %)`);
if (ungenutzt.length > 0) {
  console.log(`  ungenutzte Markendateien weggelassen: ${ungenutzt.join(', ')}`);
}
if (ignoriert.length > 0) {
  console.log(`  kein Webformat: ${ignoriert.join(', ')}`);
}
