// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { RowerController, type Frame } from '../src/core/controller';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RowerController (Demo-Sensor)', () => {
  let controller: RowerController | null = null;

  afterEach(() => {
    controller?.dispose();
    controller = null;
  });

  it('erzeugt aus dem Demo-Sensor laufende Live-Werte', async () => {
    const frames: Frame[] = [];
    const states: string[] = [];
    controller = new RowerController({
      onFrame: (frame) => frames.push(frame),
      onStatus: () => undefined,
      onSession: (state) => states.push(state),
    });
    await controller.init();
    controller.start();
    expect(states).toContain('running');

    await sleep(2500);

    const last = frames.at(-1);
    expect(last).toBeDefined();
    expect(frames.length).toBeGreaterThan(20);
    expect(last!.snapshot.distanceM).toBeGreaterThan(5);
    expect(last!.snapshot.paceSecPer500).toBeGreaterThan(100);
    expect(last!.snapshot.paceSecPer500).toBeLessThan(160);
    expect(last!.session.elapsedMs).toBeGreaterThan(1000);
    expect(last!.heartRate.bpm).toBeGreaterThan(60);
  }, 20_000);

  it('erkennt im Demo-Betrieb Schläge und zeigt einen Split', async () => {
    const frames: Frame[] = [];
    controller = new RowerController({
      onFrame: (frame) => frames.push(frame),
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    await controller.init();
    controller.start();
    await sleep(6000);

    const last = frames.at(-1);
    expect(last!.snapshot.strokeRateSpm).toBeGreaterThan(18);
    expect(last!.snapshot.strokeRateSpm).toBeLessThan(30);
    expect(last!.snapshot.powerW).toBeGreaterThan(80);
    expect(last!.snapshot.distanceM).toBeGreaterThan(15);
  }, 20_000);

  it('pausiert, ohne Strecke weiterzuzählen', async () => {
    controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    await controller.init();
    controller.start();
    await sleep(1200);
    controller.pause();
    await sleep(300);
    const distanceAtPause = controller.engine.distanceM;
    const timeAtPause = controller.session.elapsedMs;
    await sleep(700);
    expect(controller.engine.distanceM).toBeCloseTo(distanceAtPause, 0);
    expect(controller.session.elapsedMs).toBe(timeAtPause);
  }, 20_000);

  it('setzt die Session vollständig zurück', async () => {
    controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    await controller.init();
    controller.start();
    await sleep(900);
    controller.reset();
    expect(controller.engine.distanceM).toBe(0);
    expect(controller.session.elapsedMs).toBe(0);
    expect(controller.session.splitsList.length).toBe(0);
  }, 20_000);

  it('fällt bei fehlgeschlagener Verbindung auf Demo zurück', async () => {
    const statuses: string[] = [];
    controller = new RowerController({
      onFrame: () => undefined,
      onStatus: (status) => statuses.push(`${status.source}:${status.connected}`),
      onSession: () => undefined,
    });
    await controller.init();
    // WebSocket auf einen toten Port: muss fehlschlagen und Demo nachziehen
    await controller.switchSource('ws', { url: 'ws://127.0.0.1:9/' });
    expect(controller.activeSource).toBe('demo');
    expect(statuses.some((s) => s.startsWith('demo:true'))).toBe(true);
  }, 20_000);

  it('ignoriert Impulse, solange nicht gestartet wurde', async () => {
    controller = new RowerController({
      onFrame: () => undefined,
      onStatus: () => undefined,
      onSession: () => undefined,
    });
    await controller.init();
    await sleep(800);
    expect(controller.engine.distanceM).toBe(0);
  }, 20_000);

  it('meldet fehlendes Web Serial verständlich', async () => {
    // Browser ohne Web Serial: Property existiert gar nicht
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'serial');
    const statuses: string[] = [];
    controller = new RowerController({
      onFrame: () => undefined,
      onStatus: (status) => statuses.push(status.message),
      onSession: () => undefined,
    });
    await controller.init();
    await controller.switchSource('serial');
    expect(statuses.some((m) => m.includes('nicht unterstützt'))).toBe(true);
    expect(controller.activeSource).toBe('demo');
  }, 20_000);
});
