/**
 * Deutsche Formatierung für das Dashboard.
 * Split-Zeiten werden wie auf dem PM5 als m:ss,z angezeigt.
 */

const timeMinSec = new Intl.NumberFormat('de-DE', {
  minimumIntegerDigits: 1,
  useGrouping: false,
});

/** 425_300 -> "7:04,3" (Zehntel), 3_725_000 -> "1:02:05,0" */
export function formatDuration(ms: number): string {
  return formatSeconds(ms / 1000);
}

export function formatSeconds(totalSeconds: number, opts: { tenths?: boolean } = {}): string {
  const tenths = opts.tenths ?? true;
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '–';
  const rounded = tenths ? Math.floor(totalSeconds * 10) / 10 : Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = Math.floor(rounded % 60);
  const fraction = Math.round((rounded - Math.floor(rounded)) * 10);

  const mm = hours > 0 ? timeMinSec.format(minutes).padStart(2, '0') : timeMinSec.format(minutes);
  const ss = timeMinSec.format(seconds).padStart(2, '0');
  const suffix = tenths ? `,${fraction}` : '';
  return hours > 0 ? `${hours}:${mm}:${ss}${suffix}` : `${mm}:${ss}${suffix}`;
}

/** Split auf 500 m: "1:46,2" */
export function formatPace(paceSecPer500: number | null): string {
  if (paceSecPer500 === null || !Number.isFinite(paceSecPer500) || paceSecPer500 <= 0) return '–:––,–';
  return formatSeconds(paceSecPer500);
}

/** Differenz zwischen Splits: "+0,4" / "−1,2" / "±0,0" */
export function formatDelta(seconds: number, invertGood = true): { text: string; good: boolean } {
  if (!Number.isFinite(seconds)) return { text: '±0,0', good: true };
  const rounded = Math.round(seconds * 10) / 10;
  const magnitude = Math.abs(rounded).toFixed(1).replace('.', ',');
  if (rounded === 0) return { text: '±0,0', good: true };
  const negative = rounded < 0;
  const text = `${negative ? '−' : '+'}${magnitude}`;
  // Schnellerer Split (kleinerer Wert) ist gut.
  const good = invertGood ? negative : !negative;
  return { text, good };
}

/** 1234.6 -> "1.235 m" */
export function formatDistance(meters: number): string {
  const rounded = Math.max(0, Math.round(meters));
  return `${new Intl.NumberFormat('de-DE').format(rounded)} m`;
}

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** 5400 -> "1:30:00" für Zielzeiten */
export function formatTargetDistance(meters: number): string {
  return formatDistance(meters);
}

export function formatTargetTime(seconds: number): string {
  return formatSeconds(seconds, { tenths: false });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
