/**
 * ISO 10303-21 (P21) exchange structure: the value model and a reader (docs/cad/r2c-architecture.md,
 * `geometry-core`; ADR 018). The reader knows no schema: it returns entity instances by ID with
 * their attribute values, and the caller maps the types it supports. Limits are enforced while
 * reading, so an oversized or deeply nested file stops early.
 */

export type P21Value =
  | { t: 'ref'; id: number }
  | { t: 'enum'; v: string }
  | { t: 'typed'; name: string; v: P21Value }
  | { t: 'real'; v: number }
  | { t: 'int'; v: number }
  | { t: 'str'; v: string }
  /** Written as `.T.` / `.F.`; the reader returns these as enums, as P21 does not tell them apart. */
  | { t: 'bool'; v: boolean }
  | { t: 'binary'; v: string }
  | { t: 'list'; v: P21Value[] }
  | { t: 'unset' }
  | { t: 'derived' };

/** One instance: a simple entity, or a complex one (`#1=(A(…)B(…));`) as its partial entities. */
export interface P21Instance {
  id: number;
  /** Upper-case entity name; empty for a complex instance. */
  type: string;
  args: P21Value[];
  parts?: { type: string; args: P21Value[] }[];
}

export interface P21File {
  /** Header entities in order (FILE_DESCRIPTION, FILE_NAME, FILE_SCHEMA, …). */
  header: { type: string; args: P21Value[] }[];
  /** Data instances by ID, in file order. */
  entities: Map<number, P21Instance>;
}

export interface P21Limits {
  bytes: number;
  entities: number;
  /** Nesting of lists and typed values inside one attribute. */
  depth: number;
}

export interface P21ReadOptions {
  /**
   * `keep` returns references to missing instances as they are, for a caller that only scans
   * the file and leaves its reading to another reader (the STEP import). `check` by default.
   */
  references?: 'check' | 'keep';
}

export type P21ReadCode =
  | 'p21-too-large'
  | 'p21-too-many-entities'
  | 'p21-too-deep'
  | 'p21-syntax'
  | 'p21-duplicate-id'
  | 'p21-unresolved-reference';

export class P21ReadError extends Error {
  constructor(
    readonly code: P21ReadCode,
    readonly detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * Text of the file: UTF-8 when it decodes as such (some writers put raw UTF-8 in strings), else
 * Latin-1, which keeps every byte. The structure itself is 7-bit.
 */
function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

const latinDecoders = new Map<number, TextDecoder>();
/** A decoder for ISO 8859 part 2–9, refusing positions the part leaves undefined. */
function latinPart(part: number): TextDecoder {
  let d = latinDecoders.get(part);
  if (!d) latinDecoders.set(part, (d = new TextDecoder(`iso-8859-${part}`)));
  return d;
}

/** Decodes the control directives of a P21 string (`\X\hh`, `\X2\…\X0\`, `\X4\…\X0\`, `\S\c`, `\Px\`). */
function unescape(raw: string, fail: (detail: string) => never): string {
  let out = '';
  let i = 0;
  // The ISO 8859 part `\S\` characters are read in: part 1 at the start of every string.
  let part = 1;
  const hex = (s: string) => (/^[0-9A-Fa-f]+$/.test(s) ? parseInt(s, 16) : NaN);
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'") {
      // Only doubled apostrophes reach here.
      out += "'";
      i += 2;
    } else if (c !== '\\') {
      out += c;
      i++;
    } else if (raw[i + 1] === '\\') {
      out += '\\';
      i += 2;
    } else if (raw.startsWith('\\X\\', i)) {
      const v = hex(raw.slice(i + 3, i + 5));
      if (Number.isNaN(v)) fail('string-escape');
      out += String.fromCharCode(v);
      i += 5;
    } else if (raw.startsWith('\\X2\\', i) || raw.startsWith('\\X4\\', i)) {
      const width = raw[i + 2] === '2' ? 4 : 8;
      const end = raw.indexOf('\\X0\\', i + 4);
      if (end < 0) fail('string-escape');
      const body = raw.slice(i + 4, end);
      if (body.length % width) fail('string-escape');
      for (let k = 0; k < body.length; k += width) {
        const v = hex(body.slice(k, k + width));
        if (Number.isNaN(v) || v > 0x10ffff) fail('string-escape');
        out += width === 4 ? String.fromCharCode(v) : String.fromCodePoint(v);
      }
      i = end + 4;
    } else if (raw.startsWith('\\S\\', i) && i + 3 < raw.length) {
      const byte = raw.charCodeAt(i + 3) + 128;
      if (byte > 0xff) fail('string-escape');
      if (part === 1) out += String.fromCharCode(byte);
      else {
        // The upper half only: below 0xA0 the decoder's labels map to Windows code pages.
        const ch = byte < 0xa0 ? '\ufffd' : latinPart(part).decode(new Uint8Array([byte]));
        if (ch === '\ufffd') fail('string-escape');
        out += ch;
      }
      i += 4;
    } else if (/^\\P[A-I]\\/.test(raw.slice(i, i + 4))) {
      part = raw.charCodeAt(i + 2) - 64;
      i += 4;
    } else fail('string-escape');
  }
  return out;
}

/**
 * Reads a P21 exchange structure. Refuses rather than repairs: a syntax error, an instance ID
 * used twice, a reference to a missing instance (unless `references: 'keep'`), or a limit
 * exceeded.
 */
