/**
 * A small XML reader for PLCopen TC6 files (SL6b): elements, attributes, text and CDATA. Names
 * keep only their local part (the prefix is dropped) and each element carries its namespace,
 * resolved from the `xmlns` declarations in scope (which also stay as attributes).
 * A DOCTYPE is refused (no entity expansion); only the five predefined entities and character
 * references are read. Errors are `LadderXmlError` (`xml-syntax`, `xml-doctype`, `limit-xml-*`).
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text (not its children's), entities decoded. */
  text: string;
  /** Text and child elements in document order. */
  parts: (string | XmlElement)[];
  /** The namespace URI of its name ('' when none). */
  ns: string;
}

export class LadderXmlError extends Error {
  constructor(
    readonly code: string,
    readonly detail: { what?: string; at?: number } = {},
  ) {
    super(detail.what ? `${code}: ${detail.what}` : code);
  }
}

/** Initial safety limits; not performance promises. */
export const ladderXmlLimits = Object.freeze({
  bytes: 4 * 1024 * 1024,
  depth: 64,
  elements: 200_000,
});

const legal = (n: number) =>
  n === 0x9 ||
  n === 0xa ||
  n === 0xd ||
  (n >= 0x20 && n <= 0xd7ff) ||
  (n >= 0xe000 && n <= 0xfffd) ||
  (n >= 0x10000 && n <= 0x10ffff);

/** The index of the first character XML 1.0 does not allow (lone surrogates included), or -1. */
function forbiddenAt(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const n = s.codePointAt(i)!;
    if (!legal(n)) return i;
    if (n > 0xffff) i++;
  }
  return -1;
}

const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string, at: number): string {
  return s.replace(/&([^;&\s]*);?/g, (m, body: string) => {
    if (!m.endsWith(';')) throw new LadderXmlError('xml-syntax', { what: 'entity', at });
    if (Object.hasOwn(entities, body)) return entities[body];
    const n = /^#x([0-9a-fA-F]{1,6})$/.exec(body)
      ? parseInt(body.slice(2), 16)
      : /^#([0-9]{1,7})$/.exec(body)
        ? parseInt(body.slice(1), 10)
        : NaN;
    if (!Number.isFinite(n) || !legal(n))
      throw new LadderXmlError('xml-syntax', { what: 'entity', at });
    return String.fromCodePoint(n);
  });
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);
const prefixOf = (name: string) => (name.includes(':') ? name.slice(0, name.indexOf(':')) : '');
const nameRe = /[A-Za-z_:][A-Za-z0-9_.:-]*/y;

