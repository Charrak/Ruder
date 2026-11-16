// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { RowerController } from '../src/core/controller';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Pause und Fortsetzen', () => {
  let controller: RowerController | null = null;

  afterEach(() => {
    controller?.dispose();
    controller = null;
  });

  const create = () => {
    controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    return controller;
  };

  it('behält die Strecke beim Pausieren', async () => {
    const c = create();
    await c.init();
    c.start();
    await sleep(1500);
    const before = c.engine.distanceM;
    expect(before).toBeGreaterThan(5);

    c.pause();
    await sleep(400);
    // Keine neuen Impulse, aber auch kein Verlust der gefahrenen Strecke
    expect(c.engine.distanceM).toBeCloseTo(before, 0);
    expect(c.session.elapsedMs).toBeGreaterThan(1000);
  }, 20_000);

  it('zählt nach dem Fortsetzen weiter', async () => {
    const c = create();
    await c.init();
    c.start();
    await sleep(1200);
    c.pause();
    await sleep(200);
    const atPause = c.engine.distanceM;

    c.start(); // setzt fort, ohne zurückzusetzen
    await sleep(1200);
    expect(c.engine.distanceM).toBeGreaterThan(atPause);
  }, 20_000);

  it('setzt erst mit reset() wieder auf null', async () => {
    const c = create();
    await c.init();
    c.start();
    await sleep(1000);
    c.pause();
    c.reset();
    expect(c.engine.distanceM).toBe(0);
    expect(c.session.elapsedMs).toBe(0);
  }, 20_000);
});
