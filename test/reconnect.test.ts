// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketSensor, type SensorState } from '../src/input/sources';

type Listener = (event: unknown) => void;

/** Minimaler WebSocket-Ersatz, mit dem sich Abbrüche erzwingen lassen. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }

  fail(): void {
    this.onerror?.({});
    this.close();
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
}

// Mit gefälschten Timern muss auch das Leeren der Mikrotask-Warteschlange
// über den Timer laufen.
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('WebSocketSensor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const create = (url = 'ws://esp32.local:81/') =>
    new WebSocketSensor({ url, retryBaseMs: 100, retryMaxMs: 800, silenceTimeoutMs: 5000 });

  it('verbindet und meldet den Zustand', async () => {
    const states: SensorState[] = [];
    const sensor = create();
    const started = sensor.start({ onImpulse: () => undefined, onState: (s) => states.push(s) });
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0]!.open();
    await started;
    expect(states).toContain('open');
    await sensor.stop();
  });

  it('verbindet nach einem Abbruch automatisch neu', async () => {
    const states: SensorState[] = [];
    const sensor = create();
    const started = sensor.start({ onImpulse: () => undefined, onState: (s) => states.push(s) });
    await flush();
    FakeSocket.instances[0]!.open();
    await started;

    FakeSocket.instances[0]!.close();
    expect(states).toContain('reconnecting');

    await vi.advanceTimersByTimeAsync(150);
    expect(FakeSocket.instances.length).toBe(2);

    FakeSocket.instances[1]!.open();
    await flush();
    expect(states.at(-1)).toBe('open');
    await sensor.stop();
  });

  it('steigert die Wartezeit zwischen den Versuchen', async () => {
    const sensor = create();
    void sensor.start({ onImpulse: () => undefined, onState: () => undefined });
    await flush();
    FakeSocket.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1]!.fail();
    // zweiter Versuch wartet 200 ms
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSocket.instances).toHaveLength(3);
    await sensor.stop();
  });

  it('erkennt eine stille Verbindung und baut sie neu auf', async () => {
    const sensor = create();
    void sensor.start({ onImpulse: () => undefined, onState: () => undefined });
    await flush();
    FakeSocket.instances[0]!.open();
    await flush();

    await vi.advanceTimersByTimeAsync(5200);
    expect(FakeSocket.instances[0]!.readyState).toBe(3);

    await vi.advanceTimersByTimeAsync(150);
    expect(FakeSocket.instances.length).toBe(2);
    await sensor.stop();
  });

  it('hält den Wachhund mit jeder Nachricht wach', async () => {
    let impulses = 0;
    const sensor = create();
    void sensor.start({ onImpulse: () => (impulses += 1), onState: () => undefined });
    await flush();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    await flush();

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      socket.message('I\n');
    }
    expect(impulses).toBe(6);
    expect(FakeSocket.instances).toHaveLength(1);
    await sensor.stop();
  });

  it('verarbeitet gestückelte Nachrichten und Gerätezeit', async () => {
    const stamps: number[] = [];
    const sensor = create();
    void sensor.start({ onImpulse: (t) => stamps.push(t), onState: () => undefined });
    await flush();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    await flush();

    socket.message('B,3,1000\nP,12');
    socket.message('50\nI\n');
    expect(stamps).toHaveLength(2);
    await sensor.stop();
  });

  it('meldet Fehlschläge, statt endlos zu schweigen', async () => {
    const sensor = create('ws://nicht-vorhanden:81/');
    const states: SensorState[] = [];
    const detail: string[] = [];
    void sensor.start({
      onImpulse: () => undefined,
      onState: (s, message) => {
        states.push(s);
        if (message) detail.push(message);
      },
    });
    await flush();
    FakeSocket.instances[0]!.fail();
    expect(states).toContain('reconnecting');
    expect(detail.join(' ')).toMatch(/Verbindung/);
    await sensor.stop();
    expect(states.at(-1)).toBe('closed');
  });
});
