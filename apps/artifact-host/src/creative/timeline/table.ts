/**
 * Story Timeline T1a: the strict reader of one tl1 owner table (t0-contract.md §2.2–§2.6).
 *
 * The reader binds columns by ID, never by display name, and never repairs or drops data:
 * a table that does not pass is returned as `invalid` (read-only, writes disabled) with the
 * reasons. It reads one owner only. Resolving exact references to other owners, the Story
 * binding and every diagnostic belong to the Host (T1b and later).
 */
import {
  isStructuredData,
  validateData,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { TL1_COLUMNS, TL1_LIMITS, TL1_ROLES } from './tl1-schema';

export type TimelineRole = keyof typeof TL1_ROLES;
export type TimelineCell = string | number | boolean;
export type TimelineRef =
  | { type: 'internal'; item: string; facet?: string }
  | {
      type: 'exact';
      artifact: string;
      version: string;
      hash: string;
      item: string;
      facet?: string;
    };
export interface TimelineRow {
  id: string;
  kind: string;
  /** Only the non-null cells, keyed by tl1 column ID. */
  cells: Record<string, TimelineCell>;
  ref?: TimelineRef;
  ref2?: TimelineRef;
}
export interface TimelineTableProblem {
  code:
    | 'not-data'
    | 'data-invalid'
    | 'columns'
    | 'row-kind'
    | 'row-id'
    | 'cell'
    | 'reference'
    | 'time'
    | 'value'
    | 'order'
    | 'worldline'
    | 'limit';
  row?: string;
  column?: string;
  message: string;
}
export type TimelineTableRead =
  | { state: 'valid'; role: TimelineRole; rows: TimelineRow[] }
  /** Invalid tables stay as saved. The UI shows them read-only and every write is disabled. */
  | { state: 'invalid'; role: TimelineRole; readOnly: true; problems: TimelineTableProblem[] };

const MAX_PROBLEMS = 100;
const HASH = /^[0-9a-f]{64}$/;
const TEXT_MAX = 4096;
const columnById = new Map<string, (typeof TL1_COLUMNS)[number]>(TL1_COLUMNS.map((c) => [c.id, c]));
const TIME_KINDS = ['unset', 'point', 'day', 'interval', 'range', 'derived'];
const SCOPE = /^(story:[^\s:@]+|world:[^\s:@]+|individual:[^\s:@]+@[^\s:@]+)$/;
/** Design §8.2 / contract §2.6: which diagnostic kinds an owner role may record. */
const DIAG_OWNER: Record<TimelineRole, string[]> = {
  ledger: ['single-event'],
  'scene-cards': [],
  composition: ['disclosure'],
  world: ['presence', 'multi-event', 'transfer', 'external-event'],
};
const NUMBER_COLUMNS = ['tl1.time.start', 'tl1.time.end', 'tl1.offset.min', 'tl1.offset.max'];
const COUNTED: Record<string, keyof typeof TL1_LIMITS> = {
  event: 'events',
  scene: 'scenes',
  occurrence: 'occurrences',
  worldline: 'worlds',
  'clock-offset': 'clockOffsets',
};
const STRUCTURE = new Set(['event', 'scene', 'occurrence', 'worldline', 'clock-offset']);
/**
 * Same-owner structure: the row kind a relation's `tl1.subject` and its internal `ref`/`ref2`
 * must name. Kinds not listed carry no subject or no internal reference. `exception-basis`
 * may point at any row (the facet narrows it). Exact references to other owners are resolved
 * by the Host and are not checked here.
 */
const SUBJECT_KIND: Record<string, string> = {
  'derive-time': 'event',
  after: 'event',
  'travel-min': 'event',
  cause: 'event',
  participant: 'event',
  knows: 'event',
  'info-use': 'event',
  claim: 'event',
  fact: 'event',
  presence: 'event',
  cite: 'scene',
  inherits: 'worldline',
  'transfer-info': 'transfer',
  'exception-target': 'exception',
  'exception-basis': 'exception',
};
const INTERNAL_REF_KIND: Record<string, string> = {
  'derive-time': 'event',
  after: 'event',
  'travel-min': 'event',
  cause: 'event',
  'info-use': 'event',
};

export function isTimelineRole(role: string): role is TimelineRole {
  return Object.hasOwn(TL1_ROLES, role);
}

export function readTimelineTable(role: TimelineRole, data: unknown): TimelineTableRead {
  const problems: TimelineTableProblem[] = [];
  const fail = (p: TimelineTableProblem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(p);
  };
  const done = (rows: TimelineRow[]): TimelineTableRead =>
    problems.length
      ? { state: 'invalid', role, readOnly: true, problems }
      : { state: 'valid', role, rows };
  const spec = TL1_ROLES[role] as {
    columns: readonly string[];
    rows: Record<string, { required: readonly string[]; optional: readonly string[] }>;
  };
  if (!spec) throw Error(`tl1の役割 ${String(role)} はありません。`);
  const rawRows = (data as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rawRows)) {
    // Row IDs are item IDs. Name the duplicate instead of only "not Data".
    const seen = new Set<unknown>();
    for (const r of rawRows as { id?: unknown }[]) {
      const id = r?.id;
      // Blank IDs cannot be named by any internal or exact reference.
      if (typeof id === 'string' && !id.trim())
        fail({ code: 'row-id', row: id, message: '行IDが空です。' });
      else if (typeof id === 'string' && seen.has(id))
        fail({ code: 'row-id', row: id, message: `行ID ${id} が重複しています。` });
      seen.add(id);
    }
    if (problems.length) return done([]);
  }
  if (!isStructuredData(data)) {
    fail({ code: 'not-data', message: 'Structured Dataではありません。' });
    return done([]);
  }
  const content = data as StructuredData;
  for (const e of validateData(content))
    fail({ code: 'data-invalid', row: e.rowId, column: e.columnId, message: e.message });
  checkColumns(role, content, fail);
  if (problems.length) return done([]);

  const kinds = Object.keys(spec.rows);
  const ids = new Set(content.rows.map((r) => r.id));
  const counts = new Map<string, number>();
  const rows: TimelineRow[] = [];
  for (const raw of content.rows) {
    const values = raw.values as Record<string, TimelineCell | null | undefined>;
    const kind = values['tl1.row'];
    if (typeof kind !== 'string' || !kinds.includes(kind)) {
      fail({
        code: 'row-kind',
        row: raw.id,
        column: 'tl1.row',
        message: `行の種類 ${String(kind)} はこの表では使えません。`,
      });
      continue;
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const rule = spec.rows[kind];
    const allowed = new Set(['tl1.row', ...rule.required, ...rule.optional]);
    const cells: Record<string, TimelineCell> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === null || v === undefined) continue;
      if (!allowed.has(k)) {
        fail({
          code: 'cell',
          row: raw.id,
          column: k,
          message: `${kind} 行では ${k} に値を置けません。`,
        });
        continue;
      }
      cells[k] = v;
    }
    for (const k of rule.required)
      if (cells[k] === undefined || cells[k] === '')
        fail({ code: 'cell', row: raw.id, column: k, message: `${kind} 行には ${k} が必要です。` });
    checkValues(raw.id, cells, fail);
    const row: TimelineRow = { id: raw.id, kind, cells };
    for (const p of ['ref', 'ref2'] as const) {
      const ref = readRef(raw.id, p, cells, ids, fail);
      if (ref) row[p] = ref;
    }
    checkTime(raw.id, kind, cells, fail);
    checkKind(role, raw.id, kind, cells, fail);
    rows.push(row);
  }
  for (const [kind, n] of counts) {
    const limit = COUNTED[kind] ? TL1_LIMITS[COUNTED[kind]] : undefined;
    if (limit !== undefined && n > limit)
      fail({ code: 'limit', message: `${kind} 行は ${limit} 件までです（${n} 件）。` });
  }
  const relations = [...counts].filter(([k]) => !STRUCTURE.has(k)).reduce((s, [, n]) => s + n, 0);
  if (relations > TL1_LIMITS.relations)
    fail({
      code: 'limit',
      message: `関係の行は ${TL1_LIMITS.relations} 件までです（${relations} 件）。`,
    });
  checkStructure(role, rows, fail);
  checkDerivations(rows, fail);
  if (role === 'composition') {
    checkOrder(rows, fail);
    checkExperienceOrder(rows, fail);
  }
  if (role === 'world') checkWorldlines(rows, fail);
  return done(rows);
}

