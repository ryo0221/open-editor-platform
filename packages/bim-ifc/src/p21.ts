import type { P21Value } from '@editor-platform/geometry-core';
import { sha256 } from '@noble/hashes/sha256';

/**
 * A minimal ISO 10303-21 writer for the IFC4 subset `bim-ifc` writes (ADR 018). It knows no
 * schema: the caller passes each entity's attributes in schema order. The value model and the
 * reader are `geometry-core`'s.
 */

export type { P21Value };

export const $: P21Value = { t: 'unset' };
export const derived: P21Value = { t: 'derived' };
export const enumOf = (v: string): P21Value => ({ t: 'enum', v });
export const real = (v: number): P21Value => ({ t: 'real', v });
export const int = (v: number): P21Value => ({ t: 'int', v });
export const str = (v: string): P21Value => ({ t: 'str', v });
export const bool = (v: boolean): P21Value => ({ t: 'bool', v });
export const list = (v: P21Value[]): P21Value => ({ t: 'list', v });
export const reals = (v: readonly number[]): P21Value => list(v.map(real));
/** A value of a defined type where a SELECT needs its name, e.g. `IFCLABEL('x')`. */
export const typed = (name: string, v: P21Value): P21Value => ({ t: 'typed', name, v });
/** `undefined` and `null` become `$`. */
export const opt = <T>(v: T | undefined | null, f: (x: T) => P21Value): P21Value =>
  v === undefined || v === null ? $ : f(v);

export class P21Error extends Error {}

/** REAL in P21 form: always a decimal point, upper-case exponent, shortest round-trip digits. */
export function formatReal(v: number): string {
  if (!Number.isFinite(v)) throw new P21Error('non-finite-real');
  if (Object.is(v, -0) || v === 0) return '0.';
  const s = String(v);
  const [mant, exp] = s.split('e');
  const m = mant.includes('.') ? mant : `${mant}.`;
  return exp === undefined ? m : `${m}E${exp.replace('+', '')}`;
}

/** STRING in P21 form: printable ASCII as is (`'` and `\` doubled), anything else `\X2\…\X0\`. */
export function formatString(v: string): string {
  let out = "'";
  let wide = '';
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    wide = '';
  };
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += c === 0x27 ? "''" : c === 0x5c ? '\\\\' : v[i];
    } else wide += c.toString(16).toUpperCase().padStart(4, '0');
  }
  flush();
  return `${out}'`;
}

function formatValue(v: P21Value): string {
  switch (v.t) {
    case 'ref':
      return `#${v.id}`;
    case 'enum':
      return `.${v.v}.`;
    case 'typed':
      return `${v.name}(${formatValue(v.v)})`;
    case 'real':
      return formatReal(v.v);
    case 'int':
      if (!Number.isSafeInteger(v.v)) throw new P21Error('non-integer');
      return String(v.v);
    case 'str':
      return formatString(v.v);
    case 'bool':
      return v.v ? '.T.' : '.F.';
    case 'binary':
      return `"${v.v}"`;
    case 'list':
      return `(${v.v.map(formatValue).join(',')})`;
    case 'unset':
      return '$';
    case 'derived':
      return '*';
  }
}

export interface P21Header {
  description: string[];
  implementationLevel: string;
  name: string;
  /** ISO 8601 time stamp; the saved version's time, so the same content gives the same bytes. */
  timeStamp: string;
  author: string[];
  organization: string[];
  preprocessorVersion: string;
  originatingSystem: string;
  authorization: string;
  schemas: string[];
}

export class P21Writer {
  private lines: string[] = [];
  /** Appends an entity instance and returns a reference to it. */
  add(name: string, args: P21Value[]): P21Value {
    const id = this.lines.length + 1;
    this.lines.push(`#${id}=${name}(${args.map(formatValue).join(',')});`);
    return { t: 'ref', id };
  }
  get count() {
    return this.lines.length;
  }
  text(h: P21Header): string {
    const strs = (a: string[]) => `(${a.map(formatString).join(',')})`;
    return [
      'ISO-10303-21;',
      'HEADER;',
      `FILE_DESCRIPTION(${strs(h.description)},${formatString(h.implementationLevel)});`,
      `FILE_NAME(${formatString(h.name)},${formatString(h.timeStamp)},${strs(h.author)},${strs(h.organization)},${formatString(h.preprocessorVersion)},${formatString(h.originatingSystem)},${formatString(h.authorization)});`,
      `FILE_SCHEMA(${strs(h.schemas)});`,
      'ENDSEC;',
      'DATA;',
      ...this.lines,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n');
  }
}

const guidChars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
/** The 22-character compressed form of a 128-bit GUID (IfcGloballyUniqueId). */
export function compressGuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new P21Error('guid-length');
  const b64 = (v: number, n: number) => {
    let s = '';
    for (let i = n - 1; i >= 0; i--) s += guidChars[Math.floor(v / 64 ** i) % 64];
    return s;
  };
  let out = b64(bytes[0], 2);
  for (let i = 1; i < 16; i += 3)
    out += b64((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2], 4);
  return out;
}
/** A stable GlobalId for `key`: the same key always gives the same ID (RFC 4122 v8-style bits). */
export function stableGuid(key: string): string {
  const h = sha256(new TextEncoder().encode(key)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  return compressGuid(h);
}
export const isIfcGuid = (s: string) => s.length === 22 && /^[0-3][0-9A-Za-z_$]{21}$/.test(s);
