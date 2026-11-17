// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../src/ui/dashboard';
import { RowerEngine } from '../src/core/engine';
import { RowerSimulator } from '../src/core/simulator';
import { Session } from '../src/core/session';
import type { Frame } from '../src/core/controller';

const noop = () => {};
const handlers = {
  onToggle: noop,
  onReset: noop,
  onDragFactor: noop,
  onSourceChange: noop,
  onEffortChange: noop,
  onWorkoutChange: noop,
  onConnectStrap: noop,
  onConnectWs: noop,
};

function mount() {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector<HTMLDivElement>('#app')!;
  const dashboard = new Dashboard(root, handlers);
  return { root, dashboard };
}

/** Baut einen realistischen Frame aus Engine + Session. */
function makeFrame(seconds = 40, distance = 180, pace = 125): Frame {
  const engine = new RowerEngine({ dragFactor: 120 });
  const simulator = new RowerSimulator({ spm: 24, paceSecPer500: pace });
  const session = new Session({ kind: 'free' });
  session.start(0);
  let now = 0;
  for (let i = 0; i < seconds * 100; i++) {
    now += 10;
    for (const at of simulator.advance(now)) engine.impulse(at);
    session.tick(now, {
      moving: true,
      distanceM: (now / 1000) * (500 / pace),
      paceSecPer500: pace,
      powerW: 180,
      spm: 24,
    });
  }
  const snapshot = engine.snapshot(now);
  return {
    now,
    snapshot: { ...snapshot, distanceM: distance, paceSecPer500: pace },
    session,
    strokePhase: { phase: 'drive', progress: 0.4 },
    targetPace: null,
    heartRate: { bpm: 142, source: 'demo', deviceName: null },
    summary: null,
  };
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('rendert die Marke und die Hauptkennzahlen', () => {
    const { root } = mount();
    // Web-optimierte Variante (5,7 kB statt 67 kB) – die Druckdatei wäre auf
    // dem ESP32 verschwendeter Flash.
    expect(root.querySelector('.brand__mark')?.getAttribute('src')).toBe(
      '/brand/web/logo-mark-light.png',
    );
    expect(root.querySelector('#pace-main')?.textContent).toBe('–:––,–');
    expect(root.querySelector('#stat-spm')?.textContent).toContain('0');
    expect(root.textContent).toContain('VitalZentrum Eschweiler');
  });

  it('zeigt Split, Leistung, Strecke und Zeit aus dem Frame', () => {
    const { root, dashboard } = mount();
    dashboard.render(makeFrame(40, 180, 125));
    expect(root.querySelector('#pace-main')?.textContent).toBe('2:05,0');
    expect(root.querySelector('#stat-distance')?.textContent).toBe('180m');
    expect(root.querySelector('#stat-time')?.textContent).toBe('0:40,0');
    expect(root.querySelector('#phase-badge')?.textContent).toBe('Durchzug');
  });

  it('schaltet den Start-Knopf zwischen Start, Pause und Weiter', () => {
    const { root, dashboard } = mount();
    const button = root.querySelector<HTMLButtonElement>('#toggle-btn')!;
    expect(button.textContent).toContain('Start');
    dashboard.setSessionState('running');
    expect(button.textContent).toContain('Pause');
    dashboard.setSessionState('paused');
    expect(button.textContent).toContain('Weiter');
    dashboard.setSessionState('finished');
    expect(button.textContent).toContain('Erneut');
  });

  it('kennzeichnet den Sensor-Status', () => {
    const { root, dashboard } = mount();
    dashboard.updateStatus({
      source: 'demo',
      connected: true,
      message: 'Demo-Sensor',
      dragFactor: 120,
      state: 'open',
      telemetry: null,
      endpoint: 'Demo',
    });
    const pill = root.querySelector('#status-pill')!;
    expect(pill.classList.contains('status-pill--live')).toBe(true);

    dashboard.updateStatus({
      source: 'ws',
      connected: false,
      message: 'WLAN nicht erreichbar',
      dragFactor: 120,
      state: 'reconnecting',
      telemetry: null,
      endpoint: 'ws://esp32.local:81/',
    });
    expect(pill.classList.contains('status-pill--warn')).toBe(true);
    expect(root.querySelector('#status-text')?.textContent).toBe('WLAN nicht erreichbar');
  });

  it('zeigt nach 500 m einen Split-Eintrag', () => {
    const { root, dashboard } = mount();
    dashboard.render(makeFrame(230, 520, 125));
    const rows = root.querySelectorAll('.split-row');
    expect(rows.length).toBe(1);
    // 500 m bei 4 m/s = 125 s
expect(rows[0]?.querySelector('.split-row__pace')?.textContent).toBe('2:05,0');
  });

  it('überlebt einen Frame ohne Bewegung', () => {
    const { root, dashboard } = mount();
    const frame = makeFrame(5, 0, 125);
    frame.snapshot = { ...frame.snapshot, state: 'idle', paceSecPer500: null, powerW: 0, strokeRateSpm: 0 };
    expect(() => dashboard.render(frame)).not.toThrow();
    expect(root.querySelector('#pace-main')?.textContent).toBe('–:––,–');
  });

  it('zeigt die Herzfrequenz mit Zone', () => {
    const { root, dashboard } = mount();
    const frame = makeFrame(20, 80, 125);
    dashboard.render({ ...frame, heartRate: { bpm: 140, source: 'demo', deviceName: null } });
    expect(root.querySelector('#stat-heart')?.textContent).toContain('140');
    expect(root.querySelector('#heart-zone')?.textContent).toBe('Z2 · Aerob');
  });

  it('blendet die Zusammenfassung erst am Ende des Trainings ein', () => {
    const { root, dashboard } = mount();
    const overlay = root.querySelector<HTMLElement>('#summary')!;
    dashboard.render(makeFrame(10, 40, 125));
    expect(overlay.hidden).toBe(true);

    dashboard.render({
      ...makeFrame(10, 40, 125),
      summary: {
        elapsedMs: 240_000,
        distanceM: 2000,
        avgPaceSecPer500: 120,
        avgPowerW: 210,
        avgSpm: 24.4,
        avgHeartRate: 148,
        caloriesKcal: 96,
        splits: 4,
      },
    });
    expect(overlay.hidden).toBe(false);
    expect(root.querySelector('#summary-grid')?.textContent).toContain('96 kcal');
    expect(root.querySelector('#summary-grid')?.textContent).toContain('2:00,0');

    dashboard.hideSummary();
    expect(overlay.hidden).toBe(true);
  });

  it('normalisiert die eingegebene Sensoradresse beim Verbinden', () => {
    const calls: string[] = [];
    document.body.innerHTML = '<div id="app"></div>';
    const dashboard = new Dashboard(document.querySelector<HTMLDivElement>('#app')!, {
      ...handlers,
      onConnectWs: (url) => calls.push(url),
    });
    const input = document.querySelector<HTMLInputElement>('#ws-url')!;
    const button = document.querySelector<HTMLButtonElement>('#ws-connect')!;
    input.value = 'ruder-sensor.local';

    button.click();
    expect(calls).toEqual(['ws://ruder-sensor.local:81/']);
    // Die korrigierte Adresse steht sichtbar im Feld
    expect(input.value).toBe('ws://ruder-sensor.local:81/');

    input.value = 'kein richtiger wert mit leerzeichen';
    button.click();
    expect(calls).toHaveLength(1);
    expect(document.querySelector('#settings-hint')?.textContent).toContain('Bitte eine Adresse');

    void dashboard;
  });

  it('zeigt die Diagnose nur bei echter Sensorquelle', () => {
    const { root, dashboard } = mount();
    const diag = root.querySelector<HTMLElement>('#diag')!;

    dashboard.updateStatus({
      source: 'demo',
      connected: true,
      message: 'Demo-Sensor',
      dragFactor: 120,
      state: 'open',
      telemetry: null,
      endpoint: 'Demo',
    });
    expect(diag.hidden).toBe(true);

    dashboard.updateStatus({
      source: 'ws',
      connected: true,
      message: 'ESP32 im WLAN',
      dragFactor: 120,
      state: 'open',
      endpoint: 'ws://192.168.1.50:81/',
      telemetry: {
        rssi: -58,
        clients: 1,
        pulsesPerSec: 9.6,
        pulseWidthMs: null,
        clockCalibrated: true,
        lastMessageAt: 100,
      },
    });
    expect(diag.hidden).toBe(false);
    expect(root.querySelector('#diag-rssi')?.textContent).toBe('-58 dBm');
    expect(root.querySelector('#diag-pps')?.textContent).toBe('9,6');
    expect(root.querySelector('#diag-clock')?.textContent).toBe('ja');
  });

  it('reagiert auf Tastatur (Leertaste, R)', () => {
    const toggle = vi.fn();
    const reset = vi.fn();
    document.body.innerHTML = '<div id="app"></div>';
    const dashboard = new Dashboard(document.querySelector<HTMLDivElement>('#app')!, {
      ...handlers,
      onToggle: toggle,
      onReset: reset,
    });
    void dashboard;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
