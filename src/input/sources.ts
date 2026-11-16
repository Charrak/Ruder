/**
 * Impulsquellen.
 *
 * Das Dashboard interessiert sich nur für Zeitstempel einzelner
 * Magnetimpulse. Woher sie kommen, ist austauschbar:
 *
 *  - DemoSensor:      Simulator, damit die Anzeige ohne Gerät läuft
 *  - SerialSensor:    ESP32 am USB-Port (Web Serial)
 *  - WebSocketSensor: ESP32 im WLAN, mit automatischem Wiederverbinden
 *
 * Das Zeilenformat ist in `protocol.ts` beschrieben. Beide Sensoren
 * übersetzen Gerätezeit in die Zeitachse des Browsers, damit die
 * Schlag-Erkennung unabhängig von der Übertragungsverzögerung funktioniert.
 */

import { DeviceClock, LineFramer, parseSensorMessage } from './protocol';

export interface SensorCallbacks {
  onImpulse: (timestampMs: number) => void;
  /** Verbindungszustand; `detail` ist eine Meldung für die Anzeige. */
  onState?: (state: SensorState, detail?: string) => void;
  /** Zusatzdaten für die Diagnose (WLAN-Pegel, Sensordiagnose). */
  onTelemetry?: (telemetry: SensorTelemetry) => void;
}

export type SensorState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SensorTelemetry {
  rssi: number | null;
  clients: number | null;
  pulsesPerSec: number | null;
  pulseWidthMs: number | null;
  clockCalibrated: boolean;
  lastMessageAt: number | null;
}

export interface ImpulseSource {
  readonly label: string;
  start(callbacks: SensorCallbacks): Promise<void>;
  stop(): Promise<void>;
}

/** Simulierter Sensor – läuft in Echtzeit, liefert echte Impulsabstände. */
export class DemoSensor implements ImpulseSource {
  readonly label = 'Demo';
  private timer: number | null = null;

  constructor(private readonly sample: (now: number) => number[]) {}

  async start(callbacks: SensorCallbacks): Promise<void> {
    await this.stop();
    callbacks.onState?.('open', 'Demo-Sensor');
    const step = () => {
      const now = performance.now();
      for (const at of this.sample(now)) callbacks.onImpulse(at);
      this.timer = window.setTimeout(step, 25);
    };
    this.timer = window.setTimeout(step, 25);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}

interface SerialLineSourceOptions {
  baudRate?: number;
}

/**
 * Web Serial: liest die ASCII-Zeilen des ESP32 am USB-Port.
 * Nice-to-have für die Werkbank; im Studio läuft der WLAN-Weg.
 */
export class SerialSensor implements ImpulseSource {
  readonly label = 'ESP32 (USB)';
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;
  private readonly decoder = new TextDecoder();
  private readonly framer = new LineFramer();
  private readonly clock = new DeviceClock();
  private callbacks: SensorCallbacks | null = null;
  private bootId: number | null = null;
  private telemetry: SensorTelemetry = emptyTelemetry();

  constructor(private readonly options: SerialLineSourceOptions = {}) {}

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.serial?.requestPort === 'function';
  }

  getTelemetry(): SensorTelemetry {
    return this.telemetry;
  }

  async start(callbacks: SensorCallbacks): Promise<void> {
    if (!SerialSensor.supported) {
      throw new Error('Web Serial wird von diesem Browser nicht unterstützt (Chrome/Edge am Desktop nutzen)');
    }
    this.callbacks = callbacks;
    callbacks.onState?.('connecting', 'Port auswählen …');

    const port = await navigator.serial.requestPort();
    this.port = port;
    await port.open({ baudRate: this.options.baudRate ?? 115200 });
    this.closing = false;
    this.framer.reset();
    this.clock.reset();
    callbacks.onState?.('open', 'ESP32 über USB');

    this.readLoop(callbacks).catch((error: unknown) => {
      if (this.closing) return;
      callbacks.onState?.('closed', 'USB-Verbindung unterbrochen');
      console.error('[serial] Lesefehler', error);
    });
  }

  private async readLoop(callbacks: SensorCallbacks): Promise<void> {
    const port = this.port;
    if (!port?.readable) return;
    const reader = port.readable.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const line of this.framer.push(this.decoder.decode(value, { stream: true }))) {
          this.handleLine(line, callbacks.onImpulse);
        }
      }
    } finally {
      reader.releaseLock();
      this.reader = null;
    }
  }

  private handleLine(line: string, onImpulse: (timestampMs: number) => void): void {
    const message = parseSensorMessage(line);
    if (!message) return;
    const now = performance.now();
    this.telemetry.lastMessageAt = now;

    switch (message.kind) {
      case 'impulse': {
        const stamp =
          message.deviceMs === null
            ? now
            : this.clock.toHost(message.deviceMs, now, this.bootId);
        this.telemetry.clockCalibrated = this.clock.calibrated;
        onImpulse(stamp);
        break;
      }
      case 'hello':
        this.bootId = message.bootId;
        this.clock.reset();
        this.clock.toHost(message.deviceMs, now, message.bootId);
        this.telemetry.clockCalibrated = this.clock.calibrated;
        break;
      case 'status':
        this.telemetry.rssi = message.rssi;
        this.telemetry.clients = message.clients;
        this.telemetry.pulsesPerSec = message.pulsesPerSec;
        this.callbacks?.onTelemetry?.(this.telemetry);
        break;
      case 'pulseWidth':
        this.telemetry.pulseWidthMs = message.ms;
        this.callbacks?.onTelemetry?.(this.telemetry);
        break;
      default:
        break;
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* Reader war schon geschlossen */
    }
    try {
      await this.port?.close();
    } catch {
      /* Port war schon zu */
    }
    this.port = null;
    this.callbacks?.onState?.('closed');
    this.callbacks = null;
  }
}