function checkColumns(
  role: TimelineRole,
  content: StructuredData,
  fail: (p: TimelineTableProblem) => void,
) {
  const spec = TL1_ROLES[role];
  const actual = content.columns.map((c) => c.id);
  if (actual.length !== spec.columns.length || actual.some((id, i) => id !== spec.columns[i])) {
    const unknown = actual.filter((id) => !(spec.columns as readonly string[]).includes(id));
    // Columns of a later timeline schema (tl2…) are named as unsupported, not as typos (TL23).
    const later = [...new Set(unknown.map((id) => /^(tl\d+)\./.exec(id)?.[1]))].filter(
      (s): s is string => !!s && s !== 'tl1',
    );
    fail({
      code: 'columns',
      message: later.length
        ? `${later.join('、')} の表にはこの画面は対応していません（tl1 だけを読みます）。表は変えずに保持しています。`
        : unknown.length
          ? `この表に無い列があります：${unknown.join('、')}。`
          : `列の並びが ${role} の tl1 と一致しません。`,
    });
    return;
  }
  for (const c of content.columns) {
    const want = columnById.get(c.id)!;
    const options =
      c.id === 'tl1.row' ? Object.keys(spec.rows) : 'options' in want ? want.options : undefined;
    if (c.type !== want.type)
      fail({
        code: 'columns',
        column: c.id,
        message: `${c.id} の型は ${want.type} です（${c.type}）。`,
      });
    else if (JSON.stringify(c.options ?? null) !== JSON.stringify(options ?? null))
      fail({ code: 'columns', column: c.id, message: `${c.id} の選択肢が tl1 と一致しません。` });
  }
}

