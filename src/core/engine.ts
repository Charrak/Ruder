/**
 * Flywheel-Impuls-Engine.
 *
 * Ein Ruderergometer mit Magnetaufnehmer (z. B. Concept2 Model C mit PM2/PM3
 * ohne USB, oder ein ESP32-Umbau) liefert nur eines: den Zeitpunkt, an dem
 * ein Magnet am Sensor vorbeikommt. Aus diesen Impulsabständen lässt sich
 * alles Weitere rekonstruieren:
 *
 *   Impulsabstand  -> Umdrehungsdauer -> Winkelgeschwindigkeit
 *   Winkelgeschw.  -> Leistung (P = c * w^3), Drehzahl, Strecke, Temp
 *   Sprung im Abstand -> Schlaganfang (Catch)
 *
 * Die Kalibrierung ist so gewählt, dass sie bei Drag-Faktor 120 die
 * Concept2-Beziehung zwischen Leistung und 500-m-Split reproduziert
 * (P = 2.80 / v^3, v in m/s).
 */

export const PULSES_PER_REV = 6;
export const DISTANCE_PER_REV = 2.5;

/**
 * c = dragFactor * DRAG_COEFF_PER_DF.
 * Hergeleitet aus: 300 W bei DF 120 entspricht 1:45,0/500 m => 4.7619 m/s.
 * 4.7619 m/s bei 2.5 m/Umdrehung und 6 Impulsen/Umdrehung ergibt
 * w = 11.97 rad/s; c = 300 / w^3 = 0.1749 => 0.1749 / 120 = 0.0014575.
 */
export const DRAG_COEFF_PER_DF = 0.0014575;

/** Unterhalb dieser Leistung gilt das Schwungrad als stehend. */
const IDLE_AFTER_MS = 1500;
/** Impulsabstände unter diesem Wert sind Prellen/Rauschen. */
const MIN_PERIOD_MS = 20;
/** Ein Schlag braucht mindestens so viel Zeit. */
const MIN_STROKE_MS = 550;
/**
 * Anteil des Impulsabstands-Scheitelwerts, den der Abstand unterschreiten
 * muss, damit ein neuer Durchzug beginnt (Hysterese).
 */
const MIN_FALL_RATIO = 0.94;

export interface EngineOptions {
  /** Concept2-Drag-Faktor, typisch 100 (leicht) bis 200 (schwer). */
  dragFactor: number;
  /** Aufnehmer-Impulse pro Schwungradumdrehung. */
  pulsesPerRev?: number;
  /** Weg pro Schwungradumdrehung in Metern. */
  distancePerRev?: number;
}

export interface EngineSnapshot {
  state: 'idle' | 'moving';
  /** Momentanleistung in Watt (geglättet). */
  powerW: number;
  /** Mittel über die letzten ~10 s. */
  powerAvgW: number;
  /** Aktueller Split auf 500 m in Sekunden, null wenn zu langsam. */
  paceSecPer500: number | null;
  /** Geschwindigkeit in m/s. */
  speedMps: number;
  /** Schlagzahl in Schlägen pro Minute. */
  strokeRateSpm: number;
  /** Zähler Schwungradumdrehungen. */
  revolutions: number;
  /** Strecke in Metern. */
  distanceM: number;
  /** Anzahl erkannter Schläge. */
  strokes: number;
  /** Geschätzte Energie in kcal (Gesamt). */
  caloriesKcal: number;
  /** Zeit seit dem letzten Impuls in ms. */
  sinceLastImpulseMs: number;
  /** Winkelgeschwindigkeit in rad/s (für Debug/Anzeige). */
  omegaRadS: number;
}

interface StrokeMark {
  at: number;
}

export class RowerEngine {
  private dragFactor: number;
  private readonly pulsesPerRev: number;
  private readonly distancePerRev: number;

  private lastImpulseAt: number | null = null;
  /** Geglätteter Impulsabstand in ms – nur für die Schlag-Erkennung. */
  private periodEmaMsValue = 0;
  /**
   * Zeitfenster der letzten Impulse. Geschwindigkeit wird als
   * (Impulse / Impulse-pro-Umdrehung * Weg-pro-Umdrehung) / Zeitspanne
   * gerechnet. Das ist bei veränderlicher Drehzahl exakt und nicht durch
   * die Stichprobenverteilung der Abstände verzerrt.
   */
  private pulseWindow: number[] = [];

  private powerEma = 0;
  private powerHistory: Array<{ t: number; p: number }> = [];

  // Schlag-Erkennung über den Verlauf des Impulsabstands:
  // Im Durchzug wird das Schwungrad schneller (Abstand sinkt), in der
  // Erholung langsamer (Abstand steigt). Der Schlaganfang ist das Minimum
  // des Abstands, also der Moment der höchsten Winkelgeschwindigkeit.
  private tracking: 'falling' | 'rising' = 'falling';
  private minPeriod = 0;
  private minAt: number | null = null;
  private maxPeriod = 0;

