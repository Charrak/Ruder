import { describe, expect, it } from 'vitest';
import { DeviceClock, LineFramer, parseSensorMessage } from '../src/input/protocol';

describe('parseSensorMessage', () => {
  it('liest alle dokumentierten Nachrichten', () => {
    expect(parseSensorMessage('I')).toEqual({ kind: 'impulse', deviceMs: null });
    expect(parseSensorMessage('impulse')).toEqual({ kind: 'impulse', deviceMs: null });
    expect(parseSensorMessage('P,48213')).toEqual({ kind: 'impulse', deviceMs: 48213 });
    expect(parseSensorMessage('B,17,48213')).toEqual({ kind: 'hello', bootId: 17, deviceMs: 48213 });
    expect(parseSensorMessage('S,-67,2,17.5')).toEqual({
      kind: 'status',
      rssi: -67,
      clients: 2,
      pulsesPerSec: 17.5,
    });
    expect(parseSensorMessage('T,3d')).toBeNull();
    expect(parseSensorMessage('T,3.2')).toEqual({ kind: 'pulseWidth', ms: 3.2 });
  });

  it('kommt mit Windows-Zeilenenden und Leerzeichen zurecht', () => {
    expect(parseSensorMessage('  P,1200 \r')).toEqual({ kind: 'impulse', deviceMs: 1200 });
  });

  it('wertet eine nackte Zahl als Gerätezeit (ältere Firmware)', () => {
    expect(parseSensorMessage('1234.5')).toEqual({ kind: 'impulse', deviceMs: 1234.5 });
  });

  it('verwirft unvollständige Nachrichten', () => {
    expect(parseSensorMessage('P')).toEqual({ kind: 'impulse', deviceMs: null });
    expect(parseSensorMessage('P,abc')).toEqual({ kind: 'impulse', deviceMs: null });
    expect(parseSensorMessage('B,17')).toBeNull();
    expect(parseSensorMessage('S')).toEqual({ kind: 'status', rssi: null, clients: null, pulsesPerSec: null });
  });
});

describe('DeviceClock', () => {
  it('bildet Gerätezeit auf Browserzeit ab', () => {
    const clock = new DeviceClock();
    // Gerät 1000 ms, empfangen bei 5000 ms -> Versatz 4000 ms
    expect(clock.toHost(1000, 5000)).toBe(5000);
    expect(clock.calibrated).toBe(true);
    expect(clock.toHost(2000, 5900)).toBeCloseTo(6000, -1);
  });

  it('führt langsame Drift nach, statt zu springen', () => {
    const clock = new DeviceClock(0.02);
    clock.toHost(0, 5000); // Versatz 5000
    // Netzwerk jittert 40 ms nach hinten
    const mapped = clock.toHost(1000, 6040);
    expect(mapped).toBeGreaterThan(5990);
    expect(mapped).toBeLessThan(6020);
  });

  it('übernimmt große Sprünge hart (Reboot ohne Bootkennung)', () => {
    const clock = new DeviceClock();
    clock.toHost(10_000, 20_000);
    // Gerät startet neu: millis() wieder klein
    expect(clock.toHost(50, 30_000)).toBe(30_000);
  });

  it('setzt bei neuer Bootkennung neu auf', () => {
    const clock = new DeviceClock();
    clock.toHost(10_000, 20_000, 1);
    clock.toHost(100, 40_000, 2);
    expect(clock.toHost(200, 40_100, 2)).toBeCloseTo(40_100, -1);
  });
});

describe('LineFramer', () => {
  it('setzt Zeilen aus gestückelten Chunks zusammen', () => {
    const framer = new LineFramer();
    expect(framer.push('P,12')).toEqual([]);
    expect(framer.push('00\nB,1,9')).toEqual(['P,1200']);
    expect(framer.push('999\r\n')).toEqual(['B,1,9999']);
  });

  it('verwirft überlange Daten ohne Zeilenende', () => {
    const framer = new LineFramer(32);
    expect(framer.push('x'.repeat(100))).toEqual([]);
    expect(framer.push('\nI\n')).toEqual(['', 'I']);
  });
});
