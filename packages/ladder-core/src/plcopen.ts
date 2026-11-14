import {
  ladderCompareOps,
  ladderLimits,
  ladderTimerTypes,
  ladderTypes,
  type LadderCoil,
  type LadderCompareOp,
  type LadderDocument,
  type LadderNode,
  type LadderOperand,
  type LadderRung,
  type LadderType,
  type LadderVariable,
} from './model';
import { validateLadder } from './validate';
import {
  LadderXmlError,
  parseXml,
  xmlChild,
  xmlChildren,
  xmlEscape,
  xmlText,
  type XmlElement,
} from './xml';

/**
 * A comment's text: exactly what one XHTML paragraph holds (as this exporter writes it, so
 * leading and trailing spaces and newlines read back); otherwise all text inside, trimmed.
 */
function commentText(e: XmlElement): string {
  const p = xmlChild(e, 'p');
  return p && e.children.length === 1 ? xmlText(p) : xmlText(e).trim();
}

/**
 * PLCopen TC6 XML (v2.01) for the ladder program (docs/cad/circuit-simulation.md, SL6, SL-U4):
 * one `program` POU with an `LD` body. The mapping:
 *
 * - variables: `inputVars` / `outputVars` / `localVars` → roles input / output / internal; types
 *   BOOL, INT, TIME, and TON / TOF / TP / CTU / CTD as `derived`; `initialValue/simpleValue`;
 *   the comment as `documentation`.
 * - a rung: its own `leftPowerRail`, the network as contacts and blocks joined by `connection`s
 *   (a parallel is a wired OR: the next element lists every branch's end), coils fed by the
 *   network's end, a `rightPowerRail`, and the rung comment as a `comment` before it.
 * - contacts: `negated` (NC) or `edge` rising / falling; coils: `negated` or `storage` set / reset.
 * - a timer: a `block` TON / TOF / TP with `instanceName`, power through IN → Q, PT from an
 *   `inVariable` `T#…ms`; a counter: CTU (CU, R) / CTD (CD, LD) → Q, PV from an `inVariable`, the
 *   reset or load variable from an `inVariable`; a compare: GT / GE / EQ / NE / LT / LE with
 *   power into EN and out of OUT (read as EN AND (IN1 op IN2)), operands from `inVariable`s.
 * - the scan period: the `task` interval in `instances`.
 *
 * Reading accepts what this mapping writes, rebuilding the series / parallel tree from the
 * connections, and refuses anything else as `plcopen-unsupported` (with what). Rungs are read in
 * the order of their first coil; a `comment` belongs to the next rung. Variable `address`es and
 * element positions are not kept.
 */
export const plcopenNamespace = 'http://www.plcopen.org/xml/tc6_0201';

// Writing ------------------------------------------------------------------------------------

const cell = { x: 80, y: 60 };
const compareNames: Record<LadderCompareOp, string> = {
  eq: 'EQ',
  ne: 'NE',
  gt: 'GT',
  ge: 'GE',
  lt: 'LT',
  le: 'LE',
};

/** Columns and rows a node takes in the written layout (positions are informative only). */
function size(n: LadderNode): { w: number; h: number } {
  switch (n.kind) {
    case 'series': {
      const s = n.items.map(size);
      return { w: s.reduce((a, b) => a + b.w, 0), h: Math.max(1, ...s.map((b) => b.h)) };
    }
    case 'parallel': {
      const s = n.branches.map(size);
      return { w: Math.max(1, ...s.map((b) => b.w)), h: s.reduce((a, b) => a + b.h, 0) };
    }
    case 'contact':
      return { w: 1, h: 1 };
    default:
      return { w: 2, h: 2 };
  }
}

const timeLiteral = (ms: number) => `T#${ms}ms`;
const operandText = (o: LadderOperand) =>
  'value' in o ? String(o.value) : o.member ? `${o.variable}.${o.member}` : o.variable;

/**
 * The program as a PLCopen TC6 XML document. Refused (`LadderXmlError`) when the file would not
 * read back as the same program: past the reader's limits, or a network it cannot rebuild
 * (`plcopen-unsupported`).
 */
export function ladderToPlcopen(doc: LadderDocument, options: { created?: string } = {}): string {
  const xml = writePlcopen(doc, options);
  // Only what reads back the same is written: a network the reader cannot rebuild, or a file
  // past the reader's limits, is refused here rather than saved unreadable.
  const back = ladderFromPlcopen(xml);
  if (stable(ladderCanonical(back)) !== stable(ladderCanonical(doc)))
    throw new LadderXmlError('plcopen-unsupported', { what: 'network that does not read back' });
  return xml;
}
/** JSON with keys in a fixed order. */
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

