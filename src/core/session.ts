/**
 * Trainings-Session: Zeit, Strecken, Splits und Zielverfolgung.
 *
 * Ein Split ist ein 500-m-Abschnitt (Standard beim Rudern). Für jede
 * abgeschlossene Distanz wird die Zeit gespeichert, damit das Dashboard
 * "letzter Split" und die Differenz zum vorherigen zeigen kann.
 */

import { paceForWatts } from './engine';

export type WorkoutKind = 'free' | 'distance' | 'time';

export interface Workout {
  kind: WorkoutKind;
  /** Ziel-Distanz in Metern (kind === 'distance'). */
  distanceM?: number;
  /** Ziel-Zeit in Sekunden (kind === 'time'). */
  durationSec?: number;
}

export interface Split {
  index: number;
  /** Distanz am Ende des Splits in Metern. */
  endDistanceM: number;
  /** Zeit am Ende des Splits in ms. */
  endTimeMs: number;
  /** Dauer dieses Splits in Sekunden. */
  splitSec: number;
  /** Split auf 500 m für diesen Abschnitt. */
  paceSecPer500: number;
}

export interface SessionSample {
  t: number;
  paceSecPer500: number;
  powerW: number;
  spm: number;
}

export const SPLIT_DISTANCE_M = 500;

export class Session {
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private movingMs = 0;
  private lastTickAt: number | null = null;
  private splits: Split[] = [];
  private samples: SessionSample[] = [];
  private lastSampleAt = 0;
  workout: Workout;

  constructor(workout: Workout = { kind: 'free' }) {
    this.workout = workout;
  }

  private paused = false;

  get isRunning(): boolean {
    return this.startedAt !== null && this.finishedAt === null && !this.paused;
  }

  pause(now: number): void {
    if (this.startedAt === null || this.finishedAt !== null) return;
    this.paused = true;
    this.lastTickAt = now;
  }

  resume(now: number): void {
    if (this.startedAt === null || this.finishedAt !== null) return;
    this.paused = false;
    this.lastTickAt = now;
  }

  get isFinished(): boolean {
    return this.finishedAt !== null;
  }

  start(now: number): void {
    this.startedAt = now;
    this.finishedAt = null;
    this.movingMs = 0;
    this.lastTickAt = now;
  }

  /** Setzt die Session zurück und startet sie nicht neu. */
  reset(): void {
    this.startedAt = null;
    this.finishedAt = null;
    this.paused = false;
    this.movingMs = 0;
    this.lastTickAt = null;
    this.splits = [];
    this.samples = [];
    this.lastSampleAt = 0;
  }

  get elapsedMs(): number {
    return this.movingMs;
  }

  get splitsList(): readonly Split[] {
    return this.splits;
  }

  get samplesList(): readonly SessionSample[] {
    return this.samples;
  }

  /**
   * Wird bei jedem Frame aufgerufen. `moving` entscheidet, ob die Uhr
   * weiterläuft (Pausen zählen nicht in die Nettotrainingszeit).
   */
  tick(now: number, state: { moving: boolean; distanceM: number; paceSecPer500: number | null; powerW: number; spm: number }): void {
    if (this.startedAt === null || this.finishedAt !== null) {
      this.lastTickAt = now;
      return;
    }
    const previous = this.lastTickAt ?? now;
    const delta = Math.max(0, now - previous);
    this.lastTickAt = now;
    if (state.moving) this.movingMs += delta;

    this.captureSplit(now, state.distanceM);
    this.captureSample(now, state);

    if (this.workout.kind === 'distance' && this.workout.distanceM && state.distanceM >= this.workout.distanceM) {
      this.finishedAt = now;
    }
    if (this.workout.kind === 'time' && this.workout.durationSec && this.movingMs >= this.workout.durationSec * 1000) {
      this.finishedAt = now;
    }
  }

  private captureSplit(now: number, distanceM: number): void {
    const completed = Math.floor(distanceM / SPLIT_DISTANCE_M);
    while (this.splits.length < completed) {
      const index = this.splits.length + 1;
      const previousEnd = this.splits.at(-1)?.endTimeMs ?? 0;
      this.splits.push({
        index,
        endDistanceM: index * SPLIT_DISTANCE_M,
        endTimeMs: this.movingMs,
        splitSec: (this.movingMs - previousEnd) / 1000,
        paceSecPer500: (this.movingMs - previousEnd) / 1000,
      });
      void now;
      if (this.splits.length > 60) this.splits.shift();
    }
  }

  private captureSample(now: number, state: { paceSecPer500: number | null; powerW: number; spm: number }): void {
    if (now - this.lastSampleAt < 500) return;
    this.lastSampleAt = now;
    if (state.paceSecPer500 === null) return;
    this.samples.push({
      t: this.movingMs,
      paceSecPer500: state.paceSecPer500,
      powerW: state.powerW,
      spm: state.spm,
    });
    if (this.samples.length > 1200) this.samples.shift();
  }

  /** Aktueller (unvollständiger) Split auf 500 m. */
  currentSplitSeconds(distanceM: number): number | null {
    const completedDistance = this.splits.length * SPLIT_DISTANCE_M;
    const partial = distanceM - completedDistance;
    if (partial <= 5) return null;
    const previousEnd = this.splits.at(-1)?.endTimeMs ?? 0;
    const partialMs = this.movingMs - previousEnd;
    if (partialMs <= 0) return null;
    return (partialMs / 1000) * (SPLIT_DISTANCE_M / partial);
  }

  /** Prognostizierte Endzeit, wenn Distanz-Ziel gesetzt ist. */
  projectedFinishMs(distanceM: number): number | null {
    const target = this.workout.distanceM;
    if (this.workout.kind !== 'distance' || !target || distanceM < 20 || this.movingMs < 3000) return null;
    const pace = this.movingMs / distanceM; // ms pro Meter
    return pace * target;
  }

  /** Prognostizierte Gesamtdistanz, wenn Zeit-Ziel gesetzt ist. */
  projectedDistance(distanceM: number): number | null {
    const target = this.workout.durationSec;
    if (this.workout.kind !== 'time' || !target || this.movingMs < 3000) return null;
    const speed = distanceM / (this.movingMs / 1000);
    return speed * target;
  }

  lastSplit(): Split | null {
    return this.splits.at(-1) ?? null;
  }

  previousSplit(): Split | null {
    const n = this.splits.length;
    return n >= 2 ? this.splits[n - 2]! : null;
  }

  splitDelta(): number | null {
    const last = this.lastSplit();
    const previous = this.previousSplit();
    if (!last || !previous) return null;
    return last.splitSec - previous.splitSec;
  }
}

/** Zieltempo als Split, wenn eine Zielzeit über eine Distanz vorgegeben ist. */
export function targetPace(targetDistanceM: number, targetTimeSec: number): number {
  return (targetTimeSec / targetDistanceM) * 500;
}

/** Durchschnittsleistung für einen Split. */
export function averagePowerForPace(paceSecPer500: number): number {
  return paceForWatts(paceSecPer500);
}
