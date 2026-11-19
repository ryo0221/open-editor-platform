import { canonicalJson } from '@editor-platform/artifact-core';
import { drawingDatumPattern, drawingGdtForms, drawingGdtNeedsDatum } from './model';
import type {
  DrawingGdtCharacteristic,
  DrawingPmiItem,
  DrawingPmiNote,
  DrawingSymbolSpec,
} from './model';
import type { Vec3 } from './project';

/**
 * DW3c-2b (docs/cad/drawing-editor.md, PMI由来の注記): PMI items of the imported parts a view
 * shows, as the Host reads them from the version's kept PMI asset and its evaluation.
 */
export interface DrawingPmiLive {
  /** The body's placement path (occurrence IDs; empty in a part drawing) and the body. */
  path: string[];
  bodyId: string;
  itemId: string;
  /** The PMI asset the item is in (`sha256:<hex>`). */
  assetSha256: string;
  item: DrawingPmiItem;
  /**
   * Whether the item holds on this version: every target unchanged and every datum it depends
   * on current (`cadPmiItemStates`, the PMI rules). A stale item is never drawn as valid.
   */
  current: boolean;
  /** Its first target's model point (placed, mm): where its leader points. */
  target?: Vec3;
}

/**
 * Where an imported PMI annotation stands against the version its view shows: `ok`, `updated`
 * (the item's values changed: drawn as they are now, to be confirmed), `expired` (the item is
 * gone, stale, or another kind now: 失効・要確認), or `pending` while the view derives.
 */
export type DrawingPmiState = 'ok' | 'updated' | 'expired' | 'pending';

const sameKey = (n: DrawingPmiNote, l: DrawingPmiLive) =>
  l.bodyId === n.source.bodyId &&
  l.itemId === n.source.itemId &&
  l.path.length === n.source.path.length &&
  l.path.every((p, i) => p === n.source.path[i]);

/** The live item an imported annotation names, and its state. */
export function drawingPmiResolve(
  note: DrawingPmiNote,
  live: readonly DrawingPmiLive[] | undefined,
): { state: DrawingPmiState; live?: DrawingPmiLive } {
  if (!live) return { state: 'pending' };
  const l = live.find((x) => sameKey(note, x));
  if (!l || !l.current || l.item.kind !== note.item.kind) return { state: 'expired', live: l };
  return {
    state: canonicalJson(l.item) === canonicalJson(note.item) ? 'ok' : 'updated',
    live: l,
  };
}

const number = (v: number) => String(Number(v.toPrecision(12)));
const signed = (v: number) => (v < 0 ? `−${number(-v)}` : `+${number(v)}`);

/** A PMI dimension as a drawing writes it: `Ø10 ±0.05`, `20 +0.1/−0.05`, `30°`. */
export function drawingPmiDimensionText(item: Extract<DrawingPmiItem, { kind: 'dimension' }>) {
  const angle = /Angular/.test(item.type);
  const sign = /SphericalDiameter/.test(item.type)
    ? 'SØ'
    : /Diameter/.test(item.type)
      ? 'Ø'
      : /SphericalRadius/.test(item.type)
        ? 'SR'
        : /Radius/.test(item.type)
          ? 'R'
          : /Thickness/.test(item.type)
            ? 't'
            : '';
  const value = item.values.map(number).join('–') + (angle ? '°' : '');
  const d = item.deviation;
  const tol = !d
    ? ''
    : d.lower === -d.upper
      ? ` ±${number(d.upper)}`
      : ` ${signed(d.upper)}/${signed(d.lower)}`;
  const q = item.qualifier ? ` (${item.qualifier.toUpperCase()})` : '';
  return `${sign}${value}${tol}${q}`;
}

/** The material requirements a frame writes as a symbol; other modifiers are said in words. */
const materials: Record<string, string> = Object.assign(Object.create(null), {
  MAXIMUM_MATERIAL_REQUIREMENT: 'Ⓜ',
  LEAST_MATERIAL_REQUIREMENT: 'Ⓛ',
});
const said = (m: string) => m.replace(/_/g, ' ').toLowerCase();

