import { RowerEngine, type EngineSnapshot } from '../core/engine';
import { RowerSimulator } from '../core/simulator';
import { Session, targetPace, type Workout } from '../core/session';
import {
  DemoSensor,
  SerialSensor,
  WebSocketSensor,
  type ImpulseSource,
  type SensorCallbacks,
  type SensorState,
  type SensorTelemetry,
} from '../input/sources';
import { HeartRateMonitor, HeartRateSimulator, type HeartRateReading } from '../input/heartRate';

export type SourceKind = 'demo' | 'serial' | 'ws';

const SETTINGS_KEY = 'ruder.settings.v1';

interface StoredSettings {
  source: SourceKind;
  url: string;
  dragFactor: number;
}

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
  /** Verbindungszustand der gewählten Quelle. */
  state: SensorState;
  telemetry: SensorTelemetry | null;
  /** Adresse/Port der aktiven Quelle, für die Diagnose. */
  endpoint: string | null;
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
  private fallback: DemoSensor | null = null;
  private telemetry: SensorTelemetry | null = null;
  private preferredSource: SourceKind = 'demo';
  private preferredUrl = '';
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
    this.status = {
      source: 'demo',
      connected: false,
      message: 'Demo-Sensor',
      dragFactor: 120,
      state: 'closed',
      telemetry: null,
      endpoint: null,
    };
  }

  get activeSource(): SourceKind {
    return this.status.source;
  }

  async init(): Promise<void> {
    const gespeichert = this.restoreSettings();
    // Kommt die Seite vom ESP32, ist der Sensor die naheliegende Quelle:
    // niemand soll am Tablet erst eine Adresse eintippen müssen.
    if (!gespeichert && laeuftAufSensor()) {
      this.preferredSource = 'ws';
    }
    await this.switchSource(this.preferredSource, this.preferredUrl ? { url: this.preferredUrl } : {});
    this.loop();
  }

  /** Merkt sich Sensorwahl und Adresse, damit das Tablet nach einem Neustart weiterläuft. */
  private restoreSettings(): boolean {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return false;
      const stored = JSON.parse(raw) as Partial<StoredSettings>;
      if (stored.source === 'demo' || stored.source === 'serial' || stored.source === 'ws') {
        this.preferredSource = stored.source;
      }
      if (typeof stored.url === 'string' && stored.url !== '') {
        this.preferredUrl = stored.url;
        this.wsUrl = stored.url;
      }
      if (typeof stored.dragFactor === 'number') {
        this.engine.setDragFactor(stored.dragFactor);
        this.status.dragFactor = this.engine.getDragFactor();
      }
      return true;
    } catch {
      /* kaputter Speicherinhalt darf den Start nicht verhindern */
      return false;
    }
  }

  private persistSettings(): void {
    try {
      const payload: StoredSettings = {
        source: this.status.source,
        url: this.wsUrl,
        dragFactor: this.engine.getDragFactor(),
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
    } catch {
      /* privater Modus o. Ä. */
    }
  }

  /** Aktueller Verbindungsstatus inkl. Diagnosewerten (für die Einstellungen). */
  getStatus(): Status {
    return this.status;
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
    this.persistSettings();
    this.events.onStatus(this.status);
  }

  setWorkout(workout: Workout): void {
    this.session.workout = workout;
  }

  /**
   * Wechselt die Impulsquelle.
   *
   * `url` wird gemerkt, damit das Dashboard nach einem Neustart des ESP32
   * oder nach dem Zurückwechseln aus dem Demo-Modus ohne erneute Eingabe
   * wieder verbindet.
   */
  async switchSource(kind: SourceKind, options: { url?: string; baudRate?: number } = {}): Promise<void> {
    if (options.url) this.wsUrl = options.url;
    if (options.baudRate) this.baudRate = options.baudRate;

    await this.source?.stop().catch(() => undefined);
    this.source = null;
    this.telemetry = null;

    let next: ImpulseSource;
    let endpoint: string;
    if (kind === 'serial') {
      next = new SerialSensor({ baudRate: this.baudRate });
      endpoint = `USB ${this.baudRate} Baud`;
    } else if (kind === 'ws') {
      const url = this.wsUrl || defaultSocketUrl();
      this.wsUrl = url;
      next = new WebSocketSensor({ url });
      endpoint = url;
    } else {
      next = new DemoSensor((now) => this.simulator.advance(now));
      this.simulator.reset();
      endpoint = 'Demo';
    }

    const callbacks: SensorCallbacks = {
      onImpulse: (timestamp) => this.handleImpulse(timestamp),
      onState: (state, detail) => this.handleSensorState(kind, endpoint, state, detail),
      onTelemetry: (telemetry) => {
        this.telemetry = telemetry;
        this.status = { ...this.status, telemetry };
        this.events.onStatus(this.status);
      },
    };

    try {
      await next.start(callbacks);
    } catch (error) {
      const message = describeInputError(error);
      // Auf Demo zurückfallen, damit die Anzeige nie tot ist – die Ursache
      // aber sichtbar lassen.
      if (kind !== 'demo') {
        await this.switchSource('demo');
        this.status = {
          ...this.status,
          connected: false,
          message: `${message} – Demo aktiv`,
          state: 'closed',
        };
        this.events.onStatus(this.status);
      }
      return;
    }

    this.source = next;
    this.persistSettings();
    this.events.onStatus(this.status);
  }

  /** Hält den Verbindungsstatus aktuell, auch bei Abbrüchen mitten im Betrieb. */
  private handleSensorState(
    kind: SourceKind,
    endpoint: string,
    state: SensorState,
    detail?: string,
  ): void {
    const connected = state === 'open';
    if (connected) this.stopDemoFallback();
    const base = detail ?? endpoint;
    const suffix =
      state === 'reconnecting' ? '' : connected ? '' : kind === 'demo' ? '' : ' – Demo aktiv';
    this.status = {
      ...this.status,
      source: kind,
      connected,
      state,
      endpoint,
      message: `${base}${suffix}`,
      dragFactor: this.engine.getDragFactor(),
      telemetry: this.telemetry,
    };

    // Ein Abbruch der echten Quelle darf das Dashboard nicht einfrieren:
    // solange nicht verbunden, liefert der Demo-Sensor weiter Bewegung.
    if (!connected && state === 'reconnecting') {
      this.startDemoFallback();
    }
    this.events.onStatus(this.status);
  }

  /**
   * Hält die Anzeige am Leben, wenn der Sensor im Betrieb wegbricht. Der
   * Demo-Sensor läuft dann nur, bis die echte Quelle wieder verbindet –
   * erkennbar an der Statusmeldung, nicht an stillen Werten.
   */
  private startDemoFallback(): void {
    if (this.fallback) return;
    const demo = new DemoSensor((now) => this.simulator.advance(now));
    this.fallback = demo;
    void demo.start({ onImpulse: (t) => this.handleImpulse(t) });
  }

  private stopDemoFallback(): void {
    if (!this.fallback) return;
    void this.fallback.stop();
    this.fallback = null;
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
  // Bei http- und https-Seiten ist location.port leer, dann gilt 81.
  // Kommt die Seite vom ESP32 selbst (Port 80), ist das dieselbe Adresse.
  return `${protocol}//${location.hostname}:81/`;
}

/**
 * Läuft die Seite auf dem Sensor selbst?
 *
 * Der ESP32 liefert das Dashboard unter Port 80 aus, der Sensor hängt unter
 * Port 81 derselben Adresse. In diesem Fall ist die Adresse bekannt: das
 * Tablet braucht keine Eingabe, und das Dashboard verbindet beim ersten
 * Start von allein – ohne Einstellung, ohne Tippen.
 */
export function laeuftAufSensor(host: string = location.hostname): boolean {
  // http://ruder-sensor.local/ oder http://192.168.1.50/
  return host !== '' && host !== 'localhost' && host !== '127.0.0.1' &&
    location.protocol === 'http:';
}
