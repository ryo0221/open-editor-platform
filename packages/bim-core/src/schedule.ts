import type { BimDerived } from './derive';
import { bimSurfaceMaterialId } from './drawing';
import type { BimDocument, BimElement } from './model';

/**
 * TW3 (docs/cad/bim-tower.md): the building's schedule. One row per element kind, type and
 * level, with the count and the sums of length, area and volume; subtotals per material
 * category; and a CSV of it. No mass: materials carry no density (SK-U5).
 */
export interface BimScheduleRow {
  kind: BimElement['kind'];
  /** Absent for spaces, which have no type. */
  typeId?: string;
  typeName: string;
  level: string;
  levelName: string;
  /** The type's (first) material's category, or '' when it has none (spaces, doors, parts). */
  category: string;
  count: number;
  /** Sums in mm, mm² and mm³; absent when no element of the row has the quantity. */
  lengthMm?: number;
  areaMm2?: number;
  volumeMm3?: number;
  /**
   * Elements whose volume the kernel measures (clipped by a roof) and has not measured yet, or
   * that did not derive: the row's sums leave them out.
   */
  missing: number;
}
export interface BimScheduleSubtotal {
  category: string;
  count: number;
  lengthMm?: number;
  areaMm2?: number;
  volumeMm3?: number;
}
export interface BimSchedule {
  rows: BimScheduleRow[];
  subtotals: BimScheduleSubtotal[];
}

/** The order rows come in, by kind. */
const kinds: BimElement['kind'][] = [
  'column',
  'beam',
  'member',
  'wall',
  'slab',
  'ramp',
  'railing',
  'stair',
  'roof',
  'door',
  'window',
  'space',
  'part',
];
/** The area a kind's row sums: the face that is ordered or finished. */
const areaOf: Partial<Record<BimElement['kind'], string>> = {
  wall: 'netSideArea',
  slab: 'netArea',
  // LR3: a ramp's walking surface.
  ramp: 'topArea',
  // LS5: a railing's side.
  railing: 'sideArea',
  // LS6: a stair's treads.
  stair: 'treadArea',
  roof: 'grossArea',
  space: 'netFloorArea',
};
const lengthKinds = new Set<BimElement['kind']>([
  'column',
  'beam',
  'member',
  'wall',
  'ramp',
  'railing',
  // LS6: a stair's run (Codex).
  'stair',
]);

/** The level an element belongs to: its base, its top (slab, beam), its start, or its host's. */
function levelOf(doc: BimDocument, el: BimElement, seen = 0): string | undefined {
  switch (el.kind) {
    case 'slab':
    case 'beam':
      return el.top.level;
    case 'member':
      return el.start.height.level;
    case 'opening':
    case 'door':
    case 'window':
    case 'railing': {
      const host = doc.elements.find((e) => e.id === el.hostId);
      return host && seen < 2 ? levelOf(doc, host, seen + 1) : undefined;
    }
    default:
      return el.base.level;
  }
}

const add = (a: number | undefined, b: number | undefined) => (b === undefined ? a : (a ?? 0) + b);

/**
 * The schedule of `doc`. `kernelQuantities` are the evaluation's measured values for elements
 * whose quantities the kernel gives (walls and columns clipped by a roof).
 */
