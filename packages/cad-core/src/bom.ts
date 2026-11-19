/**
 * R2b-3 bill of materials (docs/cad/r2b-assembly.md, Component patternとBOM): a table derived
 * from the content, never stored. The flat table counts each saved part version once with every
 * occurrence it has, nested ones included; the hierarchical one lists each (sub-)assembly's
 * own components by version under it. This document's active bodies count as parts fixed at
 * the origin. A component pattern's copies count with their seed. Components marked
 * `bom: 'exclude'` (and their copies and what they place) are not counted.
 */
import {
  cadAssemblyLimits,
  partArtifactId,
  type CadPartDef,
  type CadPartLookup,
  type CadPartProperties,
  type CadPartSourcing,
} from './assembly';
import { cadComponentSteps } from './quantity';
import type { CadDocument } from './model';

export type CadBomMode = 'flat' | 'hierarchical';
export interface CadBomRow {
  /** `1`, `2`… in the flat table; `1`, `1.1`… in the hierarchical one. */
  item: string;
  /** 0 for this document's rows; one more per sub-assembly in the hierarchical table. */
  level: number;
  /** `body`: this document's own body. `assembly`: a version placing parts of its own. */
  kind: 'part' | 'assembly' | 'body';
  partNumber: string;
  name: string;
  description: string;
  quantity: number;
  /** The saved version a part row counts (none for this document's bodies). */
  reference?: { artifactId: string; versionId: string };
  /** PD2: the counted version's content hash (none for this document's bodies). */
  contentHash?: string;
  /** A version this Surface cannot read (no content, or read access revoked): only its name. */
  unavailable?: true;
  /** PD2: the version's (or, for a body row, this document's) material name. */
  material?: string;
  /** PD2: the version's sourcing class (none for a body row). */
  sourcing?: CadPartSourcing;
  /** PD2: the version's supplier note. */
  supplier?: string;
  /** PD2: the cost of one, in `currency`. */
  unitCost?: number;
  currency?: string;
}

const active = (doc: CadDocument) => doc.bodies.filter((b) => b.state === 'active');
/** A version that only places parts: the flat table counts its parts, not itself. */
const assemblyOnly = (doc: CadDocument) => !active(doc).length && doc.components.length > 0;

interface Group {
  part: CadPartDef;
  content: CadDocument | undefined;
  quantity: number;
}
/**
 * A row's identity: the exact saved version (two Artifacts, or two versions, with the same
 * content are separate rows). The content hash only reads the closure.
 */
const versionKey = ({ source }: CadPartDef) =>
  JSON.stringify(
    source.kind === 'version'
      ? [source.artifactId, source.versionId]
      : ['imported', source.contentHash],
  );
/** The counted components of `owner`, by version in order of their first component. */
function groups(
  owner: CadDocument,
  lookup: CadPartLookup,
  access: (artifactId: string) => boolean,
) {
  const parts = new Map(owner.parts.map((p) => [p.id, p]));
  const out = new Map<string, Group>();
  // A pattern's copies count as its seed does (an excluded seed's copies are left out too).
  for (const { component: c, steps } of cadComponentSteps(owner)) {
    const part = parts.get(c.partId);
    if (!part || c.bom === 'exclude') continue;
    const key = versionKey(part);
    const n = steps.length;
    const g = out.get(key);
    if (g) g.quantity += n;
    else {
      const id = partArtifactId(part.source);
      const readable = id === undefined || access(id);
      const content = readable ? lookup(part.source.contentHash) : undefined;
      out.set(key, { part, content, quantity: n });
    }
  }
  return [...out.values()];
}
function row(g: Group, item: string, level: number, quantity: number): CadBomRow {
  const { part, content } = g;
  const { source } = part;
  const reference =
    source.kind === 'version'
      ? { artifactId: source.artifactId, versionId: source.versionId }
      : undefined;
  const { contentHash } = source;
  if (!content)
    return {
      item,
      level,
      kind: 'part',
      partNumber: '',
      name: part.name,
      description: '',
      quantity,
      ...(reference ? { reference } : {}),
      contentHash,
      unavailable: true,
    };
  return {
    item,
    level,
    kind: content.components.length ? 'assembly' : 'part',
    partNumber: content.partProperties.partNumber,
    name: part.name,
    description: content.partProperties.description,
    quantity,
    ...(reference ? { reference } : {}),
    contentHash,
    ...bomValues(content.partProperties),
  };
}
/** PD2: a version's BOM values as row fields (each only when it is set). */
function bomValues(p: CadPartProperties) {
  return {
    ...(p.material ? { material: p.material.name } : {}),
    ...(p.sourcing ? { sourcing: p.sourcing } : {}),
    ...(p.supplier ? { supplier: p.supplier } : {}),
    ...(p.unitCost !== undefined ? { unitCost: p.unitCost, currency: p.currency } : {}),
  };
}
const bodyRows = (doc: CadDocument): CadBomRow[] =>
  active(doc).map((b) => {
    // PD2: a body's own density preset names its material; else the document's material.
    const material = b.mass ? b.mass.material : doc.partProperties.material?.name;
    return {
      item: '',
      level: 0,
      kind: 'body',
      partNumber: '',
      name: b.name,
      description: '',
      quantity: 1,
      ...(material ? { material } : {}),
    };
  });

/**
 * The BOM of `doc`. `lookup` reads the retained closure; `access` is the current read access
 * (a revoked part, or one inside a revoked sub-assembly, shows its stored name only). Nesting
 * stops at the assembly depth limit, as expansion does.
 */
