import { describe, expect, it } from 'vitest';
import { heartRateZone, parseHeartRateMeasurement } from '../src/input/heartRate';

function view(bytes: number[]): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

describe('Heart-Rate-Measurement (Bluetooth SIG)', () => {
  it('liest 8-Bit-Werte', () => {
    // Flags 0x00: uint8, kein Kontakt-Flag
    const reading = parseHeartRateMeasurement(view([0x00, 142]), 1000);
    expect(reading).toMatchObject({ bpm: 142, contact: null, at: 1000 });
  });

  it('liest 16-Bit-Werte', () => {
    // Flags 0x01: uint16 little endian -> 0x012c = 300 ist unplausibel
    expect(parseHeartRateMeasurement(view([0x01, 0x2c, 0x01]), 0)).toBeNull();
    // 0x00a4 = 164
    expect(parseHeartRateMeasurement(view([0x01, 0xa4, 0x00]), 0)?.bpm).toBe(164);
  });

  it('erkennt den Kontakt-Status', () => {
    // Flags 0x06: Kontakt unterstützt + erkannt, uint8
    expect(parseHeartRateMeasurement(view([0x06, 120]), 0)?.contact).toBe(true);
    // Flags 0x04: Kontakt unterstützt, aber nicht erkannt
    expect(parseHeartRateMeasurement(view([0x04, 120]), 0)?.contact).toBe(false);
  });

  it('liest den Energieverbrauch', () => {
    // Flags 0x08 (Energie vorhanden) + uint8
    const reading = parseHeartRateMeasurement(view([0x08, 110, 0x2c, 0x01]), 0);
    expect(reading?.energyKj).toBe(300);
  });

  it('verwirft unplausible oder zu kurze Pakete', () => {
    expect(parseHeartRateMeasurement(view([0x00]), 0)).toBeNull();
    expect(parseHeartRateMeasurement(view([0x00, 0]), 0)).toBeNull();
    expect(parseHeartRateMeasurement(view([0x01, 0x10]), 0)).toBeNull();
    expect(parseHeartRateMeasurement(view([0x00, 255]), 0)?.bpm).toBe(255);
  });
});

describe('Trainingszonen', () => {
  it('ordnet die Herzfrequenz Zonen zu', () => {
    expect(heartRateZone(100, 180).zone).toBe(0);
    expect(heartRateZone(120, 180)).toMatchObject({ zone: 1, label: 'Grundlage' });
    expect(heartRateZone(140, 180)).toMatchObject({ zone: 2, label: 'Aerob' });
    expect(heartRateZone(155, 180)).toMatchObject({ zone: 3, label: 'Schwelle' });
    expect(heartRateZone(166, 180)).toMatchObject({ zone: 4, label: 'Hart' });
    expect(heartRateZone(175, 180)).toMatchObject({ zone: 5, label: 'Maximal' });
  });
});
