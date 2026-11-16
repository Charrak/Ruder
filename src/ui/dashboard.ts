import {
  formatDelta,
  formatDistance,
  formatNumber,
  formatPace,
  formatSeconds,
  clamp,
} from '../core/format';
import type { Frame, SessionSummary, Status } from '../core/controller';
import { heartRateZone } from '../input/heartRate';
import { pauseIcon, playIcon, resetIcon, settingsIcon } from './icons';

export interface DashboardHandlers {
  onToggle: () => void;
  onReset: () => void;
  onDragFactor: (value: number) => void;
  onSourceChange: (kind: 'demo' | 'serial' | 'ws', url?: string) => void;
  onEffortChange: (spm: number, paceSecPer500: number) => void;
  onWorkoutChange: (meter: number | null, seconds: number | null) => void;
  onConnectStrap: () => void;
}

interface Refs {
  root: HTMLElement;
  pace: HTMLElement;
  paceTarget: HTMLElement;
  splitCurrent: HTMLElement;
  statPower: HTMLElement;
  statSpm: HTMLElement;
  statDistance: HTMLElement;
  statTime: HTMLElement;
  phaseBadge: HTMLElement;
  clock: HTMLElement;
  statHeart: HTMLElement;
  heartZone: HTMLElement;
  hrButton: HTMLButtonElement;
  workoutName: HTMLElement;
  splitFill: HTMLElement;
  summaryOverlay: HTMLElement;
  statusPill: HTMLElement;
  statusText: HTMLElement;
  splits: HTMLElement;
  chartLine: SVGPathElement;
  chartArea: SVGPathElement;
  progressFill: HTMLElement;
  progressMark: HTMLElement;
  progressLabel: HTMLElement;
  toggleBtn: HTMLButtonElement;
  settings: HTMLElement;
}

const METRES = ['500 m', '1.000 m', '2.000 m', '5.000 m', '10.000 m'];
const TIMES = [
  ['1 min', 60],
  ['5 min', 300],
  ['10 min', 600],
  ['20 min', 1200],
  ['30 min', 1800],
] as const;

export class Dashboard {
  private refs: Refs;
  private handlers: DashboardHandlers;
  private lastSplitsKey = '';
  private lastChartAt = 0;
  private textCache = new WeakMap<HTMLElement, string>();

  constructor(root: HTMLElement, handlers: DashboardHandlers) {
    this.handlers = handlers;
    root.innerHTML = this.template();
    this.refs = this.collect(root);
    this.bind();
  }

