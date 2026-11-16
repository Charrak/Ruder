import { describe, expect, it } from 'vitest';
import { formatDelta, formatDistance, formatNumber, formatPace, formatSeconds } from '../src/core/format';
import { Session } from '../src/core/session';
import { parseSensorMessage } from '../src/input/protocol';

describe('Formatierung', () => {
  it('formatiert Split-Zeiten mit Zehntel und Komma', () => {
    expect(formatSeconds(105)).toBe('1:45,0');
    expect(formatSeconds(105.44)).toBe('1:45,4');
    expect(formatSeconds(65.9)).toBe('1:05,9');
  });

  it('formatiert lange Zeiten mit Stunden', () => {
    expect(formatSeconds(3725)).toBe('1:02:05,0');
    expect(formatSeconds(3725, { tenths: false })).toBe('1:02:05');
  });

  it('zeigt fehlende Werte als Platzhalter', () => {
    expect(formatPace(null)).toBe('–:––,–');
    expect(formatPace(Number.POSITIVE_INFINITY)).toBe('–:––,–');
  });

  it('kennzeichnet schnellere Splits als gut', () => {
    expect(formatDelta(-1.24)).toEqual({ text: '−1,2', good: true });
    expect(formatDelta(0.44)).toEqual({ text: '+0,4', good: false });
    expect(formatDelta(0)).toEqual({ text: '±0,0', good: true });
  });

  it('formatiert Strecke und Zahlen mit Tausenderpunkt', () => {
    expect(formatDistance(5432.7)).toBe('5.433 m');
    expect(formatNumber(12.34, 1)).toBe('12,3');
  });
});

describe('Session', () => {
  const running = (distance: number, pace: number | null = 125) => ({
    moving: true,
    distanceM: distance,
    paceSecPer500: pace,
    powerW: 200,
    spm: 24,
  });

  it('zählt nur bewegte Zeit', () => {
    const session = new Session({ kind: 'free' });
    session.start(0);
    session.tick(1000, running(0));
    session.tick(2000, { ...running(0), moving: false });
    session.tick(3000, running(5));
    expect(session.elapsedMs).toBe(2000);
  });

  it('legt Splits alle 500 m an', () => {
    const session = new Session({ kind: 'free' });
    session.start(0);
    // 2,5 m/s => 500 m nach 200 s
    for (let t = 1000; t <= 210_000; t += 1000) {
      session.tick(t, running(2.5 * (t / 1000)));
    }
    expect(session.splitsList.length).toBeGreaterThan(0);
    const first = session.splitsList[0]!;
    expect(first.endDistanceM).toBe(500);
    expect(first.splitSec).toBeCloseTo(200, 0);
  });

  it('beendet ein Distanz-Training am Ziel', () => {
    const session = new Session({ kind: 'distance', distanceM: 500 });
    session.start(0);
    session.tick(10_000, running(400));
    expect(session.isFinished).toBe(false);
    session.tick(20_000, running(510));
    expect(session.isFinished).toBe(true);
  });

  it('beendet ein Zeit-Training nach Ablauf', () => {
    const session = new Session({ kind: 'time', durationSec: 60 });
    session.start(0);
    session.tick(30_000, running(100));
    expect(session.isFinished).toBe(false);
    session.tick(60_500, running(200));
    expect(session.isFinished).toBe(true);
  });

  it('projiziert die Endzeit aus dem aktuellen Schnitt', () => {
    const session = new Session({ kind: 'distance', distanceM: 2000 });
    session.start(0);
    session.tick(5000, running(100));
    expect(session.projectedFinishMs(100)).toBeCloseTo(100_000, -2);
  });
});

describe('Sensor-Protokoll', () => {
  it('liest reine Impulsmarker', () => {
    expect(parseSensorMessage('I')).toEqual({ kind: 'impulse', deviceMs: null });
    expect(parseSensorMessage('P,99.5')).toEqual({ kind: 'impulse', deviceMs: 99.5 });
  });

  it('ignoriert Leerzeilen und Kommentare', () => {
    expect(parseSensorMessage('')).toBeNull();
    expect(parseSensorMessage('   ')).toBeNull();
    expect(parseSensorMessage('# debug')).toBeNull();
  });

  it('meldet unbekannte Zeilen, ohne zu werfen', () => {
    expect(parseSensorMessage('boot ok')).toEqual({ kind: 'unknown', raw: 'boot ok' });
  });

  it('akzeptiert Dezimalpunkt und ganzzahlige Werte', () => {
    expect(parseSensorMessage('P,12.5')).toEqual({ kind: 'impulse', deviceMs: 12.5 });
    expect(parseSensorMessage('P,1250')).toEqual({ kind: 'impulse', deviceMs: 1250 });
    // Komma trennt Felder, nicht Nachkommastellen im Protokoll
    expect(parseSensorMessage('P,12,5')).toEqual({ kind: 'impulse', deviceMs: 12 });
  });
});
