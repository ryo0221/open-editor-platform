/**
 * PMI-4b/4c (docs/cad/pmi.md, 書き出し): a part's current PMI written into its STEP AP242
 * through OCCT's XDE (`OCJS.addPmi`, `STEPCAFControl_Writer` with DimTol mode). Only items that
 * are current on the body (`cadPmiItemStates`) are written, each on the body's own faces, edges
 * and vertices; whatever is not written is counted for the export report.
 */
import {
  cadLimits,
  placePmiDirection,
  placePmiPoint,
  type CadPmiAsset,
  type CadPmiItem,
  type CadPmiItemState,
  type CadPmiKind,
  type CadPmiPlacement,
  type CadPmiTarget,
  type Vec3,
} from '@editor-platform/cad-core';
import { CadKernelError, type OcModule } from './evaluator';
import {
  pmiDatumModifiers,
  pmiDimensionTypes,
  pmiToleranceModifiers,
  pmiToleranceTypes,
} from './step-pmi';

/** What an export wrote of its bodies' PMI, and what it did not (the report lists both). */
export interface CadStepPmiWritten {
  /** Items written, by kind. */
  written: Record<CadPmiKind, number>;
  /** Items not written because they are stale on the body (PMI-4a), or all of a body whose PMI imports meet. */
  stale: number;
  /**
   * Current items the writer cannot write as the asset keeps them: datum targets (the asset
   * keeps no target geometry), datums that stand only on datum targets, tolerances that
   * reference a datum not written, and items with a modifier or value the writer has no form for.
   */
  unwritable: number;
  /** Written items whose presentation lines were written. */
  presented: number;
  /**
   * Written items whose presentation lines were not: the body's placement is not one rigid
   * path from the import (a pattern's copy), or a segment has no length.
   */
  presentationLost: number;
  /** Saved views of the written bodies' PMI: OCCT 7.6's writer writes no views. */
  views: number;
  /** Items of bodies evaluated with a build that has no PMI writer (an earlier build): none written. */
  unsupportedBuild: number;
}

export const noPmiWritten = (): CadStepPmiWritten => ({
  written: { dimension: 0, 'geometric-tolerance': 0, datum: 0, 'datum-target': 0 },
  stale: 0,
  unwritable: 0,
  presented: 0,
  presentationLost: 0,
  views: 0,
  unsupportedBuild: 0,
});

/** `TopAbs_ShapeEnum` values of the kinds a target names. */
export interface PmiShapeKinds {
  face: number;
  edge: number;
  vertex: number;
}

const hex = (s: string) =>
  Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const num = (v: number) => String(v);
/** Checks values without spreading them into a call (a presentation can hold millions). */
const finite = (v: readonly number[]) => v.every(Number.isFinite);

/**
 * The `OCJS.addPmi` lines for one body's asset: its current items, targets as 1-based indices
 * in `TopExp::MapShapes` of the written shape (`shapeIndex`, undefined when the target is not
 * there unchanged), presentation lines placed by `placements` (undefined: not written).
 * Counts go into `report`. `datumNames` holds the datum names other bodies of the same file
 * already wrote: the writer merges datums by name across the whole file, so a datum with a name
 * already written (by another body, or earlier in this asset on other targets), and what
 * references it, is left out and counted, never attached to the other datum. This body's
 * written names are added to it.
 */