  private template(): string {
    return `
      <header class="topbar">
        <div class="brand">
          <img class="brand__mark" src="/brand/logo-mark-light.png" alt="physio & fit" />
          <div class="brand__text">
            <span class="brand__title">Ruder<em>dashboard</em></span>
            <span class="brand__sub">VitalZentrum Eschweiler</span>
          </div>
        </div>
        <div class="topbar__spacer"></div>
        <span class="status-pill" id="status-pill">
          <span class="status-pill__dot"></span>
          <span id="status-text">Demo-Sensor</span>
        </span>
        <span class="clock" id="clock"></span>
      </header>

      <main class="layout">
        <section class="card hero" aria-label="Live-Werte">
          <div class="hero__head">
            <div>
              <div class="eyebrow" id="workout-eyebrow">Training</div>
              <div class="workout-name" id="workout-name">Freies Rudern</div>
            </div>
            <span class="phase-badge" id="phase-badge">Bereit</span>
          </div>

          <div class="metrics">
            <div class="pace">
              <span class="eyebrow">Split / 500 m</span>
              <div class="pace__value pace__value--idle" id="pace-main">–:––,–</div>
              <div class="target-row">
                <span class="pace__unit">pro 500 m</span>
                <span class="pace__target" id="pace-target"></span>
              </div>
            </div>
            <div class="hero__side">
              <div class="stat">
                <span class="stat__label">Leistung</span>
                <span class="stat__value" id="stat-power">0<small>W</small></span>
              </div>
              <div class="stat stat--accent">
                <span class="stat__label">Schlagzahl</span>
                <span class="stat__value" id="stat-spm">0<small>spm</small></span>
              </div>
              <div class="stat">
                <span class="stat__label">Strecke</span>
                <span class="stat__value" id="stat-distance">0<small>m</small></span>
              </div>
              <div class="stat">
                <span class="stat__label">Zeit</span>
                <span class="stat__value" id="stat-time">0:00,0</span>
              </div>
              <div class="stat stat--heart">
                <span class="stat__label">Herzfrequenz</span>
                <span class="stat__value" id="stat-heart">–<small>HF</small></span>
                <span class="stat__zone" id="heart-zone"></span>
              </div>
            </div>
          </div>

          <div class="hero__footer">
            <div class="ticker">
              <span>Fortschritt</span>
              <div class="ticker__bar">
                <div class="ticker__fill" id="progress-fill"></div>
                <div class="ticker__mark" id="progress-mark" hidden></div>
              </div>
              <span id="progress-label">–</span>
            </div>
            <div class="ticker">
              <span>Abschnitt</span>
              <div class="ticker__bar">
                <div class="ticker__fill" id="split-fill"></div>
              </div>
              <span id="split-current">–</span>
            </div>
          </div>
        </section>

        <aside class="side">
          <section class="card panel" aria-label="Splits">
            <div class="panel__head">
              <span class="panel__title">Splits</span>
              <span class="panel__hint">500-m-Abschnitte</span>
            </div>
            <div class="splits" id="splits">
              <p class="split-empty">
                Sobald die erste 500-m-Marke fällt, erscheint hier der Vergleich der
                Abschnitte.
              </p>
            </div>
            <div class="panel__head" style="margin-top:auto">
              <span class="panel__title">Tempo-Verlauf</span>
              <span class="panel__hint">letzte 5 min</span>
            </div>
            <svg class="chart" id="chart" viewBox="0 0 300 96" preserveAspectRatio="none" role="img" aria-label="Tempo-Verlauf">
              <defs>
                <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#b5e900" stop-opacity="0.30" />
                  <stop offset="100%" stop-color="#b5e900" stop-opacity="0" />
                </linearGradient>
              </defs>
              <line class="chart__baseline" x1="0" y1="95" x2="300" y2="95" />
              <path class="chart__area" id="chart-area" d="" />
              <path class="chart__line" id="chart-line" d="" />
            </svg>
          </section>

          <section class="card panel" aria-label="Steuerung">
            <div class="controls">
              <button class="btn btn--primary" id="toggle-btn" type="button">
                ${playIcon}<span id="toggle-label">Start</span>
              </button>
              <button class="btn btn--ghost" id="reset-btn" type="button" aria-label="Zurücksetzen" title="Zurücksetzen">
                ${resetIcon}
              </button>
              <button class="btn btn--ghost" id="settings-btn" type="button" aria-label="Einstellungen" aria-expanded="false" title="Einstellungen">
                ${settingsIcon}
              </button>
            </div>

            <div class="settings" id="settings" hidden>
              <label class="field">
                <span class="field__label">Herzfrequenzgurt</span>
                <button class="btn btn--ghost btn--wide" id="hr-btn" type="button">
                  Brustgurt verbinden
                </button>
              </label>
              <label class="field">
                <span class="field__label">Sensor</span>
                <select id="source-select">
                  <option value="demo">Demo-Sensor (kein Gerät)</option>
                  <option value="serial">ESP32 über USB (Web Serial)</option>
                  <option value="ws">ESP32 im WLAN (WebSocket)</option>
                </select>
              </label>
              <label class="field" id="ws-field" hidden>
                <span class="field__label">WebSocket-Adresse</span>
                <input type="text" id="ws-url" placeholder="ws://esp32.local:81/" />
              </label>
              <label class="field">
                <span class="field__label">Drag-Faktor</span>
                <div class="field__row">
                  <input type="range" id="df-range" min="60" max="220" step="1" value="120" />
                  <span class="value-badge" id="df-value">120</span>
                </div>
              </label>
              <label class="field">
                <span class="field__label">Ziel</span>
                <select id="workout-select">
                  <option value="free">Freies Training</option>
                  ${METRES.map((m) => `<option value="d:${m.replace(/[^0-9]/g, '')}">${m}</option>`).join('')}
                  ${TIMES.map(([label, sec]) => `<option value="t:${sec}">${label}</option>`).join('')}
                </select>
              </label>
              <label class="field" id="effort-field">
                <span class="field__label">Demo-Intensität</span>
                <select id="effort-select">
                  <option value="28">Locker (28 spm · 2:10)</option>
                  <option value="24" selected>Grundlage (24 spm · 2:05)</option>
                  <option value="21">Technik (21 spm · 1:58)</option>
                  <option value="32">Intervall (32 spm · 1:44)</option>
                </select>
              </label>
            </div>
          </section>
        </aside>
      </main>

      <div class="summary" id="summary" hidden>
        <div class="summary__card card" role="dialog" aria-modal="true" aria-labelledby="summary-title">
          <div class="summary__head">
            <img class="summary__mark" src="/brand/logo-mark-light.png" alt="" />
            <div>
              <div class="eyebrow">Training beendet</div>
              <h2 class="summary__title" id="summary-title">Zusammenfassung</h2>
            </div>
          </div>
          <dl class="summary__grid" id="summary-grid"></dl>
          <div class="summary__actions">
            <button class="btn btn--primary" id="summary-again" type="button">Neues Training</button>
            <button class="btn btn--ghost" id="summary-close" type="button">Schließen</button>
          </div>
        </div>
      </div>
    `;
  }