function writePlcopen(doc: LadderDocument, options: { created?: string }): string {
  const created = options.created ?? '1970-01-01T00:00:00';
  const out: string[] = [];
  let next = 1;
  const pos = (x: number, y: number) => `<position x="${x}" y="${y}"/>`;
  const conns = (refs: Ref[]) =>
    refs
      .map(
        (r) =>
          `<connection refLocalId="${r.id}"${r.formal ? ` formalParameter="${r.formal}"` : ''}/>`,
      )
      .join('');
  const pointIn = (refs: Ref[]) => `<connectionPointIn>${conns(refs)}</connectionPointIn>`;
  const inVariable = (expression: string, x: number, y: number) => {
    const id = next++;
    out.push(
      `<inVariable localId="${id}" height="20" width="60">${pos(x, y)}<connectionPointOut/>` +
        `<expression>${xmlEscape(expression)}</expression></inVariable>`,
    );
    return id;
  };
  const block = (
    typeName: string,
    instance: string | undefined,
    inputs: [string, Ref[] | undefined][],
    outputs: string[],
    x: number,
    y: number,
  ) => {
    const id = next++;
    out.push(
      `<block localId="${id}" typeName="${typeName}"` +
        `${instance ? ` instanceName="${xmlEscape(instance)}"` : ''} height="${cell.y * 2 - 20}" width="${cell.x * 2 - 20}">` +
        `${pos(x, y)}<inputVariables>` +
        inputs
          .map(
            ([f, refs]) =>
              `<variable formalParameter="${f}">` +
              (refs ? pointIn(refs) : '<connectionPointIn/>') +
              '</variable>',
          )
          .join('') +
        '</inputVariables><inOutVariables/><outputVariables>' +
        outputs
          .map((f) => `<variable formalParameter="${f}"><connectionPointOut/></variable>`)
          .join('') +
        '</outputVariables></block>',
    );
    return id;
  };
  /** Writes `n` fed by `inputs` at grid (col,row); returns the points its power leaves by. */
  const emit = (n: LadderNode, inputs: Ref[], col: number, row: number, y0: number): Ref[] => {
    const x = 40 + col * cell.x;
    const y = y0 + row * cell.y;
    switch (n.kind) {
      case 'series': {
        let refs = inputs;
        let c = col;
        for (const item of n.items) {
          refs = emit(item, refs, c, row, y0);
          c += size(item).w;
        }
        return refs;
      }
      case 'parallel': {
        // A wired OR: each point once (two bypasses pass on the same points, not twice as many).
        const refs: Ref[] = [];
        const seen = new Set<string>();
        let r = row;
        for (const b of n.branches) {
          for (const ref of emit(b, inputs, col, r, y0)) {
            const k = `${ref.id}:${ref.formal ?? ''}`;
            if (!seen.has(k)) {
              seen.add(k);
              refs.push(ref);
            }
          }
          r += size(b).h;
        }
        return refs;
      }
      case 'contact': {
        const id = next++;
        const attrs =
          n.contact === 'nc'
            ? ' negated="true"'
            : n.contact === 'rising' || n.contact === 'falling'
              ? ` edge="${n.contact}"`
              : '';
        out.push(
          `<contact localId="${id}" height="20" width="20"${attrs}>${pos(x, y)}${pointIn(inputs)}` +
            `<connectionPointOut/><variable>${xmlEscape(n.variable)}</variable></contact>`,
        );
        return [{ id }];
      }
      case 'timer': {
        const pt = inVariable(timeLiteral(n.presetMs), x - 70, y + 30);
        const id = block(
          ladderTypeOf(doc, n.instance),
          n.instance,
          [
            ['IN', inputs],
            ['PT', [{ id: pt }]],
          ],
          ['Q', 'ET'],
          x,
          y,
        );
        return [{ id, formal: 'Q' }];
      }
      case 'counter': {
        const type = ladderTypeOf(doc, n.instance);
        const down = type === 'CTD';
        const reset = n.reset ? inVariable(n.reset, x - 70, y + 20) : undefined;
        const pv = inVariable(String(n.preset), x - 70, y + 40);
        const id = block(
          type,
          n.instance,
          [
            [down ? 'CD' : 'CU', inputs],
            [down ? 'LD' : 'R', reset ? [{ id: reset }] : undefined],
            ['PV', [{ id: pv }]],
          ],
          ['Q', 'CV'],
          x,
          y,
        );
        return [{ id, formal: 'Q' }];
      }
      case 'compare': {
        const a = inVariable(operandText(n.a), x - 70, y + 20);
        const b = inVariable(operandText(n.b), x - 70, y + 40);
        const id = block(
          compareNames[n.op],
          undefined,
          [
            ['EN', inputs],
            ['IN1', [{ id: a }]],
            ['IN2', [{ id: b }]],
          ],
          ['ENO', 'OUT'],
          x,
          y,
        );
        return [{ id, formal: 'OUT' }];
      }
    }
  };
  let y0 = 20;
  for (const rung of doc.rungs) {
    const s = size(rung.network);
    if (rung.comment !== undefined)
      out.push(
        `<comment localId="${next++}" height="40" width="400">${pos(40, y0)}<content>` +
          `<xhtml:p xmlns:xhtml="http://www.w3.org/1999/xhtml">${xmlEscape(rung.comment)}</xhtml:p>` +
          '</content></comment>',
      );
    if (rung.comment !== undefined) y0 += 50;
    const left = next++;
    out.push(
      `<leftPowerRail localId="${left}" height="${s.h * cell.y}" width="10">${pos(20, y0)}` +
        '<connectionPointOut formalParameter=""/></leftPowerRail>',
    );
    const ends = emit(rung.network, [{ id: left }], 0, 0, y0);
    const coilX = 40 + (s.w + 1) * cell.x;
    const coils = rung.coils.map((c, k) => {
      const id = next++;
      const attrs =
        c.coil === 'negated'
          ? ' negated="true"'
          : c.coil === 'set' || c.coil === 'reset'
            ? ` storage="${c.coil}"`
            : '';
      out.push(
        `<coil localId="${id}" height="20" width="20"${attrs}>${pos(coilX, y0 + k * cell.y)}` +
          `${pointIn(ends)}<connectionPointOut/><variable>${xmlEscape(c.variable)}</variable></coil>`,
      );
      return { id };
    });
    out.push(
      `<rightPowerRail localId="${next++}" height="${Math.max(s.h, rung.coils.length) * cell.y}" width="10">` +
        `${pos(coilX + cell.x, y0)}` +
        coils.map((c) => pointIn([c])).join('') +
        '</rightPowerRail>',
    );
    y0 += Math.max(s.h, rung.coils.length) * cell.y + 20;
  }
  const varList = (role: LadderVariable['role'], tag: string) => {
    const vs = doc.variables.filter((v) => v.role === role);
    if (!vs.length) return '';
    return (
      `<${tag}>` +
      vs
        .map((v) => {
          const elementary = v.type === 'BOOL' || v.type === 'INT' || v.type === 'TIME';
          const type = elementary ? `<${v.type}/>` : `<derived name="${v.type}"/>`;
          const initial =
            v.initial === undefined
              ? ''
              : `<initialValue><simpleValue value="${
                  v.type === 'BOOL'
                    ? v.initial
                      ? 'TRUE'
                      : 'FALSE'
                    : v.type === 'TIME'
                      ? timeLiteral(v.initial as number)
                      : String(v.initial)
                }"/></initialValue>`;
          const docs =
            v.comment === undefined
              ? ''
              : `<documentation><xhtml:p xmlns:xhtml="http://www.w3.org/1999/xhtml">${xmlEscape(v.comment)}</xhtml:p></documentation>`;
          return `<variable name="${xmlEscape(v.name)}"><type>${type}</type>${initial}${docs}</variable>`;
        })
        .join('') +
      `</${tag}>`
    );
  };
  const scaling = '<scaling x="1" y="1"/>';
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<project xmlns="${plcopenNamespace}">`,
    `<fileHeader companyName="" productName="editor-platform ladder" productVersion="1" creationDateTime="${created}"/>`,
    `<contentHeader name="${xmlEscape(doc.name)}">`,
    `<coordinateInfo><fbd>${scaling}</fbd><ld>${scaling}</ld><sfc>${scaling}</sfc></coordinateInfo>`,
    '</contentHeader>',
    '<types><dataTypes/><pous>',
    '<pou name="Main" pouType="program">',
    '<interface>' +
      varList('input', 'inputVars') +
      varList('output', 'outputVars') +
      varList('internal', 'localVars') +
      '</interface>',
    '<body><LD>',
    ...out,
    '</LD></body>',
    '</pou>',
    '</pous></types>',
    '<instances><configurations><configuration name="Config"><resource name="Resource">' +
      `<task name="Scan" interval="${timeLiteral(doc.scanMs)}" priority="0">` +
      '<pouInstance name="MainInstance" typeName="Main"/></task>' +
      '</resource></configuration></configurations></instances>',
    '</project>',
    '',
  ].join('\n');
}

interface Ref {
  id: number;
  formal?: string;
}

function ladderTypeOf(doc: LadderDocument, name: string): LadderType {
  const key = name.toUpperCase();
  return doc.variables.find((v) => v.name.toUpperCase() === key)?.type ?? 'TON';
}

// Reading ------------------------------------------------------------------------------------

const unsupported = (what: string): never => {
  throw new LadderXmlError('plcopen-unsupported', { what });
};
/** An XML Schema boolean attribute (`true`/`1`, `false`/`0`, absent = false). */
const xmlBool = (v: string | undefined, what: string) =>
  v === undefined || v === 'false' || v === '0'
    ? false
    : v === 'true' || v === '1'
      ? true
      : unsupported(`${what} ${v}`);
/** A pin or variable with a modifier (negation, edge, storage) the mapping has no place for. */
const plain = (e: XmlElement, what: string) => {
  if (xmlBool(e.attrs.negated, `${what} negated`)) unsupported(`${what} negated`);
  if ((e.attrs.edge ?? 'none') !== 'none') unsupported(`${what} edge`);
  if ((e.attrs.storage ?? 'none') !== 'none') unsupported(`${what} storage`);
};

/** `T#500ms`, `TIME#1s500ms`, `t#2m` → ms; undefined when it is not a whole-ms time literal. */
export function ladderTimeLiteral(text: string): number | undefined {
  const m = /^(?:T|TIME)#(.+)$/i.exec(text.trim());
  if (!m) return undefined;
  const body = m[1].replace(/_/g, '').toLowerCase();
  const scale: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  const re = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/y;
  let ms = 0;
  let at = 0;
  while (at < body.length) {
    re.lastIndex = at;
    const p = re.exec(body);
    if (!p) return undefined;
    ms += Number(p[1]) * scale[p[2]];
    at = re.lastIndex;
  }
  if (!body.length) return undefined;
  const r = Math.round(ms);
  return Math.abs(r - ms) < 1e-6 && r <= 2 ** 31 - 1 ? r : undefined;
}

const intLiteral = (text: string) => {
  const t = text.trim();
  return /^[+-]?\d{1,10}$/.test(t) ? Number(t) : undefined;
};

type Expr = { t: 'leaf'; id: number } | { t: 'seq'; items: Expr[] } | { t: 'alt'; items: Expr[] };
/**
 * A structural key. Expressions share sub-expressions (a fan-out), so keys are cached per object
 * and children are named by a short interned number: the work stays linear in the distinct
 * expressions instead of growing with every expanded copy.
 */
const keyCache = new WeakMap<Expr, string>();
const interned = new Map<string, number>();
const key = (e: Expr): string => {
  let k = keyCache.get(e);
  if (k !== undefined) return k;
  if (e.t === 'leaf') k = `L${e.id}`;
  else
    k = `${e.t}(${e.items
      .map((x) => {
        const c = key(x);
        let n = interned.get(c);
        if (n === undefined) interned.set(c, (n = interned.size));
        return n;
      })
      .join(',')})`;
  keyCache.set(e, k);
  return k;
};
const seqOf = (e: Expr) => (e.t === 'seq' ? e.items : [e]);
function seq(items: Expr[]): Expr {
  const flat = items.flatMap(seqOf);
  return flat.length === 1 ? flat[0] : { t: 'seq', items: flat };
}
/** At most this many paths are listed for a bypass match (larger ones are not matched). */
const pathCap = 512;
const pathCache = new WeakMap<Expr, string[] | null>();
/** The paths through a sequence: each the element IDs in order; undefined past `pathCap`. */
function pathsOf(items: readonly Expr[]): string[] | undefined {
  let acc: string[] = [''];
  for (const e of items) {
    const ps = pathsOfExpr(e);
    if (!ps || acc.length * ps.length > pathCap) return undefined;
    acc = acc.flatMap((a) => ps.map((p) => (a && p ? `${a},${p}` : a || p)));
  }
  return acc;
}
function pathsOfExpr(e: Expr): string[] | undefined {
  const hit = pathCache.get(e);
  if (hit !== undefined) return hit ?? undefined;
  let ps: string[] | undefined;
  if (e.t === 'leaf') ps = [String(e.id)];
  else if (e.t === 'seq') ps = pathsOf(e.items);
  else {
    ps = [];
    for (const x of e.items) {
      const q = pathsOfExpr(x);
      if (!q || ps.length + q.length > pathCap) {
        ps = undefined;
        break;
      }
      ps.push(...q);
    }
    if (ps) ps = [...new Set(ps)];
  }
  pathCache.set(e, ps ?? null);
  return ps;
}

/** A wired OR of branches, common leading elements factored out (a fan-out in the drawing). */
function alt(branches: Expr[]): Expr {
  const flat = branches.flatMap((b) => (b.t === 'alt' ? b.items : [b]));
  if (flat.length === 1) return flat[0];
  const list = flat.map(seqOf);
  // A bypass: a branch starting with a parallel H, and the paths through H also standing alone
  // (an empty branch next to a later element passes on everything H passes). Put those back
  // together as H, so H is the common head. Matched by their paths (sequences of elements), so
  // a feed already split by an upstream fan-out (B C, B D for H's B (C | D)) matches too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const b of list) {
      const h = b[0];
      if (!h || h.t !== 'alt' || b.length < 2) continue;
      const target = pathsOf([h]);
      if (!target) continue;
      const want = new Set(target);
      const found: number[] = [];
      const covered = new Set<string>();
      list.forEach((c, k) => {
        if (c === b) return;
        const ps = pathsOf(c);
        if (!ps || !ps.every((x) => want.has(x)) || ps.some((x) => covered.has(x))) return;
        for (const x of ps) covered.add(x);
        found.push(k);
      });
      if (covered.size !== want.size || !found.length) continue;
      // Already H on its own: nothing to put together.
      if (found.length === 1 && key(seq(list[found[0]])) === key(h)) continue;
      const first = Math.min(...found);
      list[first] = [h];
      for (const j of found.filter((x) => x !== first).sort((x, y) => y - x)) list.splice(j, 1);
      changed = true;
      break;
    }
  }
  const groups: { head: string; members: Expr[][] }[] = [];
  for (const items of list) {
    const head = items.length ? key(items[0]) : '';
    const g = head ? groups.find((x) => x.head === head) : undefined;
    if (g) g.members.push(items);
    else groups.push({ head, members: [items] });
  }
  const out = groups.map((g) =>
    g.members.length === 1
      ? seq(g.members[0])
      : seq([g.members[0][0], alt(g.members.map((m) => seq(m.slice(1))))]),
  );
  return out.length === 1 ? out[0] : { t: 'alt', items: out };
}

