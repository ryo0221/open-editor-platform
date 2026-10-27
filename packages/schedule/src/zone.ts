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
      timeZone: resolved(zone)?.engine ?? zone,
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

/** ICU keeps CLDR's older names as canonical (Chromium and Node answer Asia/Saigon for
 * Asia/Ho_Chi_Minh); IANA's current name for each, so every engine stores the same text. */
const currentNames: Record<string, string> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};
// Keyed in lower case: engines take zone names in any casing.
const olderNames = Object.fromEntries(
  Object.entries(currentNames).map(([older, current]) => [current.toLowerCase(), older]),
);

function engineName(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The stored name and the name this engine accepts for it. */
interface Resolved {
  name: string;
  engine: string;
}
const canonical = new Map<string, Resolved | null>();
function resolved(zone: string): Resolved | null {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return null;
  // Building a formatter is the costliest step of every time check; the answer never changes.
  let value = canonical.get(zone);
  if (value === undefined) {
    // An engine with older zone data may know a renamed zone only by its older name.
    const older = olderNames[zone.toLowerCase()];
    const engine = engineName(zone) ?? (older ? engineName(older) : null);
    value = engine ? { name: currentNames[engine] ?? engine, engine } : null;
    // Imported names are arbitrary text; keep the memo bounded.
    if (canonical.size >= 512) canonical.clear();
    canonical.set(zone, value);
  }
  return value;
}
/** IANA's current name for a zone (current, older or differently cased), or null when unknown. */
export const canonicalZone = (zone: string): string | null => resolved(zone)?.name ?? null;
/** Whether the zone is the name content stores: what new and changed events are written with. */
export const isCanonicalZone = (zone: string) => canonicalZone(zone) === zone;
/** Whether the zone can be read: imports and saved versions with an older name still open. */
export const isKnownZone = (zone: string) => canonicalZone(zone) !== null;
/** The older name ICU knows a renamed zone by, so pickers find it by either name. */
export const olderZoneName = (zone: string): string | undefined => olderNames[zone.toLowerCase()];
/** The same zone under either name. */
export const sameZone = (a: string, b: string) => a === b || canonicalZone(a) === canonicalZone(b);

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
  if (wall === null || !isKnownZone(zone)) return { kind: 'missing' };
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

let zoneList: string[] | undefined;
/** The zones this platform knows by their current names, sorted, for pickers. Falls back to UTC
 * on older engines. */
export function knownZones(): string[] {
  if (!zoneList) {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    const names = ['UTC', ...(supported ? supported('timeZone') : [])].map(canonicalZone);
    const rest = new Set(names.filter((z): z is string => !!z && z !== 'UTC'));
    zoneList = ['UTC', ...[...rest].sort()];
  }
  return zoneList;
}