export interface WebSocketSourceOptions {
  url: string;
  /** Wartezeit vor dem ersten Wiederverbinden in ms. */
  retryBaseMs?: number;
  /** Obergrenze für die Wartezeit zwischen zwei Versuchen. */
  retryMaxMs?: number;
  /** Nach so langer Stille gilt die Verbindung als tot. */
  silenceTimeoutMs?: number;
}

/**
 * WebSocket-Sensor für den ESP32 im WLAN.
 *
 * Im Studio hängt das Tablet an der Wand – die Verbindung darf nicht
 * stehenbleiben, nur weil der ESP32 einmal neu startet oder das WLAN
 * kurz wegbricht. Deshalb: automatisches Wiederverbinden mit
 * exponentiellem Backoff, Wachhund gegen stille Verbindungen und
 * eine Statusmeldung, die auch sagt, was los ist.
 */
export class WebSocketSensor implements ImpulseSource {
  readonly label = 'ESP32 (WLAN)';
  private socket: WebSocket | null = null;
  private callbacks: SensorCallbacks | null = null;
  private retryTimer: number | null = null;
  private silenceTimer: number | null = null;
  private attempt = 0;
  private stopped = true;
  private readonly framer = new LineFramer();
  private readonly clock = new DeviceClock();
  private bootId: number | null = null;
  private telemetry: SensorTelemetry = emptyTelemetry();
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly silenceTimeoutMs: number;

  constructor(private readonly options: WebSocketSourceOptions) {
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.retryMaxMs = options.retryMaxMs ?? 10_000;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 8000;
  }

  get url(): string {
    return this.options.url;
  }

  getTelemetry(): SensorTelemetry {
    return this.telemetry;
  }

  async start(callbacks: SensorCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.stopped = false;
    this.attempt = 0;
    await this.connect();
  }

  private connect(): Promise<void> {
    const callbacks = this.callbacks;
    if (!callbacks || this.stopped) return Promise.resolve();

    callbacks.onState?.(this.attempt === 0 ? 'connecting' : 'reconnecting', this.options.url);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.options.url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Ungültige WebSocket-Adresse'));
        return;
      }
      this.socket = socket;
      this.framer.reset();

      socket.onopen = () => {
        settled = true;
        this.attempt = 0;
        this.clock.reset();
        callbacks.onState?.('open', `ESP32 im WLAN (${this.options.url})`);
        this.armWatchdog();
        resolve();
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        this.armWatchdog();
        const now = performance.now();
        for (const line of this.framer.push(String(event.data))) {
          this.handleLine(line, now, callbacks.onImpulse);
        }
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`Verbindung zu ${this.options.url} fehlgeschlagen`));
        }
      };

      socket.onclose = () => {
        this.disarmWatchdog();
        this.socket = null;
        if (this.stopped) {
          resolve();
          return;
        }
        if (!settled) {
          settled = true;
          reject(new Error(`Verbindung zu ${this.options.url} fehlgeschlagen`));
        }
        this.scheduleRetry();
      };
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    this.attempt += 1;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.attempt - 1, 6));
    const seconds = Math.round(delay / 100) / 10;
    this.callbacks?.onState?.(
      'reconnecting',
      `Verbindung verloren – neuer Versuch in ${seconds.toString().replace('.', ',')} s`,
    );
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect().catch(() => {
        /* onclose des Fehlversuchs plant den nächsten Versuch ein */
      });
    }, delay);
  }

  private armWatchdog(): void {
    this.disarmWatchdog();
    this.silenceTimer = window.setTimeout(() => {
      // Stille Verbindung: harter Neustart, sonst bleibt die Anzeige stehen
      this.callbacks?.onState?.('reconnecting', 'Sensor meldet sich nicht');
      this.socket?.close();
    }, this.silenceTimeoutMs);
  }

  private disarmWatchdog(): void {
    if (this.silenceTimer !== null) window.clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private handleLine(line: string, now: number, onImpulse: (timestampMs: number) => void): void {
    const message = parseSensorMessage(line);
    if (!message) return;
    this.telemetry.lastMessageAt = now;

    switch (message.kind) {
      case 'impulse': {
        const stamp =
          message.deviceMs === null ? now : this.clock.toHost(message.deviceMs, now, this.bootId);
        this.telemetry.clockCalibrated = this.clock.calibrated;
        onImpulse(stamp);
        break;
      }
      case 'hello':
        this.bootId = message.bootId;
        this.clock.reset();
        this.clock.toHost(message.deviceMs, now, message.bootId);
        this.telemetry.clockCalibrated = this.clock.calibrated;
        break;
      case 'status':
        this.telemetry.rssi = message.rssi;
        this.telemetry.clients = message.clients;
        this.telemetry.pulsesPerSec = message.pulsesPerSec;
        this.callbacks?.onTelemetry?.(this.telemetry);
        break;
      case 'pulseWidth':
        this.telemetry.pulseWidthMs = message.ms;
        this.callbacks?.onTelemetry?.(this.telemetry);
        break;
      default:
        break;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.disarmWatchdog();
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    this.callbacks?.onState?.('closed');
    this.callbacks = null;
  }
}

function emptyTelemetry(): SensorTelemetry {
  return {
    rssi: null,
    clients: null,
    pulsesPerSec: null,
    pulseWidthMs: null,
    clockCalibrated: false,
    lastMessageAt: null,
  };
}

declare global {
  interface SerialPort {
    readonly readable: ReadableStream<Uint8Array> | null;
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
  }
  interface SerialPortRequestOptions {
    filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
  }
  interface Serial {
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
  }
  interface Navigator {
    readonly serial: Serial;
  }
}
