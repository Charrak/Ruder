/**
 * Herzfrequenz.
 *
 * Unterstützt Brustgurte nach dem Standard-GATT-Profil "Heart Rate"
 * (Service 0x180D, Characteristic 0x2A37) über Web Bluetooth — das können
 * Garmin HRM, Polar H10, Wahoo TICKR, Billig-Gurte von Amazon usw.
 * Ein Brustgurt liefert im Studio die verlässlicheren Werte; optische
 * Sensoren am Handgelenk springen beim Rudern zu stark.
 */

const HEART_RATE_SERVICE = 0x180d;
const HEART_RATE_MEASUREMENT = 0x2a37;

export interface HeartRateReading {
  bpm: number;
  /** Sensor meldet Hautkontakt (wenn das Gerät das unterstützt). */
  contact: boolean | null;
  /** Energieverbrauch laut Sensor in kJ, falls übertragen. */
  energyKj: number | null;
  at: number;
}

export class HeartRateMonitor {
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private handler: ((reading: HeartRateReading) => void) | null = null;
  private onDisconnect: (() => void) | null = null;

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.bluetooth?.requestDevice === 'function';
  }

  get connected(): boolean {
    return this.characteristic !== null;
  }

  get deviceName(): string | null {
    return this.device?.name ?? null;
  }

  async connect(
    onReading: (reading: HeartRateReading) => void,
    onDisconnect?: () => void,
  ): Promise<string> {
    if (!HeartRateMonitor.supported) {
      throw new Error('Web Bluetooth wird von diesem Browser nicht unterstützt (Chrome/Edge nutzen)');
    }
    await this.disconnect();

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HEART_RATE_SERVICE] }],
      optionalServices: [HEART_RATE_SERVICE],
    });
    this.device = device;
    this.handler = onReading;
    this.onDisconnect = onDisconnect ?? null;

    device.addEventListener('gattserverdisconnected', () => {
      this.characteristic = null;
      this.onDisconnect?.();
    });

    const server = await device.gatt?.connect();
    if (!server) throw new Error('GATT-Server nicht erreichbar.');
    const service = await server.getPrimaryService(HEART_RATE_SERVICE);
    const characteristic = await service.getCharacteristic(HEART_RATE_MEASUREMENT);
    this.characteristic = characteristic;

    characteristic.addEventListener('characteristicvaluechanged', (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic;
      if (!target.value) return;
      const reading = parseHeartRateMeasurement(target.value, performance.now());
      if (reading) this.handler?.(reading);
    });

    await characteristic.startNotifications();
    return device.name ?? 'Herzfrequenzgurt';
  }

  async disconnect(): Promise<void> {
    try {
      const device = this.device;
      this.characteristic = null;
      this.handler = null;
      this.onDisconnect = null;
      if (device?.gatt?.connected) device.gatt.disconnect();
    } catch {
      /* Gurt war schon weg */
    }
    this.device = null;
  }
}

/**
 * Parst das Heart-Rate-Measurement-Paket (Bluetooth SIG).
 * Flags-Byte: Bit0 = 0 -> uint8, 1 -> uint16; Bit1/Bit2 = Sensor-Kontakt.
 */
export function parseHeartRateMeasurement(
  data: DataView,
  at: number,
): HeartRateReading | null {
  if (data.byteLength < 2) return null;
  const flags = data.getUint8(0);
  const isUint16 = (flags & 0x01) !== 0;
  if (isUint16 && data.byteLength < 3) return null;

  const bpm = isUint16 ? data.getUint16(1, true) : data.getUint8(1);
  if (!Number.isFinite(bpm) || bpm <= 0 || bpm > 260) return null;

  const contactSupported = (flags & 0x04) !== 0;
  const contactDetected = (flags & 0x02) !== 0;
  const contact = contactSupported ? contactDetected : null;

  let energyKj: number | null = null;
  if (flags & 0x08 && data.byteLength >= (isUint16 ? 5 : 4)) {
    energyKj = data.getUint16(isUint16 ? 3 : 2, true);
  }

  return { bpm, contact, energyKj, at };
}

export interface ZoneInfo {
  /** 1..5, 0 = unter Zone 1 */
  zone: number;
  label: string;
  color: string;
}

/** Trainingszonen nach Prozent der maximalen Herzfrequenz. */
export function heartRateZone(bpm: number, maxHr = 180): ZoneInfo {
  const pct = (bpm / maxHr) * 100;
  if (pct < 60) return { zone: 0, label: 'Regeneration', color: '#8fb3c9' };
  if (pct < 70) return { zone: 1, label: 'Grundlage', color: '#7fd4ff' };
  if (pct < 80) return { zone: 2, label: 'Aerob', color: '#b5e900' };
  if (pct < 88) return { zone: 3, label: 'Schwelle', color: '#ffc44d' };
  if (pct < 94) return { zone: 4, label: 'Hart', color: '#ff8a4d' };
  return { zone: 5, label: 'Maximal', color: '#ff6b57' };
}

/** Simulierte Herzfrequenz, die der Leistung träge folgt (Demo-Modus). */
export class HeartRateSimulator {
  private hr = 78;

  constructor(private readonly maxHr = 180) {}

  get bpm(): number {
    return Math.round(this.hr);
  }

  update(powerW: number, moving: boolean, dtSeconds: number): number {
    const target = moving ? 88 + Math.min(1, powerW / 320) * (this.maxHr - 108) : 72;
    // Anstieg deutlich schneller als Abfall – wie beim echten Körper
    const rate = target > this.hr ? 0.09 : 0.045;
    this.hr += (target - this.hr) * Math.min(1, rate * dtSeconds);
    return Math.round(this.hr);
  }

  reset(): void {
    this.hr = 78;
  }
}

declare global {
  interface BluetoothRemoteGATTCharacteristic extends EventTarget {
    readonly value: DataView | null;
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  }
  interface BluetoothRemoteGATTServer {
    readonly connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: number): Promise<BluetoothRemoteGATTService>;
  }
  interface BluetoothRemoteGATTService {
    getCharacteristic(characteristic: number): Promise<BluetoothRemoteGATTCharacteristic>;
  }
  interface BluetoothDevice extends EventTarget {
    readonly name?: string;
    readonly gatt?: BluetoothRemoteGATTServer;
  }
  interface Bluetooth {
    requestDevice(options: {
      filters?: Array<{ services: number[] }>;
      optionalServices?: number[];
    }): Promise<BluetoothDevice>;
  }
  interface Navigator {
    readonly bluetooth: Bluetooth;
  }
}