  private pulses = 0;
  private strokes = 0;
  private strokeMarks: StrokeMark[] = [];
  /** Zuletzt bestimmte Schlagzahl (Median der letzten Intervalle). */
  private strokeRateSpmValue = 0;
  private energyJ = 0;
  private lastEnergyAt: number | null = null;

  constructor(options: EngineOptions) {
    this.dragFactor = options.dragFactor;
    this.pulsesPerRev = options.pulsesPerRev ?? PULSES_PER_REV;
    this.distancePerRev = options.distancePerRev ?? DISTANCE_PER_REV;
  }

  setDragFactor(df: number): void {
    this.dragFactor = Math.min(300, Math.max(40, df));
  }

  getDragFactor(): number {
    return this.dragFactor;
  }

  /** Verschluckt einen Sensorimpuls zum Zeitpunkt `t` (ms, z. B. performance.now()). */
  impulse(t: number): { strokeStarted: boolean } {
    const previous = this.lastImpulseAt;
    this.lastImpulseAt = t;

    if (previous === null) {
      this.pulseWindow = [t];
      this.lastEnergyAt = t;
      return { strokeStarted: false };
    }

    const raw = t - previous;
    if (raw < MIN_PERIOD_MS) return { strokeStarted: false };

    const strokeStarted = this.detectStroke(t, raw);

    this.periodEmaMsValue =
      this.periodEmaMsValue === 0
        ? raw
        : this.periodEmaMsValue + (raw - this.periodEmaMsValue) * 0.35;
    this.pulseWindow.push(t);
    const windowMs = 6000;
    while (this.pulseWindow.length > 2 && t - this.pulseWindow[0]! > windowMs) this.pulseWindow.shift();

    this.pulses += 1;

    // Leistung: P = c * w^3
    const omega = this.omegaFromPeriod(raw);
    const drag = this.dragFactor * DRAG_COEFF_PER_DF;
    const instant = drag * omega ** 3;

    const now = t;
    const alpha = 1 - Math.exp(-raw / 1200); // ~1.2 s Zeitkonstante
    this.powerEma = this.powerEma === 0 ? instant : this.powerEma + (instant - this.powerEma) * alpha;

    this.accumulateEnergy(now);
    this.powerHistory.push({ t: now, p: this.powerEma });
    const cutoff = now - 12_000;
    while (this.powerHistory.length > 0 && this.powerHistory[0]!.t < cutoff) this.powerHistory.shift();

    return { strokeStarted };
  }

  private detectStroke(t: number, rawPeriod: number): boolean {
    if (this.periodEmaMsValue === 0) {
      this.resetTracking(rawPeriod);
      return false;
    }

    if (this.tracking === 'falling') {
      if (rawPeriod < this.minPeriod) {
        this.minPeriod = rawPeriod;
        this.minAt = t;
        return false;
      }
      // Abstand steigt wieder: Minimum gefunden -> Schlaganfang bestätigen.
      this.tracking = 'rising';
      this.maxPeriod = rawPeriod;
      const candidate = this.minAt ?? t;
      const last = this.strokeMarks.at(-1);
      if (last && candidate - last.at < MIN_STROKE_MS) {
        this.resetTracking(rawPeriod);
        return false;
      }
      this.strokes += 1;
      this.strokeMarks.push({ at: candidate });
      if (this.strokeMarks.length > 8) this.strokeMarks.shift();
      this.strokeRateSpmValue = this.computeStrokeRate();
      return true;
    }

    // rising: warten, bis der Abstand deutlich gefallen ist
    if (rawPeriod > this.maxPeriod) this.maxPeriod = rawPeriod;
    const fallen = rawPeriod < this.maxPeriod * MIN_FALL_RATIO;
    if (fallen) {
      this.minPeriod = rawPeriod;
      this.minAt = t;
      this.tracking = 'falling';
    }
    return false;
  }

  private resetTracking(period: number): void {
    this.tracking = 'falling';
    this.minPeriod = period;
    this.minAt = null;
    this.maxPeriod = period;
  }

