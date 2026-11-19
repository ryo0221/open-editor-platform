/**
 * PD2 (docs/cad/product-design.md, 部品の属性と部品表): the BOM with each row's mass and cost,
 * and the totals. Derived from the content, the retained closure and the evaluations; never
 * stored. Totals come from the flat count (every counted version once, with all its occurrences),
 * so they are the same in either table:
 *
 * - Mass: each counted version's own active bodies (density from the body, else from its
 *   material) times its quantity, plus this document's own bodies. A body or version that cannot
 *   be weighed is listed as left out, never counted as 0 (as CR7a). Unlike the mass panel, a
 *   component the BOM leaves out (`bom: 'exclude'`) is not weighed here.
 * - Cost: each counted version's own unit cost (a part's, or a sub-assembly's own work) times its
 *   quantity, plus this document's own unit cost once. One currency per report: this document's,
 *   else the first one a counted version names; a cost in another currency is left out. A part
 *   row without a unit cost is listed as left out; a version that only places parts, and this
 *   document, are not (their own cost is optional).
 */
import { cadPartSourcings, type CadPartSourcing, type CadPartLookup } from './assembly';
import { bomRows, countedVersions, type CadBomMode, type CadBomRow } from './bom';
import type { CadBodyEvaluation } from './coordinator';
import { bodyMass, type CadMassGap } from './mass';
import type { CadDocument } from './model';

export type CadBomCostGap =
  | 'cost-missing'
  /** A unit cost in another currency than the report's. */
  | 'cost-currency'
  /** A version this Surface cannot read: its cost is unknown. */
  | 'cost-unavailable';
export interface CadBomLine extends CadBomRow {
  /** What one weighs (its bodies that could be weighed); absent when none could. */
  unitMassKg?: number;
  /** `unitMassKg` × quantity. */
  massKg?: number;
  /** How many of one's bodies (or the whole version) could not be weighed. */
  massLeftOut?: number;
  /** `unitCost` × quantity, when it is in the report's currency. */
  cost?: number;
}
export interface CadBomLeftOut {
  /** The flat row's item (`''` for a version that only places parts, or this document). */
  item: string;
  name: string;
  /** The body not weighed (`''`: the row as a whole). */
  bodyName: string;
  code: CadMassGap | CadBomCostGap;
}
export type CadBomSourcingKey = CadPartSourcing | 'unset';
export interface CadBomTotals {
  massKg: number;
  cost: number;
  /** Absent while nothing names a currency. */
  currency?: string;
  /** Parts (flat rows) by sourcing class: how many, and what they cost. */
  bySourcing: Record<CadBomSourcingKey, { quantity: number; cost: number }>;
  leftOut: CadBomLeftOut[];
}
export interface CadBomReport {
  mode: CadBomMode;
  rows: CadBomLine[];
  totals: CadBomTotals;
}
export interface CadBomEvaluations {
  /** This document's body evaluations. */
  own?: Record<string, CadBodyEvaluation>;
  /** Each placed version's, by content hash (as the assembly evaluation reports them). */
  versions?: Record<string, { state?: string; bodies?: Record<string, CadBodyEvaluation> }>;
  access?: (artifactId: string) => boolean;
}

interface Weighed {
  massKg: number;
  weighed: number;
  gaps: { bodyName: string; code: CadMassGap }[];
}
function weigh(
  content: CadDocument,
  bodies: Record<string, CadBodyEvaluation> | undefined,
  only?: string,
): Weighed {
  const out: Weighed = { massKg: 0, weighed: 0, gaps: [] };
  for (const body of content.bodies) {
    if (body.state !== 'active' || (only !== undefined && body.id !== only)) continue;
    const m = bodyMass(body, bodies?.[body.id], content.partProperties.material);
    if ('code' in m) out.gaps.push({ bodyName: body.name, code: m.code });
    else {
      out.massKg += m.massKg;
      out.weighed++;
    }
  }
  return out;
}
/** Why a placed version is not weighed at all, as the mass panel says it. */
function versionGap(
  readable: boolean,
  content: CadDocument | undefined,
  state: string | undefined,
): CadMassGap | undefined {
  if (!readable) return 'mass-no-access';
  if (!content) return 'mass-part-missing';
  if (state === 'failed') return 'mass-part-failed';
  if (state !== undefined && state !== 'available') return 'mass-part-unavailable';
  return undefined;
}

