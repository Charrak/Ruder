import { RowerEngine, type EngineSnapshot } from '../core/engine';
import { RowerSimulator } from '../core/simulator';
import { Session, targetPace, type Workout } from '../core/session';
import { DemoSensor, SerialSensor, WebSocketSensor, type ImpulseSource } from '../input/sources';
import { HeartRateMonitor, HeartRateSimulator, type HeartRateReading } from '../input/heartRate';

export type SourceKind = 'demo' | 'serial' | 'ws';

export interface ControllerEvents {
  onFrame: (frame: Frame) => void;
  onStatus: (status: Status) => void;
  onSession: (state: 'idle' | 'running' | 'paused' | 'finished') => void;
}

export interface Frame {
  now: number;
  snapshot: EngineSnapshot;
  session: Session;
  strokePhase: { phase: 'drive' | 'recovery'; progress: number };
  targetPace: number | null;
  heartRate: { bpm: number | null; source: 'demo' | 'strap'; deviceName: string | null };
  summary: SessionSummary | null;
}

export interface SessionSummary {
  elapsedMs: number;
  distanceM: number;
  avgPaceSecPer500: number | null;
  avgPowerW: number;
  avgSpm: number;
  avgHeartRate: number | null;
  caloriesKcal: number;
  splits: number;
}

export interface Status {
  source: SourceKind;
  connected: boolean;
  message: string;
  dragFactor: number;
}

export class RowerController {
  readonly engine: RowerEngine;
  readonly session: Session;
  readonly simulator: RowerSimulator;

  private source: ImpulseSource | null = null;
  private paused = true;
  private started = false;
  private lastStrokeAt: number | null = null;
  private rafId: number | null = null;
  private events: ControllerEvents;
  private status: Status;
  private wsUrl = '';
  private baudRate = 115200;
  private hrMonitor = new HeartRateMonitor();
  private hrSimulator = new HeartRateSimulator();
  private hrSource: 'demo' | 'strap' = 'demo';
  private hrBpm: number | null = null;
  private hrDeviceName: string | null = null;
  private hrSamples: number[] = [];
  private summary: SessionSummary | null = null;
  private lastBpmSampleAt = 0;

  constructor(events: ControllerEvents) {
    this.events = events;
    this.engine = new RowerEngine({ dragFactor: 120 });
    this.session = new Session({ kind: 'free' });
    this.simulator = new RowerSimulator({ spm: 24, paceSecPer500: 128 });
    this.status = { source: 'demo', connected: false, message: 'Demo-Sensor', dragFactor: 120 };
  }

  get activeSource(): SourceKind {
    return this.status.source;
  }

  async init(): Promise<void> {
    await this.switchSource('demo');
    this.loop();
  }

  /** Brustgurt über Web Bluetooth verbinden. */
  async connectStrap(): Promise<string> {
    const name = await this.hrMonitor.connect(
      (reading: HeartRateReading) => this.handleHeartRate(reading),
      () => {
        this.hrSource = 'demo';
        this.hrDeviceName = null;
        this.events.onStatus(this.status);
      },
    );
    this.hrSource = 'strap';
    this.hrDeviceName = name;
    return name;
  }

  async disconnectStrap(): Promise<void> {
    await this.hrMonitor.disconnect();
    this.hrSource = 'demo';
    this.hrDeviceName = null;
    this.hrBpm = null;
  }

  private handleHeartRate(reading: HeartRateReading): void {
    this.hrBpm = reading.bpm;
    this.hrSamples.push(reading.bpm);
    if (this.hrSamples.length > 2000) this.hrSamples.shift();
  }

  private updateDemoHeartRate(now: number, powerW: number, moving: boolean): void {
    const previous = this.lastBpmSampleAt;
    this.lastBpmSampleAt = now;
    if (previous === 0) return;
    const dt = Math.min(5, (now - previous) / 1000);
    this.hrBpm = this.hrSimulator.update(powerW, moving, dt);
    this.hrSamples.push(this.hrBpm);
    if (this.hrSamples.length > 2000) this.hrSamples.shift();
  }

  /** Simulator-Tempo manuell verstellen (Demo). */
  setDemoEffort(spm: number, paceSecPer500: number): void {
    this.simulator.spm = spm;
    this.simulator.paceSecPer500 = paceSecPer500;
  }

  setDragFactor(value: number): void {
    this.engine.setDragFactor(value);
    this.status.dragFactor = value;
    this.events.onStatus(this.status);
  }

  setWorkout(workout: Workout): void {
    this.session.workout = workout;
  }

  async switchSource(kind: SourceKind, options: { url?: string; baudRate?: number } = {}): Promise<void> {
    if (options.url) this.wsUrl = options.url;
    if (options.baudRate) this.baudRate = options.baudRate;

    await this.source?.stop().catch(() => undefined);
    this.source = null;

    let next: ImpulseSource;
    if (kind === 'serial') {
      next = new SerialSensor({ baudRate: this.baudRate });
    } else if (kind === 'ws') {
      next = new WebSocketSensor(this.wsUrl || defaultSocketUrl());
    } else {
      next = new DemoSensor((now) => this.simulator.advance(now));
      this.simulator.reset();
    }

    try {
      await next.start((t) => this.handleImpulse(t));
      this.source = next;
      this.status = {
        source: kind,
        connected: true,
        message: kind === 'demo' ? 'Demo-Sensor' : next.label,
        dragFactor: this.engine.getDragFactor(),
      };
    } catch (error) {
      const message = describeInputError(error);
      // Auf Demo zurückfallen, damit die Anzeige nie tot ist – die Ursache
      // aber sichtbar lassen.
      await this.switchSource('demo');
      this.status = {
        source: 'demo',
        connected: false,
        message: `${message} – Demo aktiv`,
        dragFactor: this.engine.getDragFactor(),
      };
      this.events.onStatus(this.status);
      return;
    }
    this.events.onStatus(this.status);
  }