  private computeStrokeRate(): number {
    const marks = this.strokeMarks;
    if (marks.length < 2) return 0;
    const intervals: number[] = [];
    for (let i = Math.max(1, marks.length - 4); i < marks.length; i++) {
      intervals.push(marks[i]!.at - marks[i - 1]!.at);
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)]!;
    const spm = 60_000 / median;
    return Math.min(60, Math.max(6, spm));
  }

  private omegaFromPeriod(periodMs: number): number {
    const revPeriodSec = (periodMs / 1000) * this.pulsesPerRev;
    return (2 * Math.PI) / revPeriodSec;
  }

  /** Gemessene Geschwindigkeit über das Impulsfenster (m/s). */
  private measuredSpeed(): number {
    const window = this.pulseWindow;
    if (window.length < 2) return 0;
    const first = window[0]!;
    const last = window[window.length - 1]!;
    const spanMs = last - first;
    if (spanMs < 40) return 0;
    const revolutions = (window.length - 1) / this.pulsesPerRev;
    return (revolutions * this.distancePerRev) / (spanMs / 1000);
  }

  /** Winkelgeschwindigkeit aus der gemessenen Geschwindigkeit (rad/s). */
  private measuredOmega(): number {
    return (this.measuredSpeed() * 2 * Math.PI) / this.distancePerRev;
  }

  private accumulateEnergy(now: number): void {
    const previous = this.lastEnergyAt;
    this.lastEnergyAt = now;
    if (previous === null) return;
    this.energyJ += this.powerEma * ((now - previous) / 1000);
  }

  /** Erwartete kcal aus mechanischer Arbeit: Concept2 rechnet mit ~21 % Wirkungsgrad. */
  get caloriesKcal(): number {
    return (this.energyJ / 4184) * 4.2;
  }

  get revolutions(): number {
    return this.pulses / this.pulsesPerRev;
  }

  get distanceM(): number {
    return this.revolutions * this.distancePerRev;
  }

  get speedMps(): number {
    return this.measuredSpeed();
  }

  snapshot(now: number): EngineSnapshot {
    const sinceLast = this.lastImpulseAt === null ? Infinity : now - this.lastImpulseAt;
    const moving = sinceLast < IDLE_AFTER_MS && this.lastImpulseAt !== null;

    const speed = moving ? this.speedMps : 0;
    const power = moving ? this.powerEma : 0;
    const pace = speed > 0.35 ? 500 / speed : null;

    const recent = this.powerHistory.filter((s) => s.t > now - 10_000);
    const powerAvg =
      recent.length > 0 ? recent.reduce((sum, s) => sum + s.p, 0) / recent.length : 0;

    let spm = 0;
    const lastStroke = this.strokeMarks.at(-1);
    if (moving && lastStroke) {
      // Erst wenn ein Schlag deutlich überfällig ist, läuft die Anzeige aus.
      const cycle = this.strokeRateSpmValue > 0 ? 60_000 / this.strokeRateSpmValue : 3000;
      const age = now - lastStroke.at;
      const hold = cycle * 1.6;
      const fade = cycle;
      const decay = age <= hold ? 1 : Math.max(0, 1 - (age - hold) / fade);
      spm = this.strokeRateSpmValue * decay;
    }

    return {
      state: moving ? 'moving' : 'idle',
      powerW: Math.round(power),
      powerAvgW: Math.round(powerAvg),
      paceSecPer500: pace,
      speedMps: speed,
      strokeRateSpm: Math.round(spm * 10) / 10,
      revolutions: Math.floor(this.revolutions),
      distanceM: this.distanceM,
      strokes: this.strokes,
      caloriesKcal: this.caloriesKcal,
      sinceLastImpulseMs: Number.isFinite(sinceLast) ? sinceLast : Number.POSITIVE_INFINITY,
      omegaRadS: this.measuredOmega(),
    };
  }

  /**
   * Setzt nur die Zeitbasis zurück (nach einer Pause), ohne Strecke,
   * Schläge oder Energie zu verlieren.
   */
  resetClock(now: number): void {
    this.lastImpulseAt = null;
    this.periodEmaMsValue = 0;
    this.pulseWindow = [];
    this.tracking = 'falling';
    this.minPeriod = 0;
    this.maxPeriod = 0;
    this.minAt = null;
    this.powerEma = 0;
    this.powerHistory = [];
    this.lastEnergyAt = now;
  }

  reset(): void {
    this.lastImpulseAt = null;
    this.periodEmaMsValue = 0;
    this.pulseWindow = [];
    this.tracking = 'falling';
    this.minPeriod = 0;
    this.maxPeriod = 0;
    this.minAt = null;
    this.powerEma = 0;
    this.powerHistory = [];
    this.pulses = 0;
    this.strokes = 0;
    this.strokeMarks = [];
    this.strokeRateSpmValue = 0;
    this.energyJ = 0;
    this.lastEnergyAt = null;
  }
}

/**
 * Concept2-Beziehung: Leistung aus Split (Sekunden/500 m).
 * P = 2,80 / (Sekunden pro Meter)^3  ->  1:45,0/500 m entspricht ca. 303 W.
 */
export function wattsForPace(paceSecPer500: number): number {
  if (!(paceSecPer500 > 0)) return 0;
  const secPerMetre = paceSecPer500 / 500;
  return 2.8 / secPerMetre ** 3;
}

/** Concept2-Beziehung: Split (Sekunden/500 m) aus Leistung. */
export function paceForWatts(watts: number): number {
  if (watts <= 0) return Number.POSITIVE_INFINITY;
  const metresPerSecond = (watts / 2.8) ** (1 / 3);
  return 500 / metresPerSecond;
}
