import { describe, expect, it } from 'vitest';
import { DISTANCE_PER_REV, PULSES_PER_REV, RowerEngine, paceForWatts, wattsForPace } from '../src/core/engine';
import { RowerSimulator } from '../src/core/simulator';

/** Erzeugt Impulsabstände für eine konstante Geschwindigkeit. */
function constantPulses(speedMps: number, count: number, startAt = 0): number[] {
  const periodMs = (DISTANCE_PER_REV / speedMps / PULSES_PER_REV) * 1000;
  return Array.from({ length: count }, (_, i) => startAt + i * periodMs);
}

describe('Concept2-Beziehungen', () => {
  it('rechnet 1:45,0/500 m auf 300 W', () => {
    expect(wattsForPace(105)).toBeCloseTo(302.34, 1);
    expect(wattsForPace(120)).toBeCloseTo(202.56, 1);
    expect(paceForWatts(wattsForPace(105))).toBeCloseTo(105, 6);
    expect(paceForWatts(302.34)).toBeCloseTo(105, 2);
  });

  it('ist zwischen Leistung und Split umkehrbar', () => {
    for (const pace of [95, 105, 120, 135, 160, 200]) {
      expect(paceForWatts(wattsForPace(pace))).toBeCloseTo(pace, 6);
    }
  });
});

describe('RowerEngine', () => {
  it('leitet aus konstanten Impulsen die richtige Geschwindigkeit ab', () => {
    const engine = new RowerEngine({ dragFactor: 120 });
    const speed = 4.0; // 2:05/500 m
    for (const t of constantPulses(speed, 200)) engine.impulse(t);

    const health = engine.snapshot(engine['lastImpulseAt'] as number);
    expect(health.speedMps).toBeCloseTo(speed, 2);
    expect(health.paceSecPer500).toBeCloseTo(125, 1);
    expect(health.distanceM).toBeGreaterThan(0);
  });

  it('skaliert die Leistung mit dem Drag-Faktor', () => {
    const light = new RowerEngine({ dragFactor: 100 });
    const heavy = new RowerEngine({ dragFactor: 200 });
    for (const t of constantPulses(4.5, 300)) {
      light.impulse(t);
      heavy.impulse(t);
    }
    const now = light['lastImpulseAt'] as number;
    const ratio = heavy.snapshot(now).powerW / light.snapshot(now).powerW;
    expect(ratio).toBeCloseTo(2, 1);
  });

  it('meldet Stillstand ohne neue Impulse', () => {
    const engine = new RowerEngine({ dragFactor: 120 });
    for (const t of constantPulses(4.5, 50)) engine.impulse(t);
    const last = engine['lastImpulseAt'] as number;
    expect(engine.snapshot(last + 100).state).toBe('moving');
    expect(engine.snapshot(last + 3000).state).toBe('idle');
    expect(engine.snapshot(last + 3000).powerW).toBe(0);
  });

  it('ignoriert Prellimpulse unter 20 ms', () => {
    const engine = new RowerEngine({ dragFactor: 120 });
    engine.impulse(1000);
    engine.impulse(1005);
    engine.impulse(1010);
    expect(engine.snapshot(1010).revolutions).toBe(0);
  });

  it('zählt Schwungradumdrehungen und Strecke konsistent', () => {
    const engine = new RowerEngine({ dragFactor: 120 });
    const pulses = constantPulses(4.0, PULSES_PER_REV * 40 + 1);
    for (const t of pulses) engine.impulse(t);
    expect(engine.snapshot(pulses.at(-1)!).revolutions).toBe(40);
    expect(engine.distanceM).toBeCloseTo(40 * DISTANCE_PER_REV, 6);
  });

  it('erkennt Schläge im simulierten Ruderzug', () => {
    const engine = new RowerEngine({ dragFactor: 120 });
    const simulator = new RowerSimulator({ spm: 24, paceSecPer500: 125 });

    let now = 0;
    for (let i = 0; i < 2600; i++) {
      now += 10;
      for (const at of simulator.advance(now)) engine.impulse(at);
    }

    const snap = engine.snapshot(now);
    expect(snap.strokeRateSpm).toBeGreaterThan(21);
    expect(snap.strokeRateSpm).toBeLessThan(27);
    expect(snap.paceSecPer500).toBeGreaterThan(115);
    expect(snap.paceSecPer500).toBeLessThan(136);
    expect(snap.powerW).toBeGreaterThan(100);
  });
});
