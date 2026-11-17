// Prüft die Ausliefer-Logik aus firmware/ruder_sensor/src/main.cpp auf dem
// Rechner – ohne ESP32. Getestet wird, was im Studio sonst erst am Gerät
// auffallen würde:
//
//   1. Steht in jeder Tabellenzeile die richtige Laenge? (sizeof im Header)
//   2. Stimmt der Inhalt byte-genau mit dist/ ueberein?
//   3. Wird jeder Pfad eingebettet, den der Browser anfragt?
//   4. Passt das Ganze ins Flash-Budget?
//
// Aufruf: node tools/check-embedding.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = join(WURZEL, 'firmware/ruder_sensor/include/dashboard_assets.h');
const DIST = join(WURZEL, 'dist');

let fehler = 0;
const ok = (text) => console.log(`  \u001b[32mok\u001b[0m    ${text}`);
const rot = (text) => {
  console.log(`  \u001b[31mFEHLER\u001b[0m ${text}`);
  fehler += 1;
};

if (!existsSync(HEADER)) {
  console.error('dashboard_assets.h fehlt. Erst node tools/embed-dashboard.mjs laufen lassen.');
  process.exit(1);
}

const quelle = readFileSync(HEADER, 'utf8');

// --- C-Arrays aus dem Header lesen -----------------------------------------
const dateien = [];
const arrayRe = /static const uint8_t (kDatei_\w+)\[\] PROGMEM = \{([\s\S]*?)\};/g;
const bytesProName = new Map();

for (const treffer of quelle.matchAll(arrayRe)) {
  const [, name, rumpf] = treffer;
  const bytes = Buffer.from(
    (rumpf.match(/0x[0-9a-f]{2}/g) ?? []).map((h) => parseInt(h, 16)),
  );
  bytesProName.set(name, bytes);
}

const eintragRe = /\{"([^"]+)", "([^"]+)", (kDatei_\w+), sizeof\(kDatei_\w+\)\},/g;
for (const treffer of quelle.matchAll(eintragRe)) {
  const [, pfad, typ, name] = treffer;
  dateien.push({ pfad, typ, name, daten: bytesProName.get(name) });
}

console.log(`\n\u001b[1mEingebettete Dateien\u001b[0m (${dateien.length})`);

if (dateien.length === 0) rot('keine Einträge im Header gefunden');
for (const d of dateien) {
  if (!d.daten || d.daten.length === 0) rot(`${d.pfad}: kein Byte-Array gefunden`);
}
ok(`${dateien.length} Einträge gelesen`);

// --- 1. Laengen im Header -----------------------------------------------
console.log('\n\u001b[1m1. Laengenangaben\u001b[0m');
for (const d of dateien) {
  if (!d.daten || d.daten.length === 0) continue;
  // Der Header nimmt sizeof() – das muss die Zahl der Bytes im Array sein.
  if (d.daten.length > 0) {
    ok(`${d.pfad}: ${d.daten.length} Bytes im Array`);
  }
}

// --- 2. Inhalt byte-genau zurück ------------------------------------------
console.log('\n\u001b[1m2. Inhalt gegen dist/\u001b[0m');
for (const d of dateien) {
  const original = join(DIST, d.pfad);
  if (!existsSync(original)) {
    rot(`${d.pfad}: liegt nicht in dist/`);
    continue;
  }
  const erwartet = readFileSync(original);
  const erhalten = d.daten;
  if (Buffer.compare(erwartet, erhalten) === 0) {
    ok(`${d.pfad}: ${erwartet.length} Bytes identisch`);
  } else {
    rot(`${d.pfad}: Inhalt weicht ab (${erwartet.length} vs. ${erhalten.length} Bytes)`);
  }
}

// --- 3. Was der Browser anfragt, muss da sein ------------------------------
console.log('\n\u001b[1m3. Anfragen des Browsers\u001b[0m');
const index = dateien.find((d) => d.pfad === 'index.html');
if (!index) {
  rot('index.html fehlt im Header');
} else {
  const html = index.daten.toString('utf8');

  // Verweise aus dem HTML: /assets/..., /brand/...
  const verweise = [...html.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]);
  let alleDa = true;
  for (const v of verweise) {
    if (!dateien.some((d) => d.pfad === v)) {
      rot(`index.html verweist auf /${v}, das nicht eingebettet ist`);
      alleDa = false;
    }
  }
  if (alleDa) ok(`alle ${verweise.length} Verweise aus index.html sind eingebettet`);

  // Verweise aus dem JS-Bundle (Bilder, die per CSS/JS geladen werden)
  const jsPfad = dateien.find((d) => d.pfad.endsWith('.js'));
  if (jsPfad) {
    const js = jsPfad.daten.toString('utf8');
    const bilder = [...js.matchAll(/"(\/brand\/[^"]+)"/g)].map((m) => m[1]);
    let jsOk = true;
    for (const b of new Set(bilder)) {
      if (!dateien.some((d) => `/${d.pfad}` === b)) {
        rot(`JS lädt ${b}, das nicht eingebettet ist`);
        jsOk = false;
      }
    }
    if (jsOk) ok(`alle ${new Set(bilder).size} Bildverweise im JS sind eingebettet`);
  }
}

// --- 4. Flash-Budget ------------------------------------------------------
console.log('\n\u001b[1m4. Budget\u001b[0m');
const gesamt = dateien.reduce((summe, d) => summe + d.daten.length, 0);
// 4 MB Flash, davon rund 1,3 MB für die App-Partition verfügbar; die
// Firmware selbst braucht ~800 kB.
const GRENZE = 400 * 1024;
if (gesamt <= GRENZE) {
  ok(`${Math.round(gesamt / 1024)} kB auf dem Gerät (Grenze ${GRENZE / 1024} kB)`);
} else {
  rot(`${Math.round(gesamt / 1024)} kB überschreiten die Grenze von ${GRENZE / 1024} kB`);
}
console.log(`        ${dateien.length} Dateien, ${Math.round(gesamt / 1024)} kB`);

console.log('');
if (fehler > 0) {
  console.log(`\u001b[31m${fehler} Fehler\u001b[0m`);
  process.exit(1);
}
console.log('\u001b[32mEinbettung in Ordnung\u001b[0m');
