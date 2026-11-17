#!/usr/bin/env node
// Simuliert den ESP32 so, wie er das Dashboard ausliefert – zum Prüfen ohne
// Hardware.
//
// Gelesen wird firmware/ruder_sensor/include/dashboard_assets.h, also genau
// das, was in der Firmware steckt. Ausgeliefert wird mit denselben Regeln wie
// in main.cpp:
//
//   /                -> index.html
//   /status          -> Diagnoseseite (Kurzfassung)
//   <eingebetteter>  -> Datei mit Content-Type und ETag
//   sonst            -> 404 "nicht gefunden"
//
// Dazu ein WebSocket auf Port 81 mit Impulsen, damit die Anzeige auch Werte
// zeigt. Das ist derselbe Protokoll-Fluss wie beim echten Gerät.
//
// Aufruf: node tools/sensor-server.mjs [--port 8080] [--ws-port 8081]

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = join(WURZEL, 'firmware/ruder_sensor/include/dashboard_assets.h');

const arg = (name, ersatz) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : ersatz;
};
const HTTP_PORT = arg('port', 8080);
const WS_PORT = arg('ws-port', 8081);

// --- Header auslesen (dieselbe Tabelle wie im Flash) -----------------------
const quelle = readFileSync(HEADER, 'utf8');
const stand = /kDashboardStand\[\] = "([^"]+)"/.exec(quelle)?.[1] ?? 'unbekannt';

const dateien = new Map();
for (const treffer of quelle.matchAll(
  /\{"([^"]+)", "([^"]+)", (kDatei_\w+), sizeof\(kDatei_\w+\)\},/g,
)) {
  const [, pfad, typ, name] = treffer;
  const array = new RegExp(
    `static const uint8_t ${name}\\[\\] PROGMEM = \\{([\\s\\S]*?)\\};`,
  ).exec(quelle);
  const bytes = Buffer.from((array[1].match(/0x[0-9a-f]{2}/g) ?? []).map((h) => parseInt(h, 16)));
  dateien.set(pfad, { typ, bytes });
}

const statusSeite = () => `<!doctype html><meta charset=utf-8><title>Ruder-Sensor</title>
<meta name=viewport content='width=device-width,initial-scale=1'>
<style>body{font:16px system-ui;background:#082543;color:#f4f7fa;padding:24px}
h1{color:#b5e900;font-size:1.1rem;letter-spacing:.1em;text-transform:uppercase}
td{padding:5px 18px 5px 0}td:first-child{color:#9fb3c8}a{color:#b5e900}</style>
<h1>Ruder-Sensor – Diagnose</h1><table>
<tr><td>IP</td><td>127.0.0.1 (Simulation)</td></tr>
<tr><td>WebSocket</td><td>ws://127.0.0.1:${WS_PORT}/</td></tr>
<tr><td>Dashboards</td><td>${wss.clients.size}</td></tr>
<tr><td>Laufzeit</td><td>${Math.round(process.uptime())} s</td></tr>
</table><p><a href="/">Zur Anzeige</a></p>`;

const server = createServer((req, res) => {
  let pfad = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (pfad === '/') pfad = '/index.html';
  if (pfad === '/status' || pfad === '/diagnose') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(statusSeite());
    return;
  }

  const datei = dateien.get(pfad.slice(1));
  if (!datei) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('nicht gefunden');
    return;
  }

  const etag = `"${pfad.slice(1)}-${stand}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': datei.typ,
    'Content-Length': datei.bytes.length,
    ETag: etag,
    'Cache-Control': 'no-cache',
  });
  res.end(datei.bytes);
});

// --- Sensor auf Port 81 (Impulse wie am Schwungrad) -----------------------
const wss = new WebSocketServer({ port: WS_PORT });
const bootId = Math.floor(Math.random() * 65536);

wss.on('connection', (socket) => {
  console.log(`# Dashboard verbunden (${wss.clients.size})`);
  socket.send(`B,${bootId},${Date.now()}\n`);

  // 6 Magnete, 24 Schläge/min -> rund 2,4 Impulse/s. Etwas Jitter, damit es
  // realistisch ist.
  const takt = 1000 / (24 * 6 / 60);
  const sender = setInterval(() => {
    const jetzt = Date.now() + (Math.random() - 0.5) * 12;
    socket.send(`P,${jetzt.toFixed(1)}\n`);
  }, takt);

  socket.on('close', () => {
    clearInterval(sender);
    console.log(`# Dashboard getrennt (${wss.clients.size})`);
  });
  socket.on('message', (daten) => {
    const befehl = daten.toString().trim();
    if (befehl === 'boot?') socket.send(`B,${bootId},${Date.now()}\n`);
    if (befehl === 'diag?') socket.send('T,12.400\n');
    if (befehl.startsWith('d')) socket.send(`S,-58,${wss.clients.size},24.0\n`);
  });
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('Ruder-Sensor (Simulation der Firmware-Auslieferung)');
  console.log(`  Anzeige:      http://localhost:${HTTP_PORT}/`);
  console.log(`  Diagnose:     http://localhost:${HTTP_PORT}/status`);
  console.log(`  WebSocket:    ws://localhost:${WS_PORT}/`);
  console.log(`  Stand:        ${stand}`);
  console.log(`  Dateien:      ${dateien.size} (${[...dateien.keys()].join(', ')})`);
  console.log('');
  console.log('Im Browser öffnen – die Anzeige verbindet sich von allein.');
});