  private collect(root: HTMLElement): Refs {
    const get = <T extends HTMLElement>(id: string): T => {
      const el = root.querySelector<T>(`#${id}`);
      if (!el) throw new Error(`Element #${id} fehlt`);
      return el;
    };
    return {
      root,
      pace: get('pace-main'),
      paceTarget: get('pace-target'),
      splitCurrent: get('split-current'),
      statPower: get('stat-power'),
      statSpm: get('stat-spm'),
      statDistance: get('stat-distance'),
      statTime: get('stat-time'),
      phaseBadge: get('phase-badge'),
      clock: get('clock'),
      statusPill: get('status-pill'),
      statusText: get('status-text'),
      splits: get('splits'),
      chartLine: get('chart-line') as unknown as SVGPathElement,
      chartArea: get('chart-area') as unknown as SVGPathElement,
      progressFill: get('progress-fill'),
      progressMark: get('progress-mark'),
      progressLabel: get('progress-label'),
      toggleBtn: get('toggle-btn') as HTMLButtonElement,
      settings: get('settings'),
      statHeart: get('stat-heart'),
      heartZone: get('heart-zone'),
      hrButton: get('hr-btn') as HTMLButtonElement,
      workoutName: get('workout-name'),
      splitFill: get('split-fill'),
      summaryOverlay: get('summary'),
    };
  }