/** The BOM of `doc` in `mode` with mass and cost, and the totals (from the flat count). */
export function bomReport(
  doc: CadDocument,
  lookup: CadPartLookup,
  mode: CadBomMode,
  evaluations: CadBomEvaluations = {},
): CadBomReport {
  const access = evaluations.access ?? (() => true);
  // What a sub-assembly that cannot be weighed places is not weighed either (as `cadMass`).
  const versions = countedVersions(
    doc,
    lookup,
    access,
    (part, content) =>
      versionGap(true, content, evaluations.versions?.[part.source.contentHash]?.state) ===
      undefined,
  );
  const currency =
    doc.partProperties.currency ??
    versions.find((v) => v.content?.partProperties.unitCost !== undefined)?.content?.partProperties
      .currency;
  const leftOut: CadBomLeftOut[] = [];
  const bySourcing = Object.fromEntries(
    [...cadPartSourcings, 'unset'].map((k) => [k, { quantity: 0, cost: 0 }]),
  ) as CadBomTotals['bySourcing'];
  let massKg = 0;
  let cost = 0;
  // Each version's unit values, by content hash (two versions with one content weigh the same).
  const unit = new Map<string, { mass: Weighed | CadMassGap; cost?: number }>();
  const weighByVersion = new Map<string, number>();
  const costOf = (content: CadDocument | undefined): number | CadBomCostGap | undefined => {
    if (!content) return 'cost-unavailable';
    const p = content.partProperties;
    if (p.unitCost === undefined) return undefined;
    return p.currency === currency ? p.unitCost : 'cost-currency';
  };
  // This document's own bodies (the first rows in either table) and its own unit cost.
  const own = doc.bodies.filter((b) => b.state === 'active');
  const ownWeighed = own.map((b, i) => {
    const w = weigh(doc, evaluations.own, b.id);
    massKg += w.massKg;
    for (const g of w.gaps)
      leftOut.push({ item: `${i + 1}`, name: b.name, bodyName: '', code: g.code });
    return w;
  });
  const ownCost = costOf(doc);
  if (typeof ownCost === 'number') cost += ownCost;
  else if (ownCost)
    leftOut.push({ item: '', name: doc.partProperties.partNumber, bodyName: '', code: ownCost });
  let item = own.length;
  for (const v of versions) {
    const hash = v.part.source.contentHash;
    const evaluated = evaluations.versions?.[hash];
    const gap = versionGap(v.readable, v.content, evaluated?.state);
    const mass: Weighed | CadMassGap = gap ?? weigh(v.content!, evaluated?.bodies);
    const c = costOf(v.readable ? v.content : undefined);
    if (!unit.has(hash) || v.readable)
      unit.set(hash, { mass, ...(typeof c === 'number' ? { cost: c } : {}) });
    // By saved version: two versions with one content are separate flat rows.
    weighByVersion.set(rowKey(v.part.source), v.weighQuantity);
    const label = v.row ? `${++item}` : '';
    const name = v.part.name;
    const out = (code: CadBomLeftOut['code'], bodyName = '') =>
      leftOut.push({ item: label, name, bodyName, code });
    if (typeof mass === 'string') out(mass);
    else {
      massKg += mass.massKg * v.weighQuantity;
      for (const g of mass.gaps) out(g.code, g.bodyName);
    }
    if (typeof c === 'number') cost += c * v.quantity;
    // A version that only places parts needs no cost of its own; a part row does.
    else if (v.row) out(c ?? 'cost-missing');
    else if (c === 'cost-currency') out(c);
    if (v.row) {
      const key: CadBomSourcingKey = (v.readable && v.content?.partProperties.sourcing) || 'unset';
      bySourcing[key].quantity += v.quantity;
      if (typeof c === 'number') bySourcing[key].cost += c * v.quantity;
    }
  }
  let body = 0;
  // Hierarchical rows under a sub-assembly that cannot be weighed (`4.1` under `4`) are not
  // weighed; a flat row weighs only its occurrences outside such sub-assemblies.
  const blocked: string[] = [];
  const rows = bomRows(doc, lookup, mode, access).map((r): CadBomLine => {
    if (r.kind === 'body') return line(r, ownWeighed[body++]!, undefined, r.quantity);
    const u = r.contentHash === undefined || r.unavailable ? undefined : unit.get(r.contentHash);
    const under = blocked.some((p) => r.item.startsWith(`${p}.`));
    if (!u || typeof u.mass === 'string') blocked.push(r.item);
    if (!u) return r.unavailable ? { ...r, massLeftOut: 1 } : r;
    const weighed =
      mode === 'flat'
        ? (weighByVersion.get(
            rowKey(
              r.reference
                ? { kind: 'version', ...r.reference }
                : { kind: 'imported', contentHash: r.contentHash! },
            ),
          ) ?? r.quantity)
        : under
          ? 0
          : r.quantity;
    return line(r, u.mass, u.cost, weighed);
  });
  return {
    mode,
    rows,
    totals: { massKg, cost, ...(currency ? { currency } : {}), bySourcing, leftOut },
  };
}

/** A saved version's identity, as the BOM keeps its rows apart. */
const rowKey = (
  s:
    | { kind: 'version'; artifactId: string; versionId: string }
    | { kind: string; contentHash: string },
) =>
  'artifactId' in s
    ? JSON.stringify([s.artifactId, s.versionId])
    : JSON.stringify(['imported', s.contentHash]);
function line(
  r: CadBomRow,
  mass: Weighed | CadMassGap,
  unitCost: number | undefined,
  /** How many of the row's quantity are weighed (fewer under a failed sub-assembly). */
  weighed: number,
): CadBomLine {
  const out: CadBomLine = { ...r };
  if (typeof mass === 'string') out.massLeftOut = 1;
  else {
    if (mass.weighed > 0) {
      out.unitMassKg = mass.massKg;
      if (weighed > 0) out.massKg = mass.massKg * weighed;
    }
    const missing = mass.gaps.length + (weighed < r.quantity ? 1 : 0);
    if (missing) out.massLeftOut = missing;
  }
  if (unitCost !== undefined) out.cost = unitCost * r.quantity;
  return out;
}

/** PD2: the JSON export's format name; `version` changes when a field changes meaning. */
export const cadBomJsonFormat = Object.freeze({ format: 'editor-platform.cad-bom', version: 1 });
/**
 * The report as JSON text (2-space indent, a final newline). Rows keep their fields as they are
 * (absent values left out); it never changes the content.
 */
export function bomJson(report: CadBomReport, source?: { name?: string; contentHash?: string }) {
  return (
    JSON.stringify(
      {
        ...cadBomJsonFormat,
        ...(source?.name !== undefined ? { name: source.name } : {}),
        ...(source?.contentHash !== undefined ? { contentHash: source.contentHash } : {}),
        mode: report.mode,
        rows: report.rows,
        totals: report.totals,
      },
      null,
      2,
    ) + '\n'
  );
}