export function pmiWriteSpec(
  asset: CadPmiAsset,
  states: ReadonlyMap<string, CadPmiItemState>,
  kinds: PmiShapeKinds,
  shapeIndex: (t: CadPmiTarget) => number | undefined,
  placements: readonly CadPmiPlacement[] | undefined,
  report: CadStepPmiWritten,
  datumNames: Set<string> = new Set(),
): string[] {
  const lines: string[] = [];
  // Saved views are never written, whether or not any item of the asset is.
  report.views += asset.views?.length ?? 0;
  const targets = (list: readonly CadPmiTarget[]): string | undefined => {
    const out = [String(list.length)];
    for (const t of list) {
      const i = shapeIndex(t);
      if (i === undefined || i < 1) return undefined;
      out.push(String(kinds[t.shape]), String(i));
    }
    return out.join(' ');
  };
  /** The presentation suffix: '' when the item has none or it is not written. */
  const presentation = (item: CadPmiItem): string => {
    const p = item.presentation;
    if (!p?.segments.length) return '';
    const s = p.segments;
    const at = (i: number): Vec3 => placePmiPoint(placements!, [s[i]!, s[i + 1]!, s[i + 2]!]);
    let degenerate = !placements || s.length % 6 !== 0 || !finite(s);
    const out: string[] = [];
    for (let i = 0; !degenerate && i + 5 < s.length; i += 6) {
      const a = at(i);
      const b = at(i + 3);
      // OCCT's Precision::Confusion (1e-7 mm): the writer cannot make an edge shorter.
      if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) <= 1e-7) degenerate = true;
      out.push(...a.map(num), ...b.map(num));
    }
    if (degenerate) {
      report.presentationLost++;
      return '';
    }
    report.presented++;
    const plane = p.plane
      ? [
          '1',
          ...placePmiPoint(placements!, p.plane.origin).map(num),
          ...placePmiDirection(placements!, p.plane.z).map(num),
          ...placePmiDirection(placements!, p.plane.x).map(num),
        ]
      : ['0'];
    return ` prs ${plane.join(' ')} ${s.length / 6} ${out.join(' ')}`;
  };
  const current = (item: CadPmiItem) => states.get(item.id)?.current === true;
  const datumOrdinal = new Map<string, number>();
  for (const item of asset.items) {
    if (!current(item)) {
      report.stale++;
      continue;
    }
    if (item.kind === 'datum-target') {
      report.unwritable++;
      continue;
    }
    if (item.kind !== 'datum') continue;
    const t =
      item.targets.length && item.name && !datumNames.has(item.name)
        ? targets(item.targets)
        : undefined;
    if (!t) {
      report.unwritable++;
      continue;
    }
    datumOrdinal.set(item.id, datumOrdinal.size);
    datumNames.add(item.name);
    lines.push(`dat ${hex(item.name)} ${t}${presentation(item)}`);
    report.written.datum++;
  }
  for (const item of asset.items) {
    if (!current(item)) continue;
    if (item.kind === 'dimension') {
      const type = pmiDimensionTypes.indexOf(item.type as (typeof pmiDimensionTypes)[number]);
      const first = targets(item.targets);
      const second = targets(item.targets2 ?? []);
      const d = item.deviation;
      const qualifier = item.qualifier ? ['min', 'max', 'avg'].indexOf(item.qualifier) + 1 : -1;
      if (
        type < 0 ||
        // A dimension along a path needs the path, which the asset does not keep.
        item.type === 'Location_WithPath' ||
        item.type === 'Size_WithPath' ||
        !first ||
        !second ||
        item.values.length < 1 ||
        item.values.length > 2 ||
        (d && item.values.length !== 1) ||
        !finite([...item.values, d?.lower ?? 0, d?.upper ?? 0])
      ) {
        report.unwritable++;
        continue;
      }
      // XDE keeps the lower deviation as a magnitude below the nominal; the writer negates it.
      lines.push(
        [
          'dim',
          type,
          qualifier,
          item.values.length,
          ...item.values.map(num),
          d ? 1 : 0,
          num(d ? -d.lower : 0),
          num(d ? d.upper : 0),
          first,
          second,
        ].join(' ') + presentation(item),
      );
      report.written.dimension++;
    } else if (item.kind === 'geometric-tolerance') {
      const type = pmiToleranceTypes.indexOf(item.type as (typeof pmiToleranceTypes)[number]);
      const isMaterial = (m: string) =>
        m === 'MAXIMUM_MATERIAL_REQUIREMENT' || m === 'LEAST_MATERIAL_REQUIREMENT';
      const material = item.modifiers.filter(isMaterial);
      const modifiers = item.modifiers
        .filter((m) => !isMaterial(m))
        .map((m) => pmiToleranceModifiers.indexOf(m as (typeof pmiToleranceModifiers)[number]));
      const compartments = item.references.map((r) => {
        const datums = r.datums.map((id) => datumOrdinal.get(id));
        const mods = r.modifiers.map((m) =>
          pmiDatumModifiers.indexOf(m as (typeof pmiDatumModifiers)[number]),
        );
        return datums.some((d) => d === undefined) || mods.some((m) => m < 0) || !datums.length
          ? undefined
          : [datums.length, ...datums, mods.length, ...mods].join(' ');
      });
      const t = targets(item.targets);
      if (
        type < 0 ||
        !t ||
        material.length > 1 ||
        modifiers.some((m) => m < 0) ||
        compartments.some((c) => c === undefined) ||
        !finite([item.value, item.maxValue ?? 0]) ||
        (item.maxValue ?? 0) < 0
      ) {
        report.unwritable++;
        continue;
      }
      lines.push(
        [
          'tol',
          type,
          num(item.value),
          item.zone === 'D' ? 1 : item.zone === 'SD' ? 2 : 0,
          material[0] === 'MAXIMUM_MATERIAL_REQUIREMENT' ? 1 : material.length ? 2 : 0,
          num(item.maxValue ?? 0),
          modifiers.length,
          ...modifiers,
          t,
          compartments.length,
          ...compartments,
        ].join(' ') + presentation(item),
      );
      report.written['geometric-tolerance']++;
    }
  }
  return lines;
}