function checkValues(
  row: string,
  cells: Record<string, TimelineCell>,
  fail: (p: TimelineTableProblem) => void,
) {
  for (const k of [...NUMBER_COLUMNS, 'tl1.order']) {
    const v = cells[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > TL1_LIMITS.safeDayAbs)
      fail({
        code: 'value',
        row,
        column: k,
        message: `${k} は絶対値 ${TL1_LIMITS.safeDayAbs} 以下の整数です。`,
      });
  }
  const label = cells['tl1.label'];
  if (typeof label === 'string' && [...label].length > TL1_LIMITS.label)
    fail({
      code: 'value',
      row,
      column: 'tl1.label',
      message: `名前は ${TL1_LIMITS.label} 文字までです。`,
    });
  for (const [k, v] of Object.entries(cells))
    if (typeof v === 'string' && v.length > TEXT_MAX)
      fail({ code: 'value', row, column: k, message: `${k} が長すぎます。` });
  const min = cells['tl1.offset.min'],
    max = cells['tl1.offset.max'];
  if (typeof min === 'number' && typeof max === 'number' && min > max)
    fail({
      code: 'value',
      row,
      column: 'tl1.offset.max',
      message: '最大日数が最小日数より小さくなっています。',
    });
}

function readRef(
  row: string,
  p: 'ref' | 'ref2',
  cells: Record<string, TimelineCell>,
  ids: Set<string>,
  fail: (p: TimelineTableProblem) => void,
): TimelineRef | undefined {
  const get = (k: string) => cells[`tl1.${p}.${k}`];
  const artifact = get('artifact'),
    version = get('version'),
    hash = get('hash'),
    item = get('item'),
    facet = get('facet');
  if ([artifact, version, hash, item, facet].every((v) => v === undefined)) return undefined;
  const bad = (message: string) => {
    fail({ code: 'reference', row, column: `tl1.${p}`, message });
    return undefined;
  };
  if (typeof item !== 'string' || !item.trim()) return bad('参照先の項目がありません。');
  const f = typeof facet === 'string' ? { facet } : {};
  if (artifact === undefined) {
    // Same-owner internal ID: only the item (and an optional facet). No version or hash.
    if (version !== undefined || hash !== undefined)
      return bad('内部参照に版やhashは書けません。exact参照なら参照先Artifactも書きます。');
    if (!ids.has(item)) return bad(`同じ表に ${item} がありません。`);
    return { type: 'internal', item, ...f };
  }
  if (
    typeof artifact !== 'string' ||
    !artifact.trim() ||
    typeof version !== 'string' ||
    !version.trim()
  )
    return bad('exact参照には参照先Artifactと版が必要です。');
  if (typeof hash !== 'string' || !HASH.test(hash))
    return bad('exact参照のhashは64桁の16進数です。');
  if (/^commit:/.test(version))
    return bad('版にはnativeのversionIdを書きます。読み取り位置は書きません。');
  return { type: 'exact', artifact, version, hash, item, ...f };
}