export function bimSchedule(
  doc: BimDocument,
  derived: BimDerived,
  kernelQuantities?: ReadonlyMap<string, Record<string, number>>,
): BimSchedule {
  const types = new Map(doc.types.map((t) => [t.id, t]));
  const levels = new Map(doc.levels.map((l) => [l.id, l]));
  const categories = new Map(doc.materials.map((m) => [m.id, m.category]));
  const rows = new Map<string, BimScheduleRow>();
  for (const el of doc.elements) {
    if (el.kind === 'opening') continue;
    const level = levelOf(doc, el);
    if (!level) continue;
    const type = 'typeId' in el ? types.get(el.typeId) : undefined;
    const key = `${el.kind}\u0000${type?.id ?? ''}\u0000${level}`;
    let row = rows.get(key);
    if (!row) {
      const material = type && type.kind !== 'part' ? bimSurfaceMaterialId(type) : undefined;
      row = {
        kind: el.kind,
        ...(type ? { typeId: type.id } : {}),
        typeName: type?.name ?? '',
        level,
        levelName: levels.get(level)?.name ?? level,
        category: (material && categories.get(material)) ?? '',
        count: 0,
        missing: 0,
      };
      rows.set(key, row);
    }
    row.count++;
    const q = derived.quantities.get(el.id);
    const values = {
      ...q?.values,
      ...(q?.source === 'kernel' ? kernelQuantities?.get(el.id) : {}),
    };
    if (lengthKinds.has(el.kind)) row.lengthMm = add(row.lengthMm, values.length);
    const areaKey = areaOf[el.kind];
    if (areaKey) row.areaMm2 = add(row.areaMm2, values[areaKey]);
    if (el.kind === 'door' || el.kind === 'window') {
      if (type && 'widthMm' in type) row.areaMm2 = add(row.areaMm2, type.widthMm * type.heightMm);
      continue;
    }
    if (el.kind === 'part') continue;
    const volume = values.netVolume ?? values.grossVolume;
    if (volume === undefined) row.missing++;
    else row.volumeMm3 = add(row.volumeMm3, volume);
  }
  const elevation = (id: string) => levels.get(id)?.elevationMm ?? 0;
  const sorted = [...rows.values()].sort(
    (a, b) =>
      kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
      (a.typeName < b.typeName ? -1 : a.typeName > b.typeName ? 1 : 0) ||
      elevation(a.level) - elevation(b.level) ||
      (a.level < b.level ? -1 : a.level > b.level ? 1 : 0),
  );
  // Subtotals of what is built of a material: spaces, doors, windows and parts stay out.
  const totals = new Map<string, BimScheduleSubtotal>();
  for (const r of sorted) {
    if (!r.category) continue;
    const t = totals.get(r.category) ?? { category: r.category, count: 0 };
    t.count += r.count;
    t.lengthMm = add(t.lengthMm, r.lengthMm);
    t.areaMm2 = add(t.areaMm2, r.areaMm2);
    t.volumeMm3 = add(t.volumeMm3, r.volumeMm3);
    totals.set(r.category, t);
  }
  return {
    rows: sorted,
    subtotals: [...totals.values()].sort((a, b) =>
      a.category < b.category ? -1 : a.category > b.category ? 1 : 0,
    ),
  };
}

const field = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
/** A sum in metres (length, area or volume) to 3 decimals, or empty. */
const metres = (v: number | undefined, power: 1 | 2 | 3) =>
  v === undefined ? '' : (v / 1000 ** power).toFixed(3);

/**
 * The schedule as CSV (RFC 4180, CRLF): lengths in m, areas in m², volumes in m³. The rows,
 * then one subtotal row per material category.
 */
export function bimScheduleCsv(schedule: BimSchedule): string {
  const lines = [
    [
      'Kind',
      'Type',
      'Level',
      'Material',
      'Count',
      'Length (m)',
      'Area (m²)',
      'Volume (m³)',
      'Not measured',
    ],
    ...schedule.rows.map((r) => [
      r.kind,
      r.typeName,
      r.levelName,
      r.category,
      String(r.count),
      metres(r.lengthMm, 1),
      metres(r.areaMm2, 2),
      metres(r.volumeMm3, 3),
      r.missing ? String(r.missing) : '',
    ]),
    ...schedule.subtotals.map((t) => [
      'Subtotal',
      '',
      '',
      t.category,
      String(t.count),
      metres(t.lengthMm, 1),
      metres(t.areaMm2, 2),
      metres(t.volumeMm3, 3),
      '',
    ]),
  ];
  return lines.map((l) => l.map(field).join(',')).join('\r\n') + '\r\n';
}