/** The kernel's tolerance type names (`XCAFDimTolObjects_GeomToleranceType`) as JIS B 0021's. */
const characteristics = new Map<string, DrawingGdtCharacteristic>(
  Object.entries({
    Straightness: 'straightness',
    Flatness: 'flatness',
    Circularity: 'circularity',
    Cylindricity: 'cylindricity',
    ProfileOfLine: 'profile-line',
    ProfileOfSurface: 'profile-surface',
    Parallelism: 'parallelism',
    Perpendicularity: 'perpendicularity',
    Angularity: 'angularity',
    Position: 'position',
    Concentricity: 'concentricity',
    Coaxiality: 'concentricity',
    Symmetry: 'symmetry',
    CircularRunout: 'circular-runout',
    TotalRunout: 'total-runout',
  } satisfies Record<string, DrawingGdtCharacteristic>),
);

/**
 * The symbol a PMI tolerance or datum draws as (DW3b's frame and datum), or undefined when it is
 * written as text: a dimension, a datum target, and whatever the frame cannot say as it is (a
 * tolerance type with no symbol, a spherical zone, a maximum tolerance, datum modifiers, a datum
 * name that is no datum letter).
 */
export function drawingPmiSymbol(item: DrawingPmiItem): DrawingSymbolSpec | undefined {
  if (item.kind === 'datum')
    return drawingDatumPattern.test(item.name) ? { type: 'datum', letter: item.name } : undefined;
  if (item.kind !== 'geometric-tolerance') return undefined;
  const characteristic = characteristics.get(item.type);
  if (
    !characteristic ||
    item.zone === 'SD' ||
    item.maxValue !== undefined ||
    item.datumModifiers?.some((m) => m.length) ||
    item.modifiers.some((m) => !materials[m]) ||
    !item.datums.every((d) => drawingDatumPattern.test(d)) ||
    // A frame's own rules (DW3b): at most three datums, each once; a form takes none, an
    // orientation or location needs one; a short tolerance.
    item.datums.length > 3 ||
    new Set(item.datums).size !== item.datums.length ||
    (drawingGdtForms.includes(characteristic) && item.datums.length > 0) ||
    (drawingGdtNeedsDatum.includes(characteristic) && item.datums.length === 0) ||
    number(item.value).length > 16
  )
    return undefined;
  const modifier = item.modifiers.includes('MAXIMUM_MATERIAL_REQUIREMENT')
    ? 'M'
    : item.modifiers.includes('LEAST_MATERIAL_REQUIREMENT')
      ? 'L'
      : '';
  return {
    type: 'gdt',
    characteristic,
    tolerance: number(item.value),
    diameter: item.zone === 'D',
    modifier,
    datums: item.datums,
  };
}

/** One line for any PMI item (the list, a detached note, a type the frame has no symbol for). */
export function drawingPmiText(item: DrawingPmiItem): string {
  switch (item.kind) {
    case 'dimension':
      return drawingPmiDimensionText(item);
    case 'geometric-tolerance': {
      const zone = item.zone === 'D' ? 'Ø' : item.zone === 'SD' ? 'SØ' : '';
      const max = item.maxValue !== undefined ? ` (max ${number(item.maxValue)})` : '';
      const refs = item.datums.map((d, i) => {
        const m = item.datumModifiers?.[i] ?? [];
        return ` | ${d}${m.length ? ` (${m.map(said).join(', ')})` : ''}`;
      });
      const material = item.modifiers.flatMap((m) => (materials[m] ? [` ${materials[m]}`] : []));
      const others = item.modifiers.filter((m) => !materials[m]).map(said);
      const mods = others.length ? ` (${others.join(', ')})` : '';
      return `${item.type} ${zone}${number(item.value)}${material.join('')}${max}${refs.join('')}${mods}`;
    }
    case 'datum':
      return `データム ${item.name}`;
    case 'datum-target':
      return `${item.datum}${item.number}`;
  }
}

/** What changed between the item as confirmed and as it is now, one line each (DW3c-2b). */
export function drawingPmiChanges(before: DrawingPmiItem, after: DrawingPmiItem): string[] {
  if (before.kind !== after.kind) return [`${before.kind} → ${after.kind}`];
  const a = drawingPmiText(before);
  const b = drawingPmiText(after);
  if (a !== b) return [`${a} → ${b}`];
  // The same line, other details (a modifier, a qualifier).
  return canonicalJson(before) === canonicalJson(after) ? [] : [`${a}（詳細の変更）`];
}
