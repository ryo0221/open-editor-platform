/**
 * R2b-5 (docs/cad/r2b-assembly.md, STEP AP242 取り込み, R2b-U7): reads a STEP assembly through
 * OCCT's XDE into its distinct shapes and its flattened instances. A product's solids (or,
 * without a solid, its shells) are its shapes, each written once as a normalized BRep; a product
 * with neither is skipped. Every instance is placed by its location composed down the tree.
 * Refuses rather than heals, as the single-solid import does, and refuses more instances than
 * the document can hold before anything is written.
 */
import {
  cadLengthUnits,
  cadLimits,
  cadStepImportLimits,
  cadTolerance,
  stepName,
  type CadBodyKind,
  type CadLengthUnit,
  type CadStepAssemblyRead,
  type Quaternion,
  type Vec3,
} from '@editor-platform/cad-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { decodeKernelException, type OcModule } from '@editor-platform/geometry-kernel-occt';
import { shapeMetrics } from './metrics';
import { sheetTopology } from './sheet-topology';
import { scanStep, type CadStepImportCode, type CadStepLoss } from './step-import';

/** Preflight report of a STEP assembly import: what was read and what is not kept. */
export interface CadStepAssemblyImportReport {
  source: {
    sha256: string;
    byteLength: number;
    schema: 'AP203' | 'AP214' | 'AP242';
    fileSchema: string;
  };
  importerBuildHash: string;
  sourceUnit: CadLengthUnit;
  scaleToMm: number;
  /** Products whose shapes were split into one part per solid (or sheet), with the count. */
  split: { name: string; count: number }[];
  /** Largest nesting of the file's tree (1 when every instance sits in the root). */
  depth: number;
  healing: 'none';
  losses: (CadStepLoss | 'nesting')[];
}
export type CadStepAssemblyImportCode =
  | CadStepImportCode
  /** More instances than one document's components (1,024). */
  | 'step-instance-limit'
  /** An instance's placement scales or mirrors its product. */
  | 'step-instance-transform'
  /** The file's tree nests deeper than an assembly may (8). */
  | 'step-depth-limit'
  /** No instance has a solid or sheet. */
  | 'step-assembly-empty';
export type CadStepAssemblyImportResult =
  | {
      status: 'ok';
      read: CadStepAssemblyRead;
      report: CadStepAssemblyImportReport;
      /** Each shape's normalized BRep, in `read.shapes` order. */
      breps: Uint8Array[];
    }
  | { status: 'rejected'; code: CadStepAssemblyImportCode; detail?: string };

/** The entities whose names the assembly reader is given as placeholders. */
export type CadStepNamed = 'PRODUCT' | 'NEXT_ASSEMBLY_USAGE_OCCURRENCE';
/**
 * `bytes` with the name (second argument) of each simple `#n = PRODUCT(…)` and
 * `#n = NEXT_ASSEMBLY_USAGE_OCCURRENCE(…)` instance replaced by `name(type, n)`'s P21 string
 * (unchanged when it returns undefined). Tokens are read as the P21 reader reads them (comments
 * between any two, strings with `''`), and every byte outside a replaced name is kept as it is.
 */
