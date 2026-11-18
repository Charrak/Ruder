// @vitest-environment jsdom
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { laeuftAufSensor, RowerController } from '../src/core/controller';

/**
 * Der ESP32 liefert das Dashboard selbst aus. Zwei Dinge müssen dann
 * stimmen, sonst steht man im Studio vor einer leeren Anzeige:
 *
 *   1. Die Seite erkennt, dass sie vom Sensor kommt, und verbindet von
 *      allein – ohne Adresseingabe am Tablet.
 *   2. Was die Firmware ausliefert, deckt sich mit dem, was der Browser
 *      anfragt. Sonst fehlt genau das Bild oder Skript, das die Anzeige
 *      braucht.
 *
 * Die Dateiliste wird direkt aus firmware/.../dashboard_assets.h gelesen –
 * eine gepflegte Kopie im Quelltext würde bei jedem Build veralten.
 */
const HEADER = join(process.cwd(), 'firmware/ruder_sensor/include/dashboard_assets.h');

interface Eintrag {
  pfad: string;
  typ: string;
  laenge: number;
}

/** Tabelle aus dem erzeugten Header lesen. */
function liesEintraege(): Eintrag[] {
  const quelle = readFileSync(HEADER, 'utf8');
  const groessen = new Map<string, number>();
  for (const treffer of quelle.matchAll(
    /static const uint8_t (kDatei_\w+)\[\] PROGMEM = \{([\s\S]*?)\};/g,
  )) {
    groessen.set(treffer[1]!, (treffer[2]!.match(/0x[0-9a-f]{2}/g) ?? []).length);
  }
  const eintraege: Eintrag[] = [];
  for (const treffer of quelle.matchAll(
    /\{"([^"]+)", "([^"]+)", (kDatei_\w+), sizeof\(kDatei_\w+\)\},/g,
  )) {
    eintraege.push({ pfad: treffer[1]!, typ: treffer[2]!, laenge: groessen.get(treffer[3]!) ?? 0 });
  }
  return eintraege;
}

describe('Dashboard kommt vom Sensor', () => {
  // jsdom erlaubt kein Überschreiben von location; ein Objekt mit den
  // beiden Feldern reicht der Funktion aber.
  const setzeOrt = (protocol: string, hostname: string) => {
    vi.stubGlobal('location', { protocol, hostname });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('erkennt die Auslieferung durch den ESP32', () => {
    setzeOrt('http:', 'ruder-sensor.local');
    expect(laeuftAufSensor()).toBe(true);

    setzeOrt('http:', '192.168.1.50');
    expect(laeuftAufSensor()).toBe(true);
  });

  it('verwechselt den Entwicklungsserver nicht mit dem Sensor', () => {
    setzeOrt('http:', 'localhost');
    expect(laeuftAufSensor()).toBe(false);

    setzeOrt('http:', '127.0.0.1');
    expect(laeuftAufSensor()).toBe(false);
  });

  it('nimmt bei https keine Auslieferung durch den Sensor an', () => {
    // Der Sensor spricht nur ws://. Eine https-Seite kann ihn nicht
    // erreichen – dort also nichts automatisch verbinden.
    setzeOrt('https:', 'ruder-sensor.local');
    expect(laeuftAufSensor()).toBe(false);
  });
});

describe.skipIf(!existsSync(HEADER))('Dateiliste der Firmware', () => {
  const eintraege = existsSync(HEADER) ? liesEintraege() : [];

  it('wird gefunden', () => {
    expect(eintraege.length).toBeGreaterThan(0);
  });

  it('enthält alles, was die Seite braucht', () => {
    const pfade = eintraege.map((e) => e.pfad);
    expect(pfade).toContain('index.html');
    expect(pfade.some((p) => p.endsWith('.js'))).toBe(true);
    expect(pfade.some((p) => p.endsWith('.css'))).toBe(true);
    expect(pfade).toContain('brand/web/logo-mark-light.png');
  });

  it('verweist auf Dateien, die es auch gibt', () => {
    // Jeder Verweis in index.html muss eingebettet sein, sonst fehlt im
    // Studio ein Skript oder ein Bild.
    const index = eintraege.find((e) => e.pfad === 'index.html');
    expect(index).toBeDefined();
    const html = readFileSync(
      join(process.cwd(), 'firmware/ruder_sensor/include/dashboard_assets.h'),
      'utf8',
    );
    const start = html.indexOf('static const uint8_t kDatei_index_html[] PROGMEM = {');
    const ende = html.indexOf('};', start);
    const bytes = (html.slice(start, ende).match(/0x[0-9a-f]{2}/g) ?? []).map((h) =>
      parseInt(h, 16),
    );
    const seite = String.fromCharCode(...bytes);

    const verweise = [...seite.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]!);
    for (const verweis of verweise) {
      expect(eintraege.map((e) => e.pfad)).toContain(verweis);
    }
  });

  it('bleibt im Flash-Budget', () => {
    // Die App-Partition hat rund 1,3 MB, die Firmware braucht ~580 kB.
    // 400 kB ist reichlich Luft – ein Versehen (Druckdateien eingebettet)
    // fällt damit sofort auf.
    const summe = eintraege.reduce((s, e) => s + e.laenge, 0);
    expect(summe).toBeLessThan(400 * 1024);
    expect(summe).toBeGreaterThan(10 * 1024);
  });

  it('hat für jede Datei einen Inhaltstyp', () => {
    for (const e of eintraege) {
      expect(e.typ).toMatch(/^[a-z]+\/[\w.+-]+/);
    }
  });
});

describe('Start vom Sensor weg', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /** Stub für WebSocket, der die Verbindung sofort öffnet. */
  class SofortOffen {
    static url = '';
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(url: string) {
      SofortOffen.url = url;
      setTimeout(() => this.onopen?.(), 0);
    }
    close(): void {
      this.onclose?.();
    }
    send(): void {
      /* nichts */
    }
  }

  it('verbindet beim ersten Start ohne Eingabe mit dem Sensor', async () => {
    localStorage.clear();
    vi.stubGlobal('location', { protocol: 'http:', hostname: 'ruder-sensor.local' });
    vi.stubGlobal('WebSocket', SofortOffen as unknown as typeof WebSocket);

    const controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    await controller.init();

    // Genau das ist der Unterschied: kein Tippen am Tablet.
    expect(controller.activeSource).toBe('ws');
    expect(SofortOffen.url).toBe('ws://ruder-sensor.local:81/');
    controller.dispose();
  });

  it('lässt eine gespeicherte Auswahl in Ruhe', async () => {
    localStorage.setItem('ruder.settings.v1', JSON.stringify({ source: 'demo' }));
    vi.stubGlobal('location', { protocol: 'http:', hostname: 'ruder-sensor.local' });

    const controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    await controller.init();

    expect(controller.activeSource).toBe('demo');
    controller.dispose();
  });

  it('startet auf dem Entwicklungsserver weiter im Demo-Modus', async () => {
    localStorage.clear();
    vi.stubGlobal('location', { protocol: 'http:', hostname: 'localhost' });

    const controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    await controller.init();

    expect(controller.activeSource).toBe('demo');
    controller.dispose();
  });
});