  private handleImpulse(timestamp: number): void {
    if (this.paused) {
      // In der Pause werden Impulse verworfen, damit weder Strecke noch
      // Schlagzahl weiterlaufen. Die bereits gefahrene Strecke bleibt
      // erhalten – verworfen wird nur der Impuls, nicht der Stand.
      this.lastStrokeAt = null;
      return;
    }
    const { strokeStarted } = this.engine.impulse(timestamp);
    if (strokeStarted) this.lastStrokeAt = timestamp;
  }

  start(): void {
    if (this.session.isFinished) this.reset();
    const now = performance.now();
    if (!this.started) {
      this.engine.reset();
      this.simulator.reset();
      this.session.start(now);
      this.started = true;
    } else {
      this.session.resume(now);
    }
    this.paused = false;
    // Engine-Clock nachziehen, damit die Pausendauer nicht als Bewegung
    // in Leistung oder Strecke einfließt.
    this.engine.resetClock(now);
    this.events.onSession('running');
  }

  pause(): void {
    this.paused = true;
    this.session.pause(performance.now());
    this.events.onSession('paused');
  }

  toggle(): void {
    if (this.paused) this.start();
    else this.pause();
  }

  private buildSummary(): SessionSummary {
    const elapsedMs = this.session.elapsedMs;
    const distanceM = this.engine.distanceM;
    const avgPace = distanceM > 10 ? (elapsedMs / 1000 / distanceM) * 500 : null;
    const samples = this.session.samplesList;
    const avgPowerW = samples.length
      ? Math.round(samples.reduce((sum, s) => sum + s.powerW, 0) / samples.length)
      : 0;
    const avgSpm = samples.length
      ? Math.round((samples.reduce((sum, s) => sum + s.spm, 0) / samples.length) * 10) / 10
      : 0;
    const avgHeartRate = this.hrSamples.length
      ? Math.round(this.hrSamples.reduce((a, b) => a + b, 0) / this.hrSamples.length)
      : null;

    return {
      elapsedMs,
      distanceM,
      avgPaceSecPer500: avgPace,
      avgPowerW,
      avgSpm,
      avgHeartRate,
      caloriesKcal: Math.round(this.engine.caloriesKcal),
      splits: this.session.splitsList.length,
    };
  }

  reset(): void {
    this.paused = true;
    this.started = false;
    this.summary = null;
    this.hrSamples = [];
    this.lastBpmSampleAt = 0;
    this.hrSimulator.reset();
    this.lastStrokeAt = null;
    this.engine.reset();
    this.session.reset();
    this.simulator.reset();
    this.events.onSession('idle');
  }

  private loop(): void {
    const step = () => {
      this.rafId = requestAnimationFrame(step);
      const now = performance.now();
      const snapshot = this.engine.snapshot(now);
      this.session.tick(now, {
        moving: !this.paused && snapshot.state === 'moving',
        distanceM: snapshot.distanceM,
        paceSecPer500: snapshot.paceSecPer500,
        powerW: snapshot.powerW,
        spm: snapshot.strokeRateSpm,
      });
      if (this.session.isFinished && !this.paused) {
        this.paused = true;
        this.summary = this.buildSummary();
        this.events.onSession('finished');
      }

      if (this.hrSource === 'demo') {
        this.updateDemoHeartRate(now, snapshot.powerW, !this.paused && snapshot.state === 'moving');
      }

      const workout = this.session.workout;
      const target =
        workout.kind === 'distance' && workout.distanceM && workout.durationSec
          ? targetPace(workout.distanceM, workout.durationSec)
          : null;

      this.events.onFrame({
        now,
        snapshot,
        session: this.session,
        strokePhase: this.computeStrokePhase(now, snapshot.strokeRateSpm),
        targetPace: target,
        heartRate: {
          bpm: this.hrBpm,
          source: this.hrSource,
          deviceName: this.hrDeviceName,
        },
        summary: this.summary,
      });
    };
    this.rafId = requestAnimationFrame(step);
  }

  private computeStrokePhase(now: number, spm: number): { phase: 'drive' | 'recovery'; progress: number } {
    if (this.lastStrokeAt === null || spm <= 0) return { phase: 'drive', progress: 0 };
    const cycle = 60_000 / spm;
    const elapsed = now - this.lastStrokeAt;
    const driveShare = 0.38;
    const driveMs = cycle * driveShare;
    if (elapsed < driveMs) {
      return { phase: 'drive', progress: Math.min(1, elapsed / driveMs) };
    }
    return { phase: 'recovery', progress: Math.min(1, (elapsed - driveMs) / (cycle - driveMs)) };
  }

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    void this.source?.stop();
  }
}

/** Übersetzt technische Fehler in verständliche Meldungen fürs Studio. */
export function describeInputError(error: unknown): string {
  if (!(error instanceof Error)) return 'Verbindung fehlgeschlagen';
  const name = (error as { name?: string }).name ?? '';
  if (name === 'NotFoundError') return 'Kein Gerät ausgewählt';
  if (name === 'SecurityError') return 'Zugriff verweigert – Seite muss über HTTPS laufen';
  if (name === 'NetworkError') return 'Gerät nicht erreichbar';
  if (name === 'InvalidStateError') return 'Gerät ist bereits in Verwendung';
  if (/websocket|connection/i.test(error.message)) return 'Verbindung zum Sensor fehlgeschlagen';
  return error.message;
}

function defaultSocketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.hostname}:81/`;
}
