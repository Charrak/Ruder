#!/usr/bin/env node
/**
 * Ruder-Sensor simulieren – für Entwicklung ohne ESP32.
 *
 *   node tools/device-emulator.mjs [--port 8081] [--spm 24] [--pace 125]
 *
 * Danach im Dashboard unter Einstellungen "ws://localhost:8081/" eintragen.
 * Port 81 wie auf dem echten Sensor braucht unter Linux root-Rechte,
 * deshalb ist 8081 voreingestellt.
 * Der Emulator spricht exakt das Protokoll der ESP32-Firmware:
 *   B,<boot>,<millis>  beim Verbinden
 *   P,<millis>         Impulse mit Gerätezeit
 *   S,<rssi>,<clients>,<pps>
 *
 * Damit lassen sich Wiederverbinden, Uhr-Abgleich und Jitter testen, ohne
 * das Gerät aus dem Studio zu holen.
 */

import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};

const PORT = arg('port', 8081);
const SPM = arg('spm', 24);
const PACE = arg('pace', 125);
const PULSES_PER_REV = 6;
const DISTANCE_PER_REV = 2.5;

const server = new WebSocketServer({ port: PORT });
const bootId = Math.floor(Math.random() * 65_535);
const startedAt = Date.now();

console.log(`Ruder-Sensor-Emulator auf ws://0.0.0.0:${PORT}/`);
console.log(`Schlagzahl ${SPM}/min, Split ${PACE} s/500 m, Bootkennung ${bootId}`);

/** Wandelt Split in Winkelgeschwindigkeit um (Weg pro Impuls). */
const speedMps = 500 / PACE;
const meanRevPerSec = speedMps / DISTANCE_PER_REV;
const meanOmega = meanRevPerSec * 2 * Math.PI;

let angle = 0;
let lastTick = Date.now();
let strokePhase = 0;
let pending = [];
let pulsesThisSecond = 0;
let reportedRate = 0;

/** Winkelgeschwindigkeit zu einem Punkt im Schlagzyklus (Durchzug/Erholung). */
function omegaAt(phase) {
  const driveFraction = 0.38;
  const ratio = 1.32;
  const wMin = (Math.log(ratio) / (ratio - 1)) * meanOmega;
  const wMax = wMin * ratio;
  return phase < driveFraction
    ? wMin + (wMax - wMin) * (phase / driveFraction)
    : wMax - (wMax - wMin) * ((phase - driveFraction) / (1 - driveFraction));
}

/**
 * Integriert in 1-ms-Schritten. Wichtig: Zeitstempel müssen fein sein –
 * mit auf 20 ms gerundeten Zeiten wird die Schlag-Erkennung unbrauchbar,
 * weil die Impulsabstände dann um ±20 % streuen.
 */
function step(now) {
  const elapsed = now - lastTick;
  if (elapsed <= 0) return;
  lastTick = now;

  const cycle = 60 / SPM;
  const stepPerPulse = (2 * Math.PI) / PULSES_PER_REV;

  for (let ms = 0; ms < elapsed; ms++) {
    const dt = 0.001;
    strokePhase = (strokePhase + dt / cycle) % 1;
    angle += omegaAt(strokePhase) * dt;
    while (angle >= stepPerPulse) {
      angle -= stepPerPulse;
      pending.push(now - elapsed + ms);
      pulsesThisSecond++;
    }
  }
}

setInterval(() => {
  step(Date.now());
  if (pending.length === 0) return;
  const lines = pending.map((t) => `P,${t}\n`).join('');
  pending = [];
  for (const client of server.clients) {
    if (client.readyState === 1) client.send(lines);
  }
}, 20);

let statusAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const seconds = (now - statusAt) / 1000;
  statusAt = now;
  reportedRate = Math.round((pulsesThisSecond / seconds) * 10) / 10;
  pulsesThisSecond = 0;

  const line = `S,-62,${server.clients.size},${reportedRate}\n`;
  for (const client of server.clients) {
    if (client.readyState === 1) client.send(line);
  }
}, 5000);

server.on('error', (error) => {
  if (error.code === 'EACCES') {
    console.error(`# Port ${PORT} ist gesperrt. Anderen Port wählen: --port 8081`);
  } else if (error.code === 'EADDRINUSE') {
    console.error(`# Port ${PORT} ist belegt. Anderen Port wählen: --port 8082`);
  } else {
    console.error('# Serverfehler:', error.message);
  }
  process.exit(1);
});

server.on('connection', (socket, request) => {
  console.log(`# Dashboard verbunden: ${request.socket.remoteAddress}`);
  socket.send(`B,${bootId},${Date.now() - startedAt}\n`);
  socket.on('message', (data) => {
    const command = String(data).trim();
    console.log(`# Befehl: ${command}`);
    if (command === 'boot?') socket.send(`B,${bootId},${Date.now() - startedAt}\n`);
    if (command === 'diag?') socket.send('T,32.5\n');
  });
});

process.on('SIGINT', () => {
  console.log('\n# Emulator beendet');
  server.close(() => process.exit(0));
});