export function readP21(
  bytes: Uint8Array,
  limits: P21Limits,
  options: P21ReadOptions = {},
): P21File {
  if (bytes.length > limits.bytes) throw new P21ReadError('p21-too-large', String(bytes.length));
  const s = decode(bytes);
  let i = 0;
  const fail = (detail: string): never => {
    const line = s.slice(0, i).split('\n').length;
    throw new P21ReadError('p21-syntax', `${detail} (line ${line})`);
  };
  /** Skips whitespace and comments. */
  const skip = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === '/' && s[i + 1] === '*') {
        const end = s.indexOf('*/', i + 2);
        if (end < 0) fail('comment');
        i = end + 2;
      } else return;
    }
  };
  const expect = (token: string) => {
    skip();
    if (!s.startsWith(token, i)) fail(`expected ${token}`);
    i += token.length;
  };
  const keyword = () => {
    skip();
    const m = /^!?[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i, i + 256));
    if (!m) fail('keyword');
    i += m![0].length;
    return m![0].toUpperCase();
  };
  const value = (depth: number): P21Value => {
    if (depth > limits.depth) throw new P21ReadError('p21-too-deep', String(depth));
    skip();
    const c = s[i];
    if (c === '$') {
      i++;
      return { t: 'unset' };
    }
    if (c === '*') {
      i++;
      return { t: 'derived' };
    }
    if (c === '#') {
      const m = /^#(\d+)/.exec(s.slice(i, i + 32));
      if (!m) fail('reference');
      i += m![0].length;
      return { t: 'ref', id: Number(m![1]) };
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) fail('unterminated string');
        if (s[j] === "'") {
          if (s[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      const raw = s.slice(i + 1, j);
      i = j + 1;
      return { t: 'str', v: unescape(raw, fail) };
    }
    if (c === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) fail('unterminated binary');
      const v = s.slice(i + 1, end);
      if (!/^[0-3][0-9A-Fa-f]*$/.test(v)) fail('binary');
      i = end + 1;
      return { t: 'binary', v };
    }
    if (c === '.') {
      const m = /^\.([A-Za-z_][A-Za-z0-9_]*)\./.exec(s.slice(i, i + 256));
      if (!m) fail('enumeration');
      i += m![0].length;
      return { t: 'enum', v: m![1].toUpperCase() };
    }
    if (c === '(') {
      i++;
      const items: P21Value[] = [];
      skip();
      if (s[i] === ')') {
        i++;
        return { t: 'list', v: items };
      }
      for (;;) {
        items.push(value(depth + 1));
        skip();
        if (s[i] === ',') i++;
        else if (s[i] === ')') {
          i++;
          return { t: 'list', v: items };
        } else fail('list');
      }
    }
    const num = /^[+-]?\d+(\.\d*(?:[Ee][+-]?\d+)?)?/.exec(s.slice(i, i + 64));
    if (num) {
      i += num[0].length;
      const v = Number(num[0]);
      if (!Number.isFinite(v)) fail('number');
      return num[1] !== undefined ? { t: 'real', v } : { t: 'int', v };
    }
    if (/[A-Za-z]/.test(c ?? '')) {
      const name = keyword();
      expect('(');
      const v = value(depth + 1);
      expect(')');
      return { t: 'typed', name, v };
    }
    return fail('value');
  };
  /** `(` args `)` of one entity. */
  const args = (): P21Value[] => {
    const v = value(0);
    if (v.t !== 'list') fail('parameters');
    return (v as { v: P21Value[] }).v;
  };
  const entity = () => {
    const type = keyword();
    skip();
    if (s[i] !== '(') fail('parameters');
    return { type, args: args() };
  };

  skip();
  expect('ISO-10303-21');
  expect(';');
  expect('HEADER');
  expect(';');
  const header: P21File['header'] = [];
  for (;;) {
    skip();
    if (s.startsWith('ENDSEC', i)) break;
    header.push(entity());
    expect(';');
  }
  expect('ENDSEC');
  expect(';');
  const entities = new Map<number, P21Instance>();
  for (;;) {
    skip();
    if (s.startsWith('END-ISO-10303-21', i)) break;
    expect('DATA');
    skip();
    // An optional parameter list naming the section (P21 edition 3).
    if (s[i] === '(') args();
    expect(';');
    for (;;) {
      skip();
      if (s.startsWith('ENDSEC', i)) break;
      // The ID, then `=` after any whitespace or comments.
      const m = /^#(\d+)/.exec(s.slice(i, i + 32));
      if (!m) fail('instance');
      i += m![0].length;
      expect('=');
      const id = Number(m![1]);
      if (entities.has(id)) throw new P21ReadError('p21-duplicate-id', `#${id}`);
      if (entities.size >= limits.entities)
        throw new P21ReadError('p21-too-many-entities', String(entities.size + 1));
      skip();
      if (s[i] === '(') {
        // Complex instance: a list of partial entities.
        i++;
        const parts: { type: string; args: P21Value[] }[] = [];
        for (;;) {
          skip();
          if (s[i] === ')') {
            i++;
            break;
          }
          parts.push(entity());
        }
        if (!parts.length) fail('complex instance');
        entities.set(id, { id, type: '', args: [], parts });
      } else entities.set(id, { id, ...entity() });
      expect(';');
    }
    expect('ENDSEC');
    expect(';');
  }
  expect('END-ISO-10303-21');
  expect(';');
  skip();
  if (i < s.length) fail('trailing content');
  if (options.references === 'keep') return { header, entities };
  const check = (v: P21Value) => {
    if (v.t === 'ref' && !entities.has(v.id))
      throw new P21ReadError('p21-unresolved-reference', `#${v.id}`);
    if (v.t === 'list') v.v.forEach(check);
    if (v.t === 'typed') check(v.v);
  };
  for (const e of entities.values()) {
    e.args.forEach(check);
    e.parts?.forEach((p) => p.args.forEach(check));
  }
  return { header, entities };
}
