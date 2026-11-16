/**
 * Impulsquellen.
 *
 * Das Dashboard interessiert sich nur für Zeitstempel einzelner
 * Magnetimpulse. Woher sie kommen, ist austauschbar:
 *
 *  - DemoSensor:     Simulator, damit die Anzeige ohne Gerät läuft
 *  - SerialSensor:   ESP32 am USB-Port (Web Serial), Zeilen wie "1234.5"
 *                    oder "P,1234.5"
 *  - WebSocketSensor: ESP32 im WLAN, das dieselben Zeilen schickt
 */

export interface ImpulseSource {
  readonly label: string;
  start(onImpulse: (timestampMs: number) => void): Promise<void>;
  stop(): Promise<void>;
}

/** Simulierter Sensor – läuft in Echtzeit, liefert echte Impulsabstände. */
export class DemoSensor implements ImpulseSource {
  readonly label = 'Demo';
  private timer: number | null = null;

  constructor(private readonly sample: (now: number) => number[]) {}

  async start(onImpulse: (timestampMs: number) => void): Promise<void> {
    await this.stop();
    const step = () => {
      const now = performance.now();
      for (const at of this.sample(now)) onImpulse(at);
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
  /** Protokoll: "raw" = nur Zeitstempel, "elapsed" = Host-Zeit beim Empfang. */
  mode?: 'device-time' | 'host-time';
}

/**
 * Web Serial: liest ASCII-Zeilen vom ESP32.
 *
 * Unterstützte Formate pro Zeile:
 *   "1234.5"        -> Gerätezeit in ms (mode: device-time)
 *   "P,1234.5"      -> Impuls mit Gerätezeit
 *   "I"             -> Impuls, Host-Zeit wird verwendet
 */
export class SerialSensor implements ImpulseSource {
  readonly label = 'ESP32 (USB)';
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(private readonly options: SerialLineSourceOptions = {}) {}

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.serial?.requestPort === 'function';
  }

  async start(onImpulse: (timestampMs: number) => void): Promise<void> {
    if (!SerialSensor.supported) {
      throw new Error('Web Serial wird von diesem Browser nicht unterstützt (Chrome/Edge am Desktop nutzen)');
    }
    const port = await navigator.serial.requestPort();
    this.port = port;
    await port.open({ baudRate: this.options.baudRate ?? 115200 });
    this.closing = false;
    this.readLoop(onImpulse).catch((error: unknown) => {
      if (!this.closing) console.error('[serial] Lesefehler', error);
    });
  }

  private async readLoop(onImpulse: (timestampMs: number) => void): Promise<void> {
    const port = this.port;
    if (!port?.readable) return;
    const reader = port.readable.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.handleChunk(value, onImpulse);
      }
    } finally {
      reader.releaseLock();
      this.reader = null;
    }
  }

  private handleChunk(chunk: Uint8Array, onImpulse: (timestampMs: number) => void): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    const now = performance.now();
    for (const raw of lines) {
      const line = raw.trim();
      if (line === '') continue;
      const value = parseSerialLine(line, now, this.options.mode ?? 'host-time');
      if (value !== null) onImpulse(value);
    }
    if (this.buffer.length > 4096) this.buffer = '';
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
  }
}

/** WebSocket-Sensor für ESP32 im WLAN. */
export class WebSocketSensor implements ImpulseSource {
  readonly label = 'ESP32 (WLAN)';
  private socket: WebSocket | null = null;

  constructor(private readonly url: string) {}

  async start(onImpulse: (timestampMs: number) => void): Promise<void> {
    await this.stop();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`Verbindung zu ${this.url} fehlgeschlagen.`));
      socket.onmessage = (event: MessageEvent<string>) => {
        const now = performance.now();
        for (const line of String(event.data).split(/\r?\n/)) {
          const value = parseSerialLine(line.trim(), now, 'host-time');
          if (value !== null) onImpulse(value);
        }
      };
    });
  }

  async stop(): Promise<void> {
    this.socket?.close();
    this.socket = null;
  }
}

/**
 * Parst eine Sensorzeile.
 * Gibt den Impulszeitpunkt in performance.now()-Koordinaten zurück oder null.
 */
export function parseSerialLine(
  line: string,
  hostTimeMs: number,
  mode: 'device-time' | 'host-time',
): number | null {
  if (line === '') return null;
  const parts = line.split(/[,;\s]+/).filter(Boolean);
  if (parts.length === 0) return null;

  const head = parts[0]!.toUpperCase();
  const isPulseTag = head === 'P' || head === 'I' || head === 'IMPULSE';
  const numberToken = isPulseTag ? parts[1] : parts[0];
  if (numberToken === undefined) {
    // Reiner Marker wie "I" -> Host-Zeit
    return isPulseTag ? hostTimeMs : null;
  }

  const numeric = Number(numberToken.replace(',', '.'));
  if (!Number.isFinite(numeric)) return null;

  if (mode === 'device-time' || numeric > 0) {
    if (mode === 'host-time') return hostTimeMs;
    return toHostClock(numeric);
  }
  return hostTimeMs;
}

/** Gerätezeit in ms -> Performance-Zeitachse. */
function toHostClock(deviceMs: number): number {
  const offset = (performance as Performance & { timeOrigin?: number }).timeOrigin ?? Date.now() - performance.now();
  return deviceMs - (offset % 1_000_000);
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