/** A program read from PLCopen TC6 XML (what `ladderToPlcopen` writes). Throws `LadderXmlError`. */
export function ladderFromPlcopen(xml: string): LadderDocument {
  interned.clear();
  const root = parseXml(xml);
  if (root.name !== 'project') throw new LadderXmlError('plcopen-shape', { what: root.name });
  const ns = root.ns;
  if (ns !== plcopenNamespace && ns !== 'http://www.plcopen.org/xml/tc6_0200')
    throw new LadderXmlError('plcopen-shape', { what: 'namespace' });
  const pous = xmlChildren(xmlChild(xmlChild(root, 'types'), 'pous') ?? root, 'pou');
  if (pous.length !== 1) unsupported(pous.length ? 'pou-count' : 'no-pou');
  const pou = pous[0];
  if (pou.attrs.pouType !== 'program') unsupported(`pouType ${pou.attrs.pouType}`);
  const body = xmlChild(pou, 'body');
  const ld = xmlChild(body, 'LD');
  if (!ld || body!.children.length !== 1) unsupported('body (not LD)');
  const name = xmlChild(root, 'contentHeader')?.attrs.name ?? pou.attrs.name ?? 'Program';

  // Variables.
  const variables: LadderVariable[] = [];
  const roles: Record<string, LadderVariable['role']> = {
    inputVars: 'input',
    outputVars: 'output',
    localVars: 'internal',
  };
  for (const section of xmlChild(pou, 'interface')?.children ?? []) {
    const role = Object.hasOwn(roles, section.name) ? roles[section.name] : undefined;
    if (!role) unsupported(section.name);
    // Memory qualifiers (RETAIN, PERSISTENT, CONSTANT) and located addresses have no place in
    // the model; reading past them would drop them on the next export.
    for (const q of ['retain', 'persistent', 'constant'])
      if (xmlBool(section.attrs[q], q)) unsupported(`${section.name} ${q}`);
    for (const v of section.children) {
      if (v.name === 'documentation') continue;
      if (v.name !== 'variable') unsupported(v.name);
      if (v.attrs.address !== undefined) unsupported(`address ${v.attrs.address}`);
      const t = xmlChild(v, 'type')?.children[0];
      const type = (t?.name === 'derived' ? t.attrs.name : t?.name) as LadderType | undefined;
      if (!type || !ladderTypes.includes(type)) unsupported(`type ${type ?? '?'}`);
      const variable: LadderVariable = { name: v.attrs.name ?? '', type: type!, role: role! };
      const init = xmlChild(v, 'initialValue');
      // Only a simple value: a block's initial state (structValue, arrayValue) has no place in
      // the model, and dropping it would change the program.
      if (init && (init.children.length !== 1 || init.children[0].name !== 'simpleValue'))
        unsupported('initialValue other than simpleValue');
      const initial = xmlChild(init, 'simpleValue')?.attrs.value;
      if (initial !== undefined) {
        const value =
          type === 'BOOL'
            ? /^(TRUE|1)$/i.test(initial)
              ? true
              : /^(FALSE|0)$/i.test(initial)
                ? false
                : undefined
            : type === 'TIME'
              ? ladderTimeLiteral(initial)
              : type === 'INT'
                ? intLiteral(initial)
                : undefined;
        if (value === undefined) unsupported(`initialValue ${initial}`);
        variable.initial = value;
      }
      const docs = xmlChild(v, 'documentation');
      if (docs) variable.comment = commentText(docs);
      variables.push(variable);
    }
  }
  const typeOf = new Map(variables.map((v) => [v.name.toUpperCase(), v.type]));

  // The drawing's elements.
  const els = new Map<number, XmlElement>();
  const order: XmlElement[] = [];
  for (const e of ld!.children) {
    if (
      ![
        'leftPowerRail',
        'rightPowerRail',
        'contact',
        'coil',
        'block',
        'inVariable',
        'comment',
      ].includes(e.name)
    )
      unsupported(e.name);
    const id = Number(e.attrs.localId);
    if (!Number.isInteger(id) || els.has(id)) unsupported(`localId ${e.attrs.localId}`);
    els.set(id, e);
    order.push(e);
  }
  // Rungs are read in document order. A declared execution order (`executionOrderId`, 0 = none)
  // is kept only when it agrees with that order; otherwise reading it would change the scan.
  let lastOrder = 0;
  for (const e of order) {
    const v = e.attrs.executionOrderId;
    if (v === undefined || v === '0') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) unsupported(`executionOrderId ${v}`);
    if (n <= lastOrder) unsupported('executionOrderId out of document order');
    lastOrder = n;
  }
  const refsOf = (point: XmlElement | undefined): Ref[] => {
    // An inline expression in place of connections is a source this reader does not take.
    if (point && xmlChild(point, 'expression')) unsupported('inline expression input');
    return xmlChildren(
      point ?? { name: '', attrs: {}, children: [], text: '', parts: [], ns: '' },
      'connection',
    ).map((c) => {
      const id = Number(c.attrs.refLocalId);
      if (!els.has(id)) unsupported(`connection to ${c.attrs.refLocalId}`);
      return { id, ...(c.attrs.formalParameter ? { formal: c.attrs.formalParameter } : {}) };
    });
  };
  const used = new Set<number>();
  const blockInput = (e: XmlElement, formal: string) =>
    xmlChildren(xmlChild(e, 'inputVariables')!, 'variable').find(
      (v) => v.attrs.formalParameter === formal,
    );
  const blockInputs = (e: XmlElement) =>
    xmlChildren(xmlChild(e, 'inputVariables') ?? e, 'variable').map((v) => v.attrs.formalParameter);
  /** The expression an inVariable fed to a block input gives (or undefined if unconnected). */
  const inText = (e: XmlElement, formal: string): string | undefined => {
    const refs = refsOf(xmlChild(blockInput(e, formal), 'connectionPointIn'));
    if (!refs.length) return undefined;
    const src = els.get(refs[0].id)!;
    if (refs.length !== 1 || src.name !== 'inVariable') unsupported(`${formal} source`);
    plain(src, `${formal} source`);
    used.add(refs[0].id);
    return xmlText(xmlChild(src, 'expression') ?? src).trim();
  };
  const blockKind = (e: XmlElement) => {
    const t = (e.attrs.typeName ?? '').toUpperCase();
    if (!xmlChild(e, 'inputVariables') || !xmlChild(e, 'outputVariables'))
      unsupported(`${e.attrs.typeName ?? 'block'} without inputVariables or outputVariables`);
    if ((ladderTimerTypes as readonly string[]).includes(t))
      return { kind: 'timer' as const, power: 'IN', out: 'Q', t };
    if (t === 'CTU') return { kind: 'counter' as const, power: 'CU', out: 'Q', t };
    if (t === 'CTD') return { kind: 'counter' as const, power: 'CD', out: 'Q', t };
    const op = ladderCompareOps.find((o) => compareNames[o] === t);
    if (op) return { kind: 'compare' as const, power: 'EN', out: 'OUT', t, op };
    return unsupported(`block ${e.attrs.typeName}`);
  };
  /** The power inputs of a contact, coil or block. */
  const powerIn = (e: XmlElement): Ref[] =>
    e.name === 'block'
      ? refsOf(xmlChild(blockInput(e, blockKind(e).power), 'connectionPointIn'))
      : refsOf(xmlChild(e, 'connectionPointIn'));

  const memo = new Map<number, Expr>();
  const visiting = new Set<number>();
  const outOf = (r: Ref): Expr => {
    const e = els.get(r.id)!;
    if (e.name === 'leftPowerRail') {
      used.add(r.id);
      return { t: 'seq', items: [] };
    }
    if (e.name === 'contact' && r.formal) unsupported('contact output parameter');
    if (e.name === 'block' && r.formal !== blockKind(e).out)
      unsupported(`${e.attrs.typeName} output ${r.formal ?? ''}`);
    if (e.name !== 'contact' && e.name !== 'block') unsupported(`power from ${e.name}`);
    const cached = memo.get(r.id);
    if (cached) return cached;
    if (visiting.has(r.id)) unsupported('loop');
    // The chain is followed recursively: bound it by the rung size before it can be deep.
    if (visiting.size >= ladderLimits.nodesPerRung)
      throw new LadderXmlError('limit-nodes', {
        what: `more than ${ladderLimits.nodesPerRung} in a row`,
      });
    visiting.add(r.id);
    const ins = powerIn(e);
    if (!ins.length) unsupported('unpowered element');
    const x = seq([alt(ins.map(outOf)), { t: 'leaf', id: r.id }]);
    visiting.delete(r.id);
    used.add(r.id);
    memo.set(r.id, x);
    return x;
  };

  // Rungs: coils with the same feed, in the order of their first coil.
  const rungFeeds: { key: string; refs: Ref[]; coils: XmlElement[]; comment?: string }[] = [];
  let comment: string | undefined;
  for (const e of order) {
    if (e.name === 'comment') {
      comment = commentText(xmlChild(e, 'content') ?? e);
      used.add(Number(e.attrs.localId));
      continue;
    }
    if (e.name !== 'coil') continue;
    const refs = powerIn(e);
    if (!refs.length) unsupported('unpowered coil');
    const k = refs.map((r) => `${r.id}:${r.formal ?? ''}`).join(' ');
    const rung = rungFeeds.find((f) => f.key === k);
    // Coils of one rung run together; a shared feed reached again after another rung would
    // move this coil ahead of that rung and change the scan order.
    if (rung && rung !== rungFeeds[rungFeeds.length - 1])
      unsupported('coils sharing a feed with other rungs between them');
    if (rung) rung.coils.push(e);
    else {
      rungFeeds.push({ key: k, refs, coils: [e], ...(comment !== undefined ? { comment } : {}) });
      comment = undefined;
    }
    used.add(Number(e.attrs.localId));
  }

  // The tree of each rung, with IDs in order.
  let n = 0;
  let c = 0;
  const leafNode = (id: number): LadderNode => {
    const e = els.get(id)!;
    const nid = `n${++n}`;
    if (e.name === 'contact') {
      const negated = xmlBool(e.attrs.negated, 'negated');
      const edge = e.attrs.edge ?? 'none';
      if (negated && edge !== 'none') unsupported('negated edge contact');
      if (e.attrs.storage && e.attrs.storage !== 'none') unsupported('contact storage');
      const contact = negated ? 'nc' : edge === 'none' ? 'no' : edge;
      if (contact !== 'no' && contact !== 'nc' && contact !== 'rising' && contact !== 'falling')
        unsupported(`edge ${edge}`);
      return {
        id: nid,
        kind: 'contact',
        variable: xmlText(xmlChild(e, 'variable') ?? e).trim(),
        contact: contact as 'no',
      };
    }
    const b = blockKind(e);
    const known = new Set(
      b.kind === 'timer'
        ? ['IN', 'PT']
        : b.kind === 'counter'
          ? [b.power, b.t === 'CTU' ? 'R' : 'LD', 'PV']
          : ['EN', 'IN1', 'IN2'],
    );
    for (const f of blockInputs(e)) if (!known.has(f ?? '')) unsupported(`${b.t} input ${f ?? ''}`);
    // Pin modifiers (a negated R, an edge on IN…) would change what the block does.
    for (const v of [
      ...xmlChildren(xmlChild(e, 'inputVariables') ?? e, 'variable'),
      ...xmlChildren(xmlChild(e, 'outputVariables') ?? e, 'variable'),
    ])
      plain(v, `${b.t} ${v.attrs.formalParameter ?? ''}`);
    if (xmlChild(e, 'inOutVariables')?.children.length) unsupported(`${b.t} inOutVariables`);
    if (b.kind === 'timer') {
      const pt = inText(e, 'PT');
      const presetMs = pt === undefined ? undefined : ladderTimeLiteral(pt);
      if (presetMs === undefined) unsupported(`${b.t} PT ${pt ?? ''}`);
      checkInstance(e, b.t);
      return { id: nid, kind: 'timer', instance: e.attrs.instanceName!, presetMs: presetMs! };
    }
    if (b.kind === 'counter') {
      const pv = inText(e, 'PV');
      const preset = pv === undefined ? undefined : intLiteral(pv);
      if (preset === undefined) unsupported(`${b.t} PV ${pv ?? ''}`);
      const reset = inText(e, b.t === 'CTU' ? 'R' : 'LD');
      checkInstance(e, b.t);
      return {
        id: nid,
        kind: 'counter',
        instance: e.attrs.instanceName!,
        preset: preset!,
        ...(reset !== undefined ? { reset } : {}),
      };
    }
    if (e.attrs.instanceName) unsupported(`${b.t} instance`);
    const operand = (formal: string): LadderOperand => {
      const text = inText(e, formal);
      if (text === undefined) return unsupported(`${b.t} ${formal}`);
      const value = intLiteral(text) ?? ladderTimeLiteral(text);
      if (value !== undefined) return { value };
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(CV|ET))?$/i.exec(text);
      if (!m) return unsupported(`${b.t} ${formal} ${text}`);
      return m[2]
        ? { variable: m[1], member: m[2].toUpperCase() as 'CV' | 'ET' }
        : { variable: m[1] };
    };
    return { id: nid, kind: 'compare', op: b.op!, a: operand('IN1'), b: operand('IN2') };
  };
  const checkInstance = (e: XmlElement, t: string) => {
    const inst = e.attrs.instanceName;
    if (!inst) unsupported(`${t} without instanceName`);
    const vt = typeOf.get(inst!.toUpperCase());
    if (vt !== undefined && vt !== t) unsupported(`${t} instance of ${vt}`);
  };
  const seen = new Set<number>();
  const toNode = (x: Expr): LadderNode => {
    if (x.t === 'leaf') {
      if (seen.has(x.id)) unsupported('element shared between branches or rungs');
      seen.add(x.id);
      return leafNode(x.id);
    }
    const id = `n${++n}`;
    return x.t === 'seq'
      ? { id, kind: 'series', items: x.items.map(toNode) }
      : { id, kind: 'parallel', branches: x.items.map(toNode) };
  };
  const rungs: LadderRung[] = rungFeeds.map((f, i) => {
    const network = toNode(alt(f.refs.map(outOf)));
    const coils: LadderCoil[] = f.coils.map((e) => {
      const negated = xmlBool(e.attrs.negated, 'negated');
      const storage = e.attrs.storage ?? 'none';
      if (e.attrs.edge && e.attrs.edge !== 'none') unsupported('edge coil');
      if (negated && storage !== 'none') unsupported('negated storage coil');
      if (storage !== 'none' && storage !== 'set' && storage !== 'reset')
        unsupported(`storage ${storage}`);
      return {
        id: `c${++c}`,
        variable: xmlText(xmlChild(e, 'variable') ?? e).trim(),
        coil: negated ? 'negated' : storage === 'none' ? 'normal' : (storage as 'set'),
      };
    });
    return {
      id: `r${i + 1}`,
      ...(f.comment !== undefined ? { comment: f.comment } : {}),
      network,
      coils,
    };
  });
  // Coils go only to the right rail; nothing may be left over.
  for (const e of order) {
    const id = Number(e.attrs.localId);
    if (e.name === 'rightPowerRail') {
      for (const p of xmlChildren(e, 'connectionPointIn'))
        for (const r of refsOf(p))
          if (els.get(r.id)!.name !== 'coil') unsupported('right rail fed by a non-coil');
      used.add(id);
    } else if (!used.has(id)) unsupported(`unconnected ${e.name} ${id}`);
  }
  // Execution: none (10 ms), or one configuration → resource → task (cyclic, by interval) running
  // one instance of the program. Anything else cannot be one scan period.
  let task: XmlElement | undefined;
  const instances = xmlChild(root, 'instances');
  if (instances) {
    const one = (parent: XmlElement | undefined, name: string, allowed: string[]) => {
      for (const c of parent?.children ?? [])
        if (c.name !== name && !allowed.includes(c.name)) unsupported(`${parent!.name} ${c.name}`);
      const list = parent ? xmlChildren(parent, name) : [];
      if (list.length !== 1) unsupported(`${name} count ${list.length}`);
      return list[0];
    };
    const config = one(xmlChild(instances, 'configurations'), 'configuration', ['documentation']);
    const resource = one(config, 'resource', ['documentation']);
    task = one(resource, 'task', ['documentation']);
    const inst = one(task, 'pouInstance', ['documentation']);
    if (inst.attrs.typeName !== pou.attrs.name) unsupported(`pouInstance ${inst.attrs.typeName}`);
    if (task.attrs.single) unsupported('task single');
  }
  const scanMs = task?.attrs.interval ? ladderTimeLiteral(task.attrs.interval) : 10;
  if (scanMs === undefined) unsupported(`task interval ${task!.attrs.interval}`);
  const doc: LadderDocument = { schemaVersion: 1, name, scanMs: scanMs!, variables, rungs };
  const errors = validateLadder(doc).filter((d) => d.severity === 'error');
  if (errors.length)
    throw new LadderXmlError('plcopen-invalid', {
      what: `${errors[0].code} at ${errors[0].path}`,
    });
  return doc;
}

