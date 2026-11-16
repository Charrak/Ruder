/**
 * Sensorprotokoll (ESP32 -> Dashboard).
 *
 * Der ESP32 schickt ASCII-Zeilen, eine Nachricht pro Zeile. Alle Nachrichten
 * sind optional – das Dashboard kommt auch mit einem nackten "I" aus, dann
 * wird die Empfangszeit verwendet.
 *
 *   I                       Impuls jetzt (einfachste Form)
 *   P,<t_ms>                Impuls zum Gerätezeitpunkt t_ms (millis())
 *   B,<boot>,<t_ms>         Bootkennung + Gerätezeit, z. B. "B,17,48213"
 *   S,<rssi>,<clients>,<f>  Status: WLAN-Pegel, Zuschauer, Impulse/s
 *   T,<puls_ms>             Pulsweite des Sensors in ms (Diagnose)
 *
 * Zahlen immer mit Dezimalpunkt ("48213.5"), ganzzahlig ohne. Das Komma
 * trennt Felder – deutsche Dezimalkommas sind auf der Leitung mehrdeutig.
 *
 * Warum die Bootkennung: `millis()` startet bei jedem Neustart neu. Das
 * Dashboard erkennt daran einen Reboot und setzt seine Uhrabweichung neu,
 * statt mit einer falschen Zeitachse weiterzurechnen.
 */

export type SensorMessage =
  | { kind: 'impulse'; deviceMs: number | null }
  | { kind: 'hello'; bootId: number; deviceMs: number }
  | { kind: 'status'; rssi: number | null; clients: number | null; pulsesPerSec: number | null }
  | { kind: 'pulseWidth'; ms: number }
  | { kind: 'unknown'; raw: string };

/** Parst eine Zeile. Gibt null bei Leerzeilen / Kommentaren zurück. */
export function parseSensorMessage(line: string): SensorMessage | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  const parts = trimmed.split(/[,;\s]+/).filter(Boolean);
  const head = (parts[0] ?? '').toUpperCase();
  const num = (index: number): number | null => {
    const token = parts[index];
    if (token === undefined) return null;
    const value = Number(token.replace(',', '.'));
    return Number.isFinite(value) ? value : null;
  };

  switch (head) {
    case 'I':
    case 'IMPULSE':
      return { kind: 'impulse', deviceMs: null };

    case 'P': {
      const deviceMs = num(1);
      if (deviceMs === null) return { kind: 'impulse', deviceMs: null };
      return { kind: 'impulse', deviceMs };
    }

    case 'B': {
      const bootId = num(1);
      const deviceMs = num(2);
      if (bootId === null || deviceMs === null) return null;
      return { kind: 'hello', bootId, deviceMs };
    }

    case 'S':
      return { kind: 'status', rssi: num(1), clients: num(2), pulsesPerSec: num(3) };

    case 'T': {
      const ms = num(1);
      return ms === null ? null : { kind: 'pulseWidth', ms };
    }

    default: {
      // Nackte Zahl = Gerätezeit (ältere Firmware)
      const bare = Number(head.replace(',', '.'));
      if (Number.isFinite(bare)) return { kind: 'impulse', deviceMs: bare };
      return { kind: 'unknown', raw: trimmed };
    }
  }
}

/**
 * Übersetzt Gerätezeit (`millis()` des ESP32) auf die Zeitachse des Browsers
 * (`performance.now()`).
 *
 * Beim ersten Impuls wird die Abweichung aus dem Empfangszeitpunkt bestimmt.
 * Danach wird die Schätzung langsam nachgeführt, damit Drift der beiden
 * Quarzuhren die Schlag-Erkennung nicht aus dem Tritt bringt. Ein neuer
 * Bootvorgang setzt die Schätzung hart zurück.
 */
export class DeviceClock {
  private offsetMs: number | null = null;
  private bootId: number | null = null;
  /** Letzte Korrektur – nur zur Diagnose. */
  lastCorrectionMs = 0;

  constructor(private readonly followRate = 0.02) {}

  get calibrated(): boolean {
    return this.offsetMs !== null;
  }

  reset(): void {
    this.offsetMs = null;
    this.bootId = null;
    this.lastCorrectionMs = 0;
  }

  /**
   * @param deviceMs  Gerätezeit des Impulses
   * @param hostMs    Empfangszeit (performance.now())
   * @param bootId    Bootkennung, falls die Firmware sie mitschickt
   */
  toHost(deviceMs: number, hostMs: number, bootId: number | null = null): number {
    if (bootId !== null && this.bootId !== null && bootId !== this.bootId) {
      this.offsetMs = null;
    }
    if (bootId !== null) this.bootId = bootId;

    const observed = hostMs - deviceMs;
    if (this.offsetMs === null) {
      this.offsetMs = observed;
      this.lastCorrectionMs = 0;
      return hostMs;
    }

    const correction = observed - this.offsetMs;
    // Große Sprünge (Reboot ohne Bootkennung, USB-Neuverbindung) hart übernehmen
    if (Math.abs(correction) > 5000) {
      this.offsetMs = observed;
      this.lastCorrectionMs = correction;
      return hostMs;
    }

    this.offsetMs += correction * this.followRate;
    this.lastCorrectionMs = correction;
    return deviceMs + this.offsetMs;
  }
}

/** Sammelt Sensorzeilen aus einem beliebig gestückelten Bytestrom. */
export class LineFramer {
  private buffer = '';

  constructor(private readonly maxLength = 4096) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    if (this.buffer.length > this.maxLength) this.buffer = '';
    return lines;
  }

  reset(): void {
    this.buffer = '';
  }
}