function checkTime(
  row: string,
  kind: string,
  cells: Record<string, TimelineCell>,
  fail: (p: TimelineTableProblem) => void,
) {
  const t = cells['tl1.time.kind'];
  if (t === undefined) {
    // A date without its kind is ambiguous (point, day or range); never guess one.
    if (cells['tl1.time.start'] !== undefined || cells['tl1.time.end'] !== undefined)
      fail({
        code: 'time',
        row,
        column: 'tl1.time.kind',
        message: '開始日・終了日には時点の種類が必要です。',
      });
    return;
  }
  const start = cells['tl1.time.start'],
    end = cells['tl1.time.end'];
  const has = (v: unknown) => v !== undefined;
  const bad = (message: string) => fail({ code: 'time', row, column: 'tl1.time.kind', message });
  if (typeof t !== 'string' || !TIME_KINDS.includes(t))
    return bad(`時点の種類 ${String(t)} はありません。`);
  if (t === 'derived' && kind !== 'event') return bad('導出の時点はEVだけが持てます。');
  if ((t === 'unset' || t === 'derived') && (has(start) || has(end)))
    return bad(`${t} の時点に開始日・終了日は書けません。`);
  if ((t === 'point' || t === 'day') && (!has(start) || has(end)))
    return bad(`${t} の時点は開始日だけを持ちます。`);
  if (t === 'interval' && !(typeof start === 'number' && typeof end === 'number' && start < end))
    return bad('期間は開始日 < 終了日です。');
  if (t === 'range') {
    if (!has(start) && !has(end)) return bad('範囲には開始日か終了日のどちらかが必要です。');
    if (typeof start === 'number' && typeof end === 'number' && start > end)
      return bad('範囲の開始日が終了日より後です。');
  }
}

function checkKind(
  role: TimelineRole,
  row: string,
  kind: string,
  cells: Record<string, TimelineCell>,
  fail: (p: TimelineTableProblem) => void,
) {
  if (kind === 'exception') {
    const diag = cells['tl1.diag'] as string | undefined,
      scope = cells['tl1.scope'];
    if (diag !== undefined && !DIAG_OWNER[role].includes(diag))
      fail({
        code: 'cell',
        row,
        column: 'tl1.diag',
        message: `${diag} の例外はこの表に記録しません。`,
      });
    if (typeof scope === 'string' && !SCOPE.test(scope))
      fail({
        code: 'cell',
        row,
        column: 'tl1.scope',
        message:
          '規則の範囲は story:<ID>、world:<世界線>、individual:<人物>@<世界線> のどれかです。',
      });
  }
  if (kind === 'clock-offset' && cells['tl1.offset.min'] !== cells['tl1.offset.max'])
    fail({
      code: 'value',
      row,
      column: 'tl1.offset.max',
      // A range or a rate between clocks is a later time law (T4): named as unsupported (TL29c).
      message:
        '幅のある時計の換算（最小日数と最大日数が違う換算）には対応していません。同じ値の換算だけを読みます。',
    });
}

function checkStructure(
  role: TimelineRole,
  rows: TimelineRow[],
  fail: (p: TimelineTableProblem) => void,
) {
  const kindOf = new Map<string, string>();
  for (const r of rows) if (!kindOf.has(r.id)) kindOf.set(r.id, r.kind);
  for (const r of rows) {
    const subject = r.cells['tl1.subject'];
    const want =
      r.kind === 'exception' ? (role === 'ledger' ? 'event' : undefined) : SUBJECT_KIND[r.kind];
    if (typeof subject === 'string' && want && kindOf.get(subject) !== want)
      fail({
        code: 'reference',
        row: r.id,
        column: 'tl1.subject',
        message: `${r.kind} 行の対象は ${want} 行です（${subject} は ${kindOf.get(subject) ?? '不明'}）。`,
      });
    for (const p of ['ref', 'ref2'] as const) {
      const ref = r[p];
      if (ref?.type !== 'internal') continue;
      const kind = INTERNAL_REF_KIND[r.kind];
      if (r.kind !== 'exception-basis' && kind === undefined)
        fail({
          code: 'reference',
          row: r.id,
          column: `tl1.${p}`,
          message: `${r.kind} 行の参照はexact参照です。`,
        });
      else if (kind && kindOf.get(ref.item) !== kind)
        fail({
          code: 'reference',
          row: r.id,
          column: `tl1.${p}`,
          message: `${r.kind} 行の参照先は ${kind} 行です（${ref.item} は ${kindOf.get(ref.item)}）。`,
        });
    }
  }
}

