// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeWsUrl } from '../src/ui/dashboard';
import { RowerController } from '../src/core/controller';

describe('normalizeWsUrl', () => {
  it('ergänzt Protokoll und Standardport', () => {
    expect(normalizeWsUrl('192.168.1.50')).toBe('ws://192.168.1.50:81/');
    expect(normalizeWsUrl('ruder-sensor.local')).toBe('ws://ruder-sensor.local:81/');
  });

  it('lässt vollständige Adressen in Ruhe', () => {
    expect(normalizeWsUrl('ws://esp32.local:9000/')).toBe('ws://esp32.local:9000/');
    expect(normalizeWsUrl('wss://ruder.example.org/')).toBe('wss://ruder.example.org/');
  });

  it('weist Unsinn ab', () => {
    expect(normalizeWsUrl('')).toBeNull();
    expect(normalizeWsUrl('   ')).toBeNull();
    expect(normalizeWsUrl('http://example.org')).toBeNull();
  });
});

describe('Einstellungen bleiben erhalten', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('merkt sich Sensor, Adresse und Drag-Faktor', async () => {
    localStorage.setItem(
      'ruder.settings.v1',
      JSON.stringify({ source: 'ws', url: 'ws://192.168.1.50:81/', dragFactor: 145 }),
    );

    const controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    // init() würde eine echte WebSocket-Verbindung versuchen; hier nur die
    // Wiederherstellung prüfen.
    await (controller as unknown as { restoreSettings: () => void }).restoreSettings();

    expect(controller.engine.getDragFactor()).toBe(145);
    controller.dispose();
  });

  it('überlebt kaputten Speicherinhalt', async () => {
    localStorage.setItem('ruder.settings.v1', '{nicht json');
    const controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    expect(() =>
      (controller as unknown as { restoreSettings: () => void }).restoreSettings(),
    ).not.toThrow();
    expect(controller.engine.getDragFactor()).toBe(120);
    controller.dispose();
  });

  it('schreibt den Drag-Faktor zurück', () => {
    const controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    controller.setDragFactor(160);
    const stored = JSON.parse(localStorage.getItem('ruder.settings.v1') ?? '{}');
    expect(stored.dragFactor).toBe(160);
    controller.dispose();
  });
});