export function bomRows(
  doc: CadDocument,
  lookup: CadPartLookup,
  mode: CadBomMode,
  access: (artifactId: string) => boolean = () => true,
): CadBomRow[] {
  if (mode === 'hierarchical') {
    // This document's bodies first, then its components; a sub-assembly's under it (`1.1`).
    const rows = bodyRows(doc).map((r, i) => ({ ...r, item: `${i + 1}` }));
    const walk = (owner: CadDocument, prefix: string, level: number, first: number) => {
      for (const [i, g] of groups(owner, lookup, access).entries()) {
        const item = `${prefix}${first + i + 1}`;
        rows.push(row(g, item, level, g.quantity));
        if (g.content?.components.length && level + 1 < cadAssemblyLimits.depth)
          walk(g.content, `${item}.`, level + 1, 0);
      }
    };
    walk(doc, '', 0, rows.length);
    return rows;
  }
  const counted = countedVersions(doc, lookup, access)
    .filter((v) => v.row)
    .map((v) => ({ ...row(v, '', 0, v.quantity), kind: 'part' as const }));
  const rows = [...bodyRows(doc), ...counted];
  return rows.map((r, i) => ({ ...r, item: `${i + 1}` }));
}
/** One saved version the BOM counts, with every occurrence it has (nested ones included). */
export interface CadBomVersion {
  part: CadPartDef;
  /** Absent: this Surface cannot read it (no content, or read access revoked). */
  content: CadDocument | undefined;
  /** Whether its Artifact is readable now (false: left out for access, not for content). */
  readable: boolean;
  quantity: number;
  /**
   * PD2: the occurrences none of whose sub-assemblies `weighable` refuses (all of them without
   * `weighable`): what is inside a sub-assembly that failed to evaluate is not weighed.
   */
  weighQuantity: number;
  /** Whether it is a row of the flat table (a version that only places parts is not). */
  row: boolean;
}
/**
 * Every version the flat BOM counts, in its order, the ones that only place parts included (PD2
 * adds their own cost). A version inside an unreadable sub-assembly is not reached.
 */
export function countedVersions(
  doc: CadDocument,
  lookup: CadPartLookup,
  access: (artifactId: string) => boolean = () => true,
  weighable: (part: CadPartDef, content: CadDocument | undefined) => boolean = () => true,
): CadBomVersion[] {
  const counted = new Map<string, CadBomVersion>();
  const walk = (owner: CadDocument, times: number, weighTimes: number, level: number) => {
    for (const g of groups(owner, lookup, access)) {
      const quantity = g.quantity * times;
      const weighQuantity = g.quantity * weighTimes;
      const key = versionKey(g.part);
      const was = counted.get(key);
      if (was) {
        was.quantity += quantity;
        was.weighQuantity += weighQuantity;
      } else {
        const id = partArtifactId(g.part.source);
        counted.set(key, {
          ...g,
          quantity,
          weighQuantity,
          readable: id === undefined || access(id),
          row: !g.content || !assemblyOnly(g.content),
        });
      }
      if (g.content?.components.length && level + 1 < cadAssemblyLimits.depth)
        walk(g.content, quantity, weighable(g.part, g.content) ? weighQuantity : 0, level + 1);
    }
  };
  walk(doc, 1, 1, 0);
  return [...counted.values()];
}
/**
 * One CSV cell (RFC 4180). A cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return
 * gets a leading `'`, so a spreadsheet never runs it as a formula (N12).
 */
export function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
export const bomCsvHeader = [
  'Item',
  'Part number',
  'Name',
  'Description',
  'Quantity',
  'Artifact',
  'Version',
  // PD2: the part's values; the mass and cost columns stay empty without a report.
  'Material',
  'Sourcing',
  'Supplier',
  'Unit mass (kg)',
  'Mass (kg)',
  'Unit cost',
  'Cost',
  'Currency',
] as const;
/** The PD2 columns a row can fill (a `CadBomLine` of `bomReport`). */
export interface CadBomCsvRow extends CadBomRow {
  unitMassKg?: number;
  massKg?: number;
  cost?: number;
}
/** A number as plain decimal text (no exponent, no grouping), or `''` when absent. */
export function csvNumber(v: number | undefined, digits?: number) {
  if (v === undefined || !Number.isFinite(v)) return '';
  // Without `digits`: at most 6 decimals, so sums do not show binary noise (0.1 × 3).
  const text = digits === undefined ? String(Number(v.toFixed(6))) : v.toFixed(digits);
  return /e/i.test(text) ? v.toFixed(digits ?? 6) : text;
}
/**
 * The BOM as UTF-8 CSV text (CRLF line ends, a header row). It never changes the content. PD2:
 * with `totals` (from `bomReport`), a last `Total` row gives the mass and cost totals.
 */
export function bomCsv(
  rows: readonly CadBomCsvRow[],
  totals?: { massKg: number; cost: number; currency?: string },
) {
  const lines: string[][] = [
    [...bomCsvHeader],
    ...rows.map((r) => [
      r.item,
      r.partNumber,
      r.name,
      r.description,
      String(r.quantity),
      r.reference?.artifactId ?? '',
      r.reference?.versionId ?? '',
      r.material ?? '',
      r.sourcing ?? '',
      r.supplier ?? '',
      csvNumber(r.unitMassKg, 6),
      csvNumber(r.massKg, 6),
      csvNumber(r.unitCost),
      csvNumber(r.cost),
      r.unitCost !== undefined ? (r.currency ?? '') : '',
    ]),
  ];
  if (totals)
    lines.push([
      'Total',
      ...Array<string>(10).fill(''),
      csvNumber(totals.massKg, 6),
      '',
      csvNumber(totals.cost),
      totals.currency ?? '',
    ]);
  return lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