  private bind(): void {
    const q = <T extends HTMLElement>(sel: string): T => this.refs.root.querySelector<T>(sel)!;

    this.refs.toggleBtn.addEventListener('click', () => this.handlers.onToggle());
    q('#reset-btn').addEventListener('click', () => this.handlers.onReset());

    const settingsBtn = q<HTMLButtonElement>('#settings-btn');
    settingsBtn.addEventListener('click', () => {
      const open = this.refs.settings.hasAttribute('hidden');
      this.refs.settings.toggleAttribute('hidden', !open);
      settingsBtn.setAttribute('aria-expanded', String(open));
    });

    q<HTMLSelectElement>('#source-select').addEventListener('change', (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      const kind = select.value as 'demo' | 'serial' | 'ws';
      q('#ws-field').toggleAttribute('hidden', kind !== 'ws');
      q('#effort-field').toggleAttribute('hidden', kind !== 'demo');
      const url = q<HTMLInputElement>('#ws-url').value.trim();
      this.handlers.onSourceChange(kind, url || undefined);
    });

    q<HTMLInputElement>('#df-range').addEventListener('input', (event) => {
      const range = event.currentTarget as HTMLInputElement;
      q('#df-value').textContent = range.value;
      this.handlers.onDragFactor(Number(range.value));
    });

    q<HTMLSelectElement>('#workout-select').addEventListener('change', (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      if (value === 'free') this.handlers.onWorkoutChange(null, null);
      else if (value.startsWith('d:')) this.handlers.onWorkoutChange(Number(value.slice(2)), null);
      else this.handlers.onWorkoutChange(null, Number(value.slice(2)));
    });

    q<HTMLSelectElement>('#effort-select').addEventListener('change', (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      const map: Record<string, [number, number]> = {
        '28': [28, 130],
        '24': [24, 125],
        '21': [21, 118],
        '32': [32, 104],
      };
      const [spm, pace] = map[value] ?? [24, 125];
      this.handlers.onEffortChange(spm, pace);
    });

    q('#hr-btn').addEventListener('click', () => this.handlers.onConnectStrap());
    q('#summary-close').addEventListener('click', () => this.hideSummary());
    q('#summary-again').addEventListener('click', () => {
      this.hideSummary();
      this.handlers.onReset();
      this.handlers.onToggle();
    });

    // Leertaste = Start/Pause
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        this.handlers.onToggle();
      }
      if (event.key === 'r' || event.key === 'R') this.handlers.onReset();
    });
  }

  updateStatus(status: Status): void {
    this.refs.statusText.textContent = status.message;
    this.refs.statusPill.classList.toggle('status-pill--live', status.connected);
    this.refs.statusPill.classList.toggle('status-pill--warn', !status.connected);
  }

  setSessionState(state: 'idle' | 'running' | 'paused' | 'finished'): void {
    const isRunning = state === 'running';
    this.refs.toggleBtn.innerHTML = `${isRunning ? pauseIcon : playIcon}<span id="toggle-label">${
      isRunning ? 'Pause' : state === 'finished' ? 'Erneut' : state === 'paused' ? 'Weiter' : 'Start'
    }</span>`;
  }

  render(frame: Frame): void {
    const { snapshot, session } = frame;
    const moving = snapshot.state === 'moving';

    this.setText(this.refs.pace, formatPace(snapshot.paceSecPer500));
    this.refs.pace.classList.toggle('pace__value--idle', !moving);

    this.setHtml(this.refs.statPower, `${formatNumber(snapshot.powerW)}<small>W</small>`);
    this.setHtml(
      this.refs.statSpm,
      `${formatNumber(snapshot.strokeRateSpm, snapshot.strokeRateSpm % 1 === 0 ? 0 : 1)}<small>spm</small>`,
    );
    this.setHtml(this.refs.statDistance, `${formatNumber(Math.floor(snapshot.distanceM))}<small>m</small>`);
    this.setText(this.refs.statTime, formatSeconds(session.elapsedMs / 1000));

    const phase = !moving ? 'Bereit' : frame.strokePhase.phase === 'drive' ? 'Durchzug' : 'Erholung';
    this.setText(this.refs.phaseBadge, phase);
    this.refs.phaseBadge.classList.toggle('phase-badge--drive', moving && frame.strokePhase.phase === 'drive');

    this.setText(
      this.refs.clock,
      new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
    );

    const currentSplit = session.currentSplitSeconds(snapshot.distanceM);
    this.setText(this.refs.splitCurrent, currentSplit ? formatSeconds(currentSplit) : '–');

    this.renderHeartRate(frame);
    this.renderSummary(frame.summary);
    this.renderTarget(frame);
    this.renderProgress(frame);
    this.renderSplits(frame);
    this.renderChart(frame);
  }

  private renderTarget(frame: Frame): void {
    const workout = frame.session.workout;
    const el = this.refs.paceTarget;
    el.classList.remove('pace__target--behind');

    if (workout.kind === 'distance' && workout.distanceM) {
      const projection = frame.session.projectedFinishMs(frame.snapshot.distanceM);
      el.textContent = projection
        ? `Ziel ${formatDistance(workout.distanceM)} · Prognose ${formatSeconds(projection / 1000, { tenths: false })}`
        : `Ziel ${formatDistance(workout.distanceM)}`;
      return;
    }
    if (workout.kind === 'time' && workout.durationSec) {
      const projection = frame.session.projectedDistance(frame.snapshot.distanceM);
      el.textContent = projection
        ? `Ziel ${formatSeconds(workout.durationSec, { tenths: false })} · Prognose ${formatDistance(projection)}`
        : `Ziel ${formatSeconds(workout.durationSec, { tenths: false })}`;
      return;
    }
    el.textContent = frame.snapshot.state === 'moving' ? 'Freies Training' : '';
  }

  private renderProgress(frame: Frame): void {
    const { snapshot, session } = frame;
    const workout = session.workout;
    const fill = this.refs.progressFill;

    if (workout.kind === 'distance' && workout.distanceM) {
      const pct = clamp((snapshot.distanceM / workout.distanceM) * 100, 0, 100);
      fill.style.width = `${pct}%`;
      fill.classList.remove('ticker__fill--danger');
      this.refs.progressLabel.textContent = `${Math.floor(pct)} %`;
      this.placeMark((session.splitsList.length * 500 / workout.distanceM) * 100);
      return;
    }
    if (workout.kind === 'time' && workout.durationSec) {
      const pct = clamp((session.elapsedMs / 1000 / workout.durationSec) * 100, 0, 100);
      fill.style.width = `${pct}%`;
      this.refs.progressLabel.textContent = `${Math.floor(pct)} %`;
      this.placeMark(null);
      return;
    }

    // Abschnitts-Balken: Position innerhalb des laufenden 500-m-Blocks
    const segment = snapshot.distanceM % 500;
    this.refs.splitFill.style.width = `${clamp((segment / 500) * 100, 0, 100)}%`;

    // Freies Training: Fortschritt zur nächsten 500-m-Marke
    const partial = snapshot.distanceM % 500;
    fill.style.width = `${clamp((partial / 500) * 100, 0, 100)}%`;
    this.refs.progressLabel.textContent = `bis ${formatDistance(
      Math.ceil((snapshot.distanceM + 1) / 500) * 500,
    )}`;
    this.placeMark(null);
  }

  private placeMark(pct: number | null): void {
    const mark = this.refs.progressMark;
    if (pct === null || pct >= 100) {
      mark.hidden = true;
      return;
    }
    mark.hidden = false;
    mark.style.left = `${pct}%`;
  }

  private renderSplits(frame: Frame): void {
    const splits = frame.session.splitsList;
    const key = splits.map((s) => s.index).join(',');
    if (key === this.lastSplitsKey) return;
    this.lastSplitsKey = key;

    if (splits.length === 0) {
      this.refs.splits.innerHTML = `<p class="split-empty">Sobald die erste 500-m-Marke fällt, erscheint hier der Vergleich der Abschnitte.</p>`;
      return;
    }

    const rows: string[] = [];
    const visible = splits.slice(-4);
    for (let i = 0; i < visible.length; i++) {
      const split = visible[i]!;
      const previous = splits[splits.indexOf(split) - 1];
      const delta = previous ? formatDelta(split.splitSec - previous.splitSec) : null;
      const isLast = split === splits.at(-1);
      rows.push(`
        <div class="split-row ${isLast ? 'split-row--current' : ''}">
          <span class="split-row__index">${String(split.index).padStart(2, '0')}</span>
          <span class="split-row__pace">${formatSeconds(split.splitSec)}</span>
          <span class="split-row__delta ${delta ? (delta.good ? 'is-good' : 'is-bad') : ''}">
            ${delta ? delta.text : ''}
          </span>
        </div>
      `);
    }
    this.refs.splits.innerHTML = rows.join('');
  }

  /** Schreibt Text nur, wenn er sich ändert (spart Layoutarbeit im Dauerbetrieb). */
  private setText(el: HTMLElement, value: string): void {
    if (this.textCache.get(el) === value) return;
    this.textCache.set(el, value);
    el.textContent = value;
  }

  private setHtml(el: HTMLElement, value: string): void {
    if (this.textCache.get(el) === value) return;
    this.textCache.set(el, value);
    el.innerHTML = value;
  }

  private renderChart(frame: Frame): void {
    // 5-mal pro Sekunde reicht für einen Verlauf völlig
    if (frame.now - this.lastChartAt < 200) return;
    this.lastChartAt = frame.now;
    const samples = frame.session.samplesList;
    if (samples.length < 2) {
      this.refs.chartLine.setAttribute('d', '');
      this.refs.chartArea.setAttribute('d', '');
      return;
    }

    const windowMs = 300_000;
    const last = samples.at(-1)!.t;
    const from = Math.max(0, last - windowMs);
    const points = samples.filter((s) => s.t >= from);
    if (points.length < 2) return;

    const paces = points.map((p) => p.paceSecPer500);
    let min = Math.min(...paces);
    let max = Math.max(...paces);
    const span = Math.max(6, max - min);
    const pad = span * 0.15;
    min -= pad;
    max += pad;

    const w = 300;
    const h = 96;
    const coords = points.map((p) => {
      const x = ((p.t - from) / Math.max(1, last - from)) * w;
      // kleinerer Split = schneller = höher im Chart
      const y = h - ((p.paceSecPer500 - min) / (max - min)) * (h - 12) - 6;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const line = `M${coords.join(' L')}`;
    this.refs.chartLine.setAttribute('d', line);
    this.refs.chartArea.setAttribute('d', `${line} L${w},${h} L0,${h} Z`);
  }

  private renderHeartRate(frame: Frame): void {
    const bpm = frame.heartRate.bpm;
    if (bpm === null) {
      this.setHtml(this.refs.statHeart, '–<small>HF</small>');
      this.refs.heartZone.textContent = '';
      return;
    }
    const zone = heartRateZone(bpm);
    this.setHtml(this.refs.statHeart, `${bpm}<small>HF</small>`);
    this.refs.statHeart.style.color = zone.color;
    this.setText(this.refs.heartZone, `Z${zone.zone} · ${zone.label}`);
    this.refs.heartZone.style.color = zone.color;
  }

  private renderSummary(summary: SessionSummary | null): void {
    if (!summary) return;
    const grid = this.refs.root.querySelector('#summary-grid');
    if (!grid) return;
    const rows: Array<[string, string]> = [
      ['Zeit', formatSeconds(summary.elapsedMs / 1000)],
      ['Strecke', formatDistance(summary.distanceM)],
      ['Ø Split', formatPace(summary.avgPaceSecPer500)],
      ['Ø Leistung', `${formatNumber(summary.avgPowerW)} W`],
      ['Ø Schlagzahl', `${formatNumber(summary.avgSpm, 1)} spm`],
      ['Ø Herzfrequenz', summary.avgHeartRate ? `${summary.avgHeartRate} HF` : '–'],
      ['Energie', `${formatNumber(summary.caloriesKcal)} kcal`],
      ['Splits', String(summary.splits)],
    ];
    grid.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div class="summary__item"><dt>${label}</dt><dd>${value}</dd></div>`,
      )
      .join('');
    this.refs.summaryOverlay.hidden = false;
    this.refs.summaryOverlay.querySelector<HTMLButtonElement>('#summary-again')?.focus();
  }

  hideSummary(): void {
    this.refs.summaryOverlay.hidden = true;
  }

  /** Überschrift an das gewählte Ziel anpassen. */
  setWorkoutLabel(label: string): void {
    this.refs.workoutName.textContent = label;
  }

  setHeartRateLabel(text: string): void {
    this.refs.hrButton.textContent = text;
  }

  toggleSettings(open: boolean): void {
    this.refs.settings.toggleAttribute('hidden', !open);
  }
}