/** `write.step.schema` 5 selects AP242 (DIS); the writer's default (AP214) is restored after. */
const ap242 = 5;

/**
 * Writes the bodies as AP242 in millimetres, one free shape each, with each body's `pmi` lines
 * on its own shape. Every OCCT object it makes is deleted before it returns.
 */
export function writePmiStep(
  oc: OcModule,
  bodies: readonly { id: string; shape: unknown; pmi: readonly string[] }[],
): Uint8Array {
  if (
    typeof oc.STEPCAFControl_Writer_1 !== 'function' ||
    typeof oc.OCJS?.addPmi !== 'function' ||
    typeof oc.OCJS?.setStaticInteger !== 'function'
  )
    throw new CadKernelError('step-pmi-unsupported-build');
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(x: T) => (owned.push(x), x);
  const text = (s: string) => own(new oc.TCollection_ExtendedString_2(s, false));
  // As the assembly writer: one writer makes the statics, then the schema, then the one that writes.
  new oc.STEPCAFControl_Writer_1().delete();
  const schema = oc.OCJS.staticInteger('write.step.schema');
  const path = '/p.step';
  try {
    const doc = own(new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(text('MDTV-XCAF'))));
    const shapes = own(oc.XCAFDoc_DocumentTool.ShapeTool(doc.get().Main())).get();
    for (const body of bodies) {
      // XDE makes a located shape a reference to an unlocated copy (an assembly, whose
      // sub-shapes PMI cannot name): a located body goes in a compound of its own instead.
      // The compound holds only the body, so its maps list the body's sub-shapes in order.
      let shape = body.shape as { Location_1(): { IsIdentity(): boolean; delete(): void } };
      if (!own(shape.Location_1()).IsIdentity()) {
        const builder = own(new oc.BRep_Builder());
        const compound = own(new oc.TopoDS_Compound());
        builder.MakeCompound(compound);
        builder.Add(compound, shape);
        shape = compound;
      }
      // Not an assembly and not prepared: the label's shape is the body's, so its maps match.
      const label = own(shapes.AddShape(shape, false, false));
      if (!body.pmi.length) continue;
      const spec = own(new oc.TCollection_AsciiString_2(body.pmi.join('\n')));
      if (oc.OCJS.addPmi(doc, label, spec) !== body.pmi.length)
        throw new CadKernelError('step-write-failed', body.id);
    }
    if (!oc.OCJS.setStaticInteger('write.step.schema', ap242))
      throw new CadKernelError('step-pmi-unsupported-build');
    const writer = own(new oc.STEPCAFControl_Writer_1());
    writer.SetDimTolMode(true);
    if (
      !writer.Transfer_1(
        doc,
        oc.STEPControl_StepModelType.STEPControl_AsIs,
        null,
        own(new oc.Message_ProgressRange_1()),
      )
    )
      throw new CadKernelError('step-write-failed');
    if (writer.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
      throw new CadKernelError('step-write-failed');
    const bytes = oc.FS.readFile(path) as Uint8Array;
    if (bytes.byteLength > cadLimits.stepBytes) throw new CadKernelError('step-too-large');
    return bytes;
  } finally {
    oc.OCJS.setStaticInteger('write.step.schema', schema);
    if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
    for (const x of owned.reverse()) x.delete();
  }
}