export function renameEntities(
  bytes: Uint8Array,
  name: (type: CadStepNamed, entity: number) => string | undefined,
): Uint8Array {
  const out: Uint8Array[] = [];
  let kept = 0;
  /** The last tokens: kind (`s` string, `w` word, or the punctuation byte) and span. */
  const last: { k: string; a: number; b: number }[] = [];
  const word = (c: number) =>
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f ||
    c === 0x23 ||
    c === 0x2e ||
    c === 0x2d ||
    c === 0x2b ||
    c === 0x24;
  const text = (t: { a: number; b: number }) => String.fromCharCode(...bytes.subarray(t.a, t.b));
  const push = (k: string, a: number, b: number) => {
    last.push({ k, a, b });
    if (last.length > 7) last.shift();
    // #n = PRODUCT ( 'id' , 'name'
    const [n, eq, type, open, , comma, value] = last;
    if (
      last.length === 7 &&
      value!.k === 's' &&
      comma!.k === ',' &&
      last[4]!.k === 's' &&
      open!.k === '(' &&
      type!.k === 'w' &&
      /^(PRODUCT|NEXT_ASSEMBLY_USAGE_OCCURRENCE)$/i.test(text(type!)) &&
      eq!.k === '=' &&
      n!.k === 'w' &&
      /^#\d+$/.test(text(n!))
    ) {
      const replacement = name(
        text(type!).toUpperCase() as CadStepNamed,
        Number(text(n!).slice(1)),
      );
      if (replacement !== undefined) {
        out.push(bytes.subarray(kept, value!.a), new TextEncoder().encode(replacement));
        kept = value!.b;
      }
    }
  };
  for (let i = 0; i < bytes.length; ) {
    const c = bytes[i]!;
    if (c === 0x2f && bytes[i + 1] === 0x2a) {
      // A comment: skipped up to its end.
      let j = i + 2;
      while (j < bytes.length && !(bytes[j] === 0x2a && bytes[j + 1] === 0x2f)) j++;
      i = j + 2;
    } else if (c === 0x27) {
      let j = i + 1;
      while (j < bytes.length && !(bytes[j] === 0x27 && bytes[j + 1] !== 0x27))
        j += bytes[j] === 0x27 ? 2 : 1;
      push('s', i, j + 1);
      i = j + 1;
    } else if (c <= 0x20) i++;
    else if (word(c)) {
      let j = i + 1;
      while (j < bytes.length && word(bytes[j]!)) j++;
      push('w', i, j);
      i = j;
    } else {
      push(String.fromCharCode(c), i, i + 1);
      i++;
    }
  }
  out.push(bytes.subarray(kept));
  const result = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of out) {
    result.set(b, at);
    at += b.length;
  }
  return result;
}

/** The placeholder product and usage (instance) names the reader is given. */
const placeholder = 'R2B5Q';
const usagePlaceholder = 'R2B5N';

