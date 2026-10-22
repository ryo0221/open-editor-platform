/** IANA time zone arithmetic on the platform's Intl data. No zone tables are bundled. */
import { DAY_MS } from '@editor-platform/time-axis';

export type Fold = 'earlier' | 'later';
/** A wall-clock time in some zone, YYYY-MM-DDTHH:mm. */
export type LocalDateTime = string;
export interface WallTime {
  date: string;
  minutes: number;
}
export type LocalResolution =
  | { kind: 'exact'; instant: number }
  | { kind: 'ambiguous'; earlier: number; later: number }
  | { kind: 'missing' };

const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string) {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, value);
  }
  return value;
}

const canonical = new Map<string, string | null>();
/** The platform's canonical name for a zone, or null when the zone is unknown. */
export function canonicalZone(zone: string): string | null {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return null;
  // Building a formatter is the costliest step of every time check; the answer never changes.
  let value = canonical.get(zone);
  if (value === undefined) {
    try {
      value = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      value = null;
    }
    // Imported names are arbitrary text; keep the memo bounded.
    if (canonical.size >= 512) canonical.clear();
    canonical.set(zone, value);
  }
  return value;
}
export const isCanonicalZone = (zone: string) => canonicalZone(zone) === zone;

/** Milliseconds since the epoch of the wall time, read as if it were UTC. */
export function localMillis(local: LocalDateTime): number | null {
  const m = localPattern.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(ms).toISOString().slice(0, 16) === local ? ms : null;
}
export const formatLocal = (ms: number): LocalDateTime => new Date(ms).toISOString().slice(0, 16);

/** Wall time of an instant in a zone, read as if it were UTC. */
function wallMillis(instant: number, zone: string) {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}
export const zoneOffset = (instant: number, zone: string) =>
  wallMillis(instant, zone) - Math.floor(instant / 1000) * 1000;

/** Every instant whose wall time in the zone is the given local time. */
export function resolveLocal(local: LocalDateTime, zone: string): LocalResolution {
  const wall = localMillis(local);
  if (wall === null || !isCanonicalZone(zone)) return { kind: 'missing' };
  const offsets = new Set([wall - DAY_MS, wall, wall + DAY_MS].map((t) => zoneOffset(t, zone)));
  const instants = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => wallMillis(instant, zone) === wall)
    .sort((a, b) => a - b);
  const unique = [...new Set(instants)];
  if (!unique.length) return { kind: 'missing' };
  if (unique.length === 1) return { kind: 'exact', instant: unique[0] };
  return { kind: 'ambiguous', earlier: unique[0], later: unique[unique.length - 1] };
}

export function wallTime(instant: number, zone: string): WallTime {
  const wall = wallMillis(instant, zone);
  const iso = new Date(wall).toISOString();
  return {
    date: iso.slice(0, 10),
    minutes: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)),
  };
}
export const timeLabel = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The zones this platform knows, for pickers. Falls back to a short list on older engines. */
export function knownZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const zones = supported ? supported('timeZone') : [];
  return [...new Set(['UTC', ...zones])].filter(isCanonicalZone);
}
