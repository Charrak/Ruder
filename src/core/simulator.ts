/**
 * Ruder-Simulator für Demos und Entwicklung ohne Hardware.
 *
 * Er erzeugt genau das, was der echte Sensor liefert: die Zeitpunkte der
 * Magnetimpulse. Das Modell hat eine Durchzug- und eine Erholungsphase, in
 * der das Schwungrad beschleunigt bzw. durch den Luftwiderstand abbremst —
 * dadurch entstehen die typischen Abstandssprünge, aus denen die Engine den
 * Schlaganfang erkennt.
 */

import { DISTANCE_PER_REV, PULSES_PER_REV } from './engine';

export interface SimulatorOptions {
  /** Schlagzahl pro Minute. */
  spm?: number;
  /** Ziel-Split auf 500 m in Sekunden. */
  paceSecPer500?: number;
  /** Anteil des Durchzugs am Zyklus (Concept2: ca. 0,35–0,40). */
  driveFraction?: number;
  /** Verhältnis Spitzen- zu Minimal-Winkelgeschwindigkeit. */
  velocityRatio?: number;
}

export class RowerSimulator {
  spm: number;
  paceSecPer500: number;
  driveFraction: number;
  velocityRatio: number;
  /** Streuung der Schlagdauer, damit es nicht zu perfekt aussieht. */
  jitter = 0.03;

  private angle = 0;
  private omega = 0;
  private cycleTime = 0;
  private cycleLength = 0;
  private driveTime = 0;
  private phase: 'drive' | 'recovery' = 'drive';
  private nextPulseIndex = 1;
  private lastStepAt: number | null = null;
  private seeded = 1;

  constructor(options: SimulatorOptions = {}) {
    this.spm = options.spm ?? 24;
    this.paceSecPer500 = options.paceSecPer500 ?? 128;
    this.driveFraction = options.driveFraction ?? 0.38;
    this.velocityRatio = options.velocityRatio ?? 1.32;
    this.updateCycle();
  }

  private random(): number {
    // xorshift32 – deterministisch, aber ausreichend unregelmäßig
    let x = this.seeded;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seeded = x >>> 0 || 1;
    return (this.seeded % 100_000) / 100_000;
  }

  /**
   * Mittlere Winkelgeschwindigkeit so wählen, dass die aus den Impuls-
   * abständen gemessene Geschwindigkeit dem Ziel-Split entspricht.
   *
   * Bei einem dreieckförmigen Verlauf von omega ist
   *   mean(1/omega) = ln(r) / (wMin * (r - 1)),  r = wMax / wMin
   * und die gemessene Geschwindigkeit ist 2,5 m / (2*pi * mean(1/omega)).
   */
  private rateRange(): { wMin: number; wMax: number } {
    const speed = 500 / this.paceSecPer500;
    const meanInvOmega = DISTANCE_PER_REV / (2 * Math.PI * speed);
    const r = this.velocityRatio;
    const wMin = Math.log(r) / ((r - 1) * meanInvOmega);
    return { wMin, wMax: wMin * r };
  }

  private updateCycle(): void {
    const base = 60_000 / this.spm;
    this.cycleLength = base * (1 + (this.random() - 0.5) * 2 * this.jitter);
    this.driveTime = this.cycleLength * this.driveFraction;
    this.cycleTime = 0;
    this.phase = 'drive';
  }

  /**
   * Integriert die Bewegung bis `now` und liefert alle Impulszeitpunkte,
   * die in diesem Fenster aufgetreten sind.
   */
  advance(now: number): number[] {
    const events: number[] = [];
    if (this.lastStepAt === null) {
      this.lastStepAt = now;
      this.omega = this.rateRange().wMin;
      return events;
    }

    const dt = 1; // ms
    let t = this.lastStepAt;
    while (t < now) {
      t = Math.min(now, t + dt);
      this.integrate(t, events);
    }
    this.lastStepAt = now;
    return events;
  }

  private integrate(t: number, events: number[]): void {
    const { wMin, wMax } = this.rateRange();

    this.cycleTime += 1;
    if (this.cycleTime >= this.cycleLength) {
      this.updateCycle();
    }

    const progress = this.cycleTime / this.driveTime;
    if (progress <= 1) {
      this.phase = 'drive';
      this.omega = wMin + (wMax - wMin) * Math.min(1, progress);
    } else {
      this.phase = 'recovery';
      const rec = Math.min(1, (this.cycleTime - this.driveTime) / (this.cycleLength - this.driveTime));
      this.omega = wMax - (wMax - wMin) * rec;
    }

    this.angle += (this.omega * 1) / 1000;
    const step = (2 * Math.PI) / PULSES_PER_REV;
    while (this.angle >= this.nextPulseIndex * step) {
      events.push(t);
      this.nextPulseIndex += 1;
    }
    // Winkel periodisch halten, Impulsindex mitführen
    if (this.nextPulseIndex > 1_000_000) {
      this.nextPulseIndex -= 1_000_000;
      this.angle -= 1_000_000 * step;
    }
    void this.phase;
  }

  reset(): void {
    this.angle = 0;
    this.omega = 0;
    this.cycleTime = 0;
    this.nextPulseIndex = 1;
    this.lastStepAt = null;
  }
}