class Rejected extends Error {
  constructor(
    readonly code: CadStepAssemblyImportCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}
const reject = (code: CadStepAssemblyImportCode, detail?: string): never => {
  throw new Rejected(code, detail);
};

const paths = Object.freeze({ step: '/ia.step', brep: '/ia.brep' });

export function importStepAssembly(
  oc: OcModule,
  bytes: Uint8Array,
  importerBuildHash: string,
): CadStepAssemblyImportResult {
  const owned = new Set<{ delete(): void; isDeleted?(): boolean }>();
  const own = <T>(value: T): T => (owned.add(value as never), value);
  try {
    if (bytes.byteLength > cadLimits.stepBytes) reject('step-too-large', String(bytes.byteLength));
    if (
      typeof oc.STEPCAFControl_Reader_1 !== 'function' ||
      typeof oc.OCJS?.labelName !== 'function' ||
      typeof oc.BRepTools?.Write_3 !== 'function'
    )
      reject('step-import-unsupported-build');
    const scan = scanStep(bytes, { assembly: true });
    // XDE keeps a product's name only, names need not be unique, and its names lose characters
    // outside ASCII: the reader is given a copy whose PRODUCT and usage names are placeholders,
    // each naming one entity the scan read.
    const byEntity = new Map(scan.products.map((p) => [p.entity, p]));
    const usageNames = new Map(scan.usages.map((u) => [u.entity, u.name]));
    const named: (typeof scan.products)[number][] = [];
    const usages: string[] = [];
    oc.FS.writeFile(
      paths.step,
      renameEntities(bytes, (type, entity) => {
        if (type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') {
          const name = usageNames.get(entity);
          return name === undefined ? undefined : `'${usagePlaceholder}${usages.push(name) - 1}'`;
        }
        const product = byEntity.get(entity);
        return product && `'${placeholder}${named.push(product) - 1}'`;
      }),
    );
    const reader = own(new oc.STEPCAFControl_Reader_1());
    reader.SetNameMode(true);
    if (reader.ReadFile(paths.step) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
      reject('step-unreadable', 'read');
    const text = (s: string) => own(new oc.TCollection_ExtendedString_2(s, false));
    const doc = own(new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(text('MDTV-XCAF'))));
    if (!reader.Transfer_1(doc, own(new oc.Message_ProgressRange_1())))
      reject('step-unreadable', 'transfer');
    const tool = own(oc.XCAFDoc_DocumentTool.ShapeTool(doc.get().Main())).get();
    const nameOf = (label: unknown) => own(oc.OCJS.labelName(label)).ToCString() as string;
    /** A product label's PRODUCT, by its placeholder. */
    const productOf = (label: unknown) => {
      const name = nameOf(label);
      const at = name.startsWith(placeholder)
        ? named[Number(name.slice(placeholder.length))]
        : undefined;
      return at ?? { entity: 0, id: '', name, description: '' };
    };
    /** A component's usage name as the file gives it (empty when it has none). */
    const usageName = (label: unknown) => {
      const name = nameOf(label);
      return name.startsWith(usagePlaceholder)
        ? (usages[Number(name.slice(usagePlaceholder.length))] ?? '')
        : name;
    };
    /** A product's name as the file gives it (its id when it has none). */
    const productName = (label: unknown) => {
      const p = productOf(label);
      return p.name || p.id;
    };

    const read: CadStepAssemblyRead = { shapes: [], instances: [], skipped: [] };
    const breps: Uint8Array[] = [];
    const split: CadStepAssemblyImportReport['split'] = [];
    /** Each leaf product read so far: its prototype shape and its shapes' indices. */
    const products: { shape: { IsSame(o: unknown): boolean }; shapes: number[] }[] = [];
    let depth = 0;

    const leaf = (label: unknown) => {
      const { id, name: given, description } = productOf(label);
      const name = given || id;
      const prototype = own(oc.XCAFDoc_ShapeTool.GetShape_2(label));
      const known = products.find((p) => p.shape.IsSame(prototype));
      if (known) return known.shapes;
      const solids = collect(prototype, 'TopAbs_SOLID', 'TopAbs_SHAPE');
      // Without a solid, each shell of connected faces is a sheet (as the single import reads).
      const kind: CadBodyKind = solids.length ? 'solid' : 'sheet';
      const found = solids.length ? solids : collect(prototype, 'TopAbs_SHELL', 'TopAbs_SOLID');
      const product = { id, name: given, description };
      const shapes = found.map((shape, i) => {
        const one = own(kind === 'solid' ? oc.TopoDS.Solid_1(shape) : oc.TopoDS.Shell_1(shape));
        const bounds = check(one, kind);
        if (!oc.BRepTools.Write_3(one, paths.brep, own(new oc.Message_ProgressRange_1())))
          reject('kernel-failure', 'brep-write');
        const brep = oc.FS.readFile(paths.brep) as Uint8Array;
        if (brep.byteLength > cadLimits.brepBytes) reject('step-too-large', 'brep');
        breps.push(brep);
        read.shapes.push({
          name: stepName(name, 'STEP', found.length > 1 ? ` (${i + 1})` : ''),
          product,
          kind,
          brep: { sha256: `sha256:${bytesToHex(sha256(brep))}`, byteLength: brep.byteLength },
          boundsMm: bounds,
        });
        return read.shapes.length - 1;
      });
      if (!shapes.length) read.skipped.push(name);
      if (shapes.length > 1) split.push({ name, count: shapes.length });
      products.push({ shape: prototype, shapes });
      return shapes;
    };
    const collect = (shape: unknown, kind: string, avoid: string) => {
      const found: unknown[] = [];
      const ex = own(
        new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum[avoid]),
      );
      for (; ex.More(); ex.Next()) found.push(own(ex.Current()));
      return found;
    };
    /** A shape as the single import accepts it: valid, within tolerance and range. */
    const check = (shape: unknown, kind: CadBodyKind): [Vec3, Vec3] => {
      const sheet = kind === 'sheet' ? sheetTopology(oc, shape, own) : undefined;
      if (sheet && !sheet.connected) reject('step-multiple-shells', 'faces');
      if (!own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2())
        reject(sheet ? 'step-invalid-sheet' : 'step-invalid-solid');
      const tolerance = own(new oc.ShapeAnalysis_ShapeTolerance()).Tolerance(
        shape,
        1,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      );
      if (tolerance > cadTolerance.maxResultLinearToleranceMm)
        reject('step-tolerance-unsupported', String(tolerance));
      if (!sheet && !(shapeMetrics(oc, shape, own, true).volumeMm3! > 0))
        reject('step-invalid-solid', 'volume');
      const box = own(new oc.Bnd_Box_1());
      oc.BRepBndLib.AddOptimal(shape, box, false, false);
      const [min, max] = [own(box.CornerMin()), own(box.CornerMax())];
      const bounds: [Vec3, Vec3] = [
        [min.X(), min.Y(), min.Z()],
        [max.X(), max.Y(), max.Z()],
      ];
      if (bounds.flat().some((v) => !(Math.abs(v) <= cadLimits.coordinateMm)))
        reject('step-coordinate-range');
      return bounds;
    };
    /** Places `label` (a product) at `trsf`, reached through `path`. */
    const place = (label: unknown, trsf: unknown, path: string[], level: number) => {
      if (level > cadStepImportLimits.depth)
        reject('step-depth-limit', String(cadStepImportLimits.depth));
      depth = Math.max(depth, level);
      const components = own(new oc.TDF_LabelSequence_1());
      oc.XCAFDoc_ShapeTool.GetComponents(label, components, false);
      if (components.Length() > 0) {
        for (let i = 1; i <= components.Length(); i++) {
          const component = components.Value(i);
          const referred = own(new oc.TDF_Label());
          if (!oc.XCAFDoc_ShapeTool.GetReferredShape(component, referred)) continue;
          const local = own(own(oc.XCAFDoc_ShapeTool.GetLocation(component)).Transformation());
          const total = own((trsf as { Multiplied(t: unknown): unknown }).Multiplied(local));
          const name = usageName(component) || productName(referred);
          place(referred, total, [...path, name], level + 1);
        }
        return;
      }
      const shapes = leaf(label);
      if (!shapes.length) return;
      const t = trsf as {
        ScaleFactor(): number;
        IsNegative(): boolean;
        Value(r: number, c: number): number;
        GetRotation_2(): { X(): number; Y(): number; Z(): number; W(): number; delete(): void };
      };
      if (Math.abs(t.ScaleFactor() - 1) > 1e-9 || t.IsNegative())
        reject('step-instance-transform', path.join(' / '));
      const translation = [1, 2, 3].map((r) => t.Value(r, 4)) as Vec3;
      if (translation.some((v) => !(Math.abs(v) <= cadLimits.coordinateMm)))
        reject('step-coordinate-range');
      const q = own(t.GetRotation_2());
      const n = Math.hypot(q.X(), q.Y(), q.Z(), q.W());
      const rotation: Quaternion = [q.X() / n, q.Y() / n, q.Z() / n, q.W() / n];
      for (const shape of shapes) {
        read.instances.push({ shape, path, pose: { translationMm: translation, rotation } });
        // Refused while reading: the file is never imported in part.
        if (read.instances.length > cadStepImportLimits.components)
          reject('step-instance-limit', String(cadStepImportLimits.components));
      }
    };
    const free = own(new oc.TDF_LabelSequence_1());
    tool.GetFreeShapes(free);
    for (let i = 1; i <= free.Length(); i++) {
      const label = free.Value(i);
      place(label, own(new oc.gp_Trsf_1()), [productName(label)], 0);
    }
    if (!read.instances.length) reject('step-assembly-empty');
    const losses: CadStepAssemblyImportReport['losses'] = [...scan.losses];
    if (depth > 1) losses.push('nesting');
    return {
      status: 'ok',
      read,
      breps,
      report: {
        source: {
          sha256: `sha256:${bytesToHex(sha256(bytes))}`,
          byteLength: bytes.byteLength,
          schema: scan.schema,
          fileSchema: scan.fileSchema,
        },
        importerBuildHash,
        sourceUnit: scan.sourceUnit,
        scaleToMm: cadLengthUnits[scan.sourceUnit],
        split,
        depth,
        healing: 'none',
        losses,
      },
    };
  } catch (error) {
    if (error instanceof Rejected)
      return {
        status: 'rejected',
        code: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
      };
    // The single import's checks throw its own rejection type.
    if (error instanceof Error && 'code' in error && typeof error.code === 'string')
      return {
        status: 'rejected',
        code: error.code as CadStepAssemblyImportCode,
        ...('detail' in error && typeof error.detail === 'string' ? { detail: error.detail } : {}),
      };
    const decoded = decodeKernelException(oc, error);
    return typeof error === 'number'
      ? { status: 'rejected', code: 'step-unreadable', detail: decoded.type }
      : { status: 'rejected', code: 'kernel-failure', detail: decoded.message };
  } finally {
    for (const path of [paths.step, paths.brep])
      if (oc.FS?.analyzePath(path).exists) oc.FS.unlink(path);
    for (const value of [...owned].reverse())
      if (value && typeof value.delete === 'function' && !value.isDeleted?.()) value.delete();
  }
}