function checkDerivations(rows: TimelineRow[], fail: (p: TimelineTableProblem) => void) {
  const derives = new Map<string, number>();
  for (const r of rows)
    if (r.kind === 'derive-time') {
      const s = r.cells['tl1.subject'] as string;
      derives.set(s, (derives.get(s) ?? 0) + 1);
    }
  const events = new Map(rows.filter((r) => r.kind === 'event').map((r) => [r.id, r]));
  for (const [subject, n] of derives) {
    const ev = events.get(subject);
    if (!ev) fail({ code: 'reference', row: subject, message: '時間の導出はEVの行に付けます。' });
    else if (ev.cells['tl1.time.kind'] !== 'derived' || n !== 1)
      fail({
        code: 'time',
        row: subject,
        message: '導出の時点のEVには導出の行がちょうど1件必要です。',
      });
  }
  for (const ev of events.values())
    if (ev.cells['tl1.time.kind'] === 'derived' && !derives.has(ev.id))
      fail({ code: 'time', row: ev.id, message: '導出の時点のEVに導出の行がありません。' });
  // A new derivation cycle among same-owner internal references is refused (contract §5).
  const next = new Map<string, string>();
  for (const r of rows)
    if (r.kind === 'derive-time' && r.ref?.type === 'internal')
      next.set(r.cells['tl1.subject'] as string, r.ref.item);
  for (const start of next.keys()) {
    const seen = new Set<string>();
    let at: string | undefined = start;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      at = next.get(at);
    }
    if (at === start) {
      fail({ code: 'time', row: start, message: '時間の導出が循環しています。' });
      break;
    }
  }
}

function checkOrder(rows: TimelineRow[], fail: (p: TimelineTableProblem) => void) {
  const seen = new Map<number, string>();
  for (const r of rows) {
    if (r.kind !== 'occurrence') continue;
    const o = r.cells['tl1.order'] as number;
    if (seen.has(o))
      fail({
        code: 'order',
        row: r.id,
        column: 'tl1.order',
        message: `提示の並び ${o} が ${seen.get(o)} と重なっています。`,
      });
    else seen.set(o, r.id);
    if (r.ref?.type !== 'exact')
      fail({ code: 'reference', row: r.id, message: '提示位置はSCカードをexact参照で指します。' });
  }
}

/** Strict experience order is per individual, independent of date and saved-version choice. */
function checkExperienceOrder(rows: TimelineRow[], fail: (p: TimelineTableProblem) => void) {
  const people = new Map<string, Map<string, Set<string>>>();
  for (const r of rows.filter((r) => r.kind === 'experience')) {
    if (r.ref?.type !== 'exact' || r.ref2?.type !== 'exact') continue;
    const person = JSON.stringify([r.cells['tl1.ind.ch'], r.cells['tl1.ind.origin']]);
    const graph = people.get(person) ?? new Map<string, Set<string>>();
    const from = JSON.stringify([r.ref.artifact, r.ref.item]),
      to = JSON.stringify([r.ref2.artifact, r.ref2.item]);
    const next = graph.get(from) ?? new Set<string>();
    next.add(to);
    graph.set(from, next);
    people.set(person, graph);
  }
  for (const graph of people.values()) {
    const incoming = new Map<string, number>();
    for (const [from, next] of graph) {
      if (!incoming.has(from)) incoming.set(from, 0);
      for (const to of next) incoming.set(to, (incoming.get(to) ?? 0) + 1);
    }
    const ready = [...incoming.keys()].filter((id) => incoming.get(id) === 0);
    let visited = 0;
    for (let i = 0; i < ready.length; i++) {
      visited++;
      for (const to of graph.get(ready[i]) ?? []) {
        const n = incoming.get(to)! - 1;
        incoming.set(to, n);
        if (n === 0) ready.push(to);
      }
    }
    if (visited !== incoming.size) {
      fail({ code: 'order', message: '同じ人物個体の経験順が循環しています。' });
      return;
    }
  }
}

function checkWorldlines(rows: TimelineRow[], fail: (p: TimelineTableProblem) => void) {
  const parent = new Map<string, string | undefined>();
  for (const r of rows)
    if (r.kind === 'worldline') parent.set(r.id, r.cells['tl1.world.parent'] as string | undefined);
  for (const [id, p] of parent) {
    if (p !== undefined && !parent.has(p)) {
      fail({
        code: 'worldline',
        row: id,
        column: 'tl1.world.parent',
        message: `親の世界線 ${p} がありません。`,
      });
      continue;
    }
    const seen = new Set<string>([id]);
    let at = p,
      depth = 0;
    while (at !== undefined) {
      if (seen.has(at)) {
        fail({
          code: 'worldline',
          row: id,
          column: 'tl1.world.parent',
          message: '世界線の分岐が循環しています。',
        });
        break;
      }
      seen.add(at);
      if (++depth > TL1_LIMITS.branchDepth) {
        fail({
          code: 'limit',
          row: id,
          message: `分岐の深さは ${TL1_LIMITS.branchDepth} までです。`,
        });
        break;
      }
      at = parent.get(at);
    }
  }
}