/**
 * The program with every node and coil renumbered in order (`r1…`, `n1…`, `c1…`), series inside
 * series and parallels inside parallels flattened, repeated empty branches dropped, one-item
 * series / parallels unwrapped and variables grouped by role: the form `ladderFromPlcopen` reads
 * back, for comparing programs.
 */
export function ladderCanonical(doc: LadderDocument): LadderDocument {
  let n = 0;
  let c = 0;
  const flat = (x: LadderNode): LadderNode => {
    if (x.kind === 'series') {
      const items = x.items.map(flat).flatMap((i) => (i.kind === 'series' ? i.items : [i]));
      return items.length === 1 ? items[0] : { ...x, items };
    }
    if (x.kind === 'parallel') {
      let bypass = false;
      const branches = x.branches
        .map(flat)
        .flatMap((b) => (b.kind === 'parallel' ? b.branches : [b]))
        // Two empty branches pass on the same as one (and are written as one).
        .filter((b) => {
          const empty = b.kind === 'series' && b.items.length === 0;
          if (empty && bypass) return false;
          bypass ||= empty;
          return true;
        });
      return branches.length === 1 ? branches[0] : { ...x, branches };
    }
    return x;
  };
  const number = (x: LadderNode): LadderNode => {
    const id = `n${++n}`;
    if (x.kind === 'series') return { id, kind: 'series', items: x.items.map(number) };
    if (x.kind === 'parallel') return { id, kind: 'parallel', branches: x.branches.map(number) };
    return { ...x, id };
  };
  return {
    ...doc,
    // Inputs, outputs, then internal variables, each in their order (as the file's sections).
    variables: (['input', 'output', 'internal'] as const).flatMap((role) =>
      doc.variables.filter((v) => v.role === role).map((v) => ({ ...v })),
    ),
    rungs: doc.rungs.map((r, i) => ({
      id: `r${i + 1}`,
      ...(r.comment !== undefined ? { comment: r.comment } : {}),
      network: number(flat(r.network)),
      coils: r.coils.map((k) => ({ ...k, id: `c${++c}` })),
    })),
  };
}