export function parseXml(src: string): XmlElement {
  if (src.length > ladderXmlLimits.bytes) throw new LadderXmlError('limit-xml-size');
  const bad = forbiddenAt(src);
  if (bad >= 0) throw new LadderXmlError('xml-syntax', { what: 'character', at: bad });
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let count = 0;
  const fail = (what: string): never => {
    throw new LadderXmlError('xml-syntax', { what, at: i });
  };
  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const readName = () => {
    nameRe.lastIndex = i;
    const m = nameRe.exec(src);
    if (!m) fail('name');
    i += m![0].length;
    return m![0];
  };
  /** Comments, processing instructions and white space between elements. */
  const skipMisc = () => {
    for (;;) {
      skipSpace();
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4);
        if (end < 0) fail('comment');
        i = end + 3;
      } else if (src.startsWith('<?', i)) {
        const end = src.indexOf('?>', i + 2);
        if (end < 0) fail('processing instruction');
        i = end + 2;
      } else if (src.startsWith('<!DOCTYPE', i) || src.startsWith('<!doctype', i))
        throw new LadderXmlError('xml-doctype', { at: i });
      else return;
    }
  };
  const element = (depth: number, scope: ReadonlyMap<string, string>): XmlElement => {
    if (depth > ladderXmlLimits.depth) throw new LadderXmlError('limit-xml-depth');
    if (++count > ladderXmlLimits.elements) throw new LadderXmlError('limit-xml-elements');
    if (src[i] !== '<') fail('element');
    i++;
    const qname = readName();
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    let empty = false;
    for (;;) {
      skipSpace();
      if (src.startsWith('/>', i)) {
        i += 2;
        empty = true;
        break;
      }
      if (src[i] === '>') {
        i++;
        break;
      }
      const an = readName();
      skipSpace();
      if (src[i] !== '=') fail('attribute');
      i++;
      skipSpace();
      const q = src[i];
      if (q !== '"' && q !== "'") fail('attribute quote');
      const end = src.indexOf(q, i + 1);
      if (end < 0) fail('attribute end');
      const raw = src.slice(i + 1, end);
      if (raw.includes('<')) fail('attribute value');
      const key = an.startsWith('xmlns') ? an : local(an);
      if (Object.hasOwn(attrs, key)) fail('attribute duplicate');
      attrs[key] = decode(raw, i);
      i = end + 1;
    }
    // Namespaces in scope for this element and its children.
    let inner = scope;
    for (const k of Object.keys(attrs))
      if (k === 'xmlns' || k.startsWith('xmlns:')) {
        if (inner === scope) inner = new Map(scope);
        (inner as Map<string, string>).set(k === 'xmlns' ? '' : k.slice(6), attrs[k]);
      }
    const prefix = prefixOf(qname);
    const ns = inner.get(prefix) ?? (prefix ? fail('namespace prefix') : '');
    if (empty) return { name: local(qname), attrs, children: [], text: '', parts: [], ns };
    const children: XmlElement[] = [];
    const parts: (string | XmlElement)[] = [];
    let text = '';
    const addText = (t: string) => {
      text += t;
      if (typeof parts.at(-1) === 'string') parts[parts.length - 1] += t;
      else parts.push(t);
    };
    for (;;) {
      if (i >= src.length) fail('end of input');
      if (src.startsWith('</', i)) {
        i += 2;
        if (readName() !== qname) fail('end tag');
        skipSpace();
        if (src[i] !== '>') fail('end tag');
        i++;
        return { name: local(qname), attrs, children, text, parts, ns };
      }
      if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i + 9);
        if (end < 0) fail('CDATA');
        addText(src.slice(i + 9, end));
        i = end + 3;
      } else if (src.startsWith('<!--', i) || src.startsWith('<?', i)) {
        const close = src.startsWith('<!--', i) ? '-->' : '?>';
        const end = src.indexOf(close, i + 2);
        if (end < 0) fail('comment');
        i = end + close.length;
      } else if (src.startsWith('<!', i)) {
        fail('declaration');
      } else if (src[i] === '<') {
        const child = element(depth + 1, inner);
        children.push(child);
        parts.push(child);
      } else {
        const end = src.indexOf('<', i);
        const stop = end < 0 ? src.length : end;
        addText(decode(src.slice(i, stop), i));
        i = stop;
      }
    }
  };
  skipMisc();
  const root = element(1, new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]));
  skipMisc();
  if (i < src.length) fail('content after the root element');
  return root;
}

/** The children called `name` (local name). */
export const xmlChildren = (e: XmlElement, name: string) =>
  e.children.filter((c) => c.name === name);
/** The first child called `name`. */
export const xmlChild = (e: XmlElement | undefined, name: string) =>
  e?.children.find((c) => c.name === name);
/** All text inside, children's included, in document order. */
export const xmlText = (e: XmlElement): string =>
  e.parts.map((p) => (typeof p === 'string' ? p : xmlText(p))).join('');

/**
 * Text and attribute escaping. Tabs, line feeds and carriage returns are character references,
 * so a standard XML reader's end-of-line and attribute normalisation keeps them as written.
 * A character XML cannot carry at all (U+0001, a lone surrogate…) is refused (`xml-char`).
 */
export const xmlEscape = (s: string) => {
  const bad = forbiddenAt(s);
  if (bad >= 0)
    throw new LadderXmlError('xml-char', {
      what: `U+${s.charCodeAt(bad).toString(16).toUpperCase().padStart(4, '0')}`,
    });
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
};
