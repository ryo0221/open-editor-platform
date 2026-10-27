import {
  cadLengthUnits,
  cadLimits,
  cadTolerance,
  type CadBodyEvaluation,
  type CadBodyKind,
  type CadLengthUnit,
  type Vec3,
} from '@editor-platform/cad-core';
import {
  P21ReadError,
  readP21,
  type P21File,
  type P21Instance,
  type P21Value,
} from '@editor-platform/geometry-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { decodeKernelException, type OcModule } from '@editor-platform/geometry-kernel-occt';
import { shapeMetrics } from './metrics';
import { sheetTopology } from './sheet-topology';

/** Information a STEP file carried that the imported body does not keep. */
export type CadStepLoss = 'product-names' | 'appearance' | 'material' | 'source-feature-history';
/**
 * Preflight report of one STEP import (docs/cad/integration.md): what was read, how it was
 * converted and what is lost. Shown before the user adopts the body.
 */
export interface CadStepImportReport {
  source: {
    sha256: string;
    byteLength: number;
    /** Application protocol of `FILE_SCHEMA` (AP242 for an assembly only, R2b-5). */
    schema: 'AP203' | 'AP214' | 'AP242';
    fileSchema: string;
  };
  /** Build whose reader converted the file; the imported feature records it. */
  importerBuildHash: string;
  sourceUnit: CadLengthUnit;
  scaleToMm: number;
  /** Largest vertex/edge/face tolerance after conversion to mm. */
  maxToleranceMm: number;
  body: CadBodyEvaluation;
  brep: { sha256: string; byteLength: number };
  /** No automatic healing is applied; an invalid solid is refused instead. */
  healing: 'none';
  losses: CadStepLoss[];
}
export type CadStepImportCode =
  | 'step-too-large'
  | 'step-unreadable'
  | 'step-schema-unsupported'
  | 'step-external-reference'
  | 'step-assembly'
  /** Product manufacturing information (dimensions, tolerances, datums) is not imported. */
  | 'step-pmi'
  | 'step-unit-unknown'
  | 'step-no-solid'
  | 'step-multiple-solids'
  | 'step-not-single-solid'
  | 'step-invalid-solid'
  /** No solid, and more than one shell or faces that do not connect (R2a-1). */
  | 'step-multiple-shells'
  | 'step-invalid-sheet'
  | 'step-tolerance-unsupported'
  | 'step-coordinate-range'
  | 'step-import-unsupported-build'
  /** The read ran past the job limit and the Worker was stopped. */
  | 'step-import-timeout'
  /** Superseded, cancelled or the Worker stopped before answering; the file may be retried. */
  | 'step-import-interrupted'
  /** The document's exact build is not available here (CatalogKernelPort). */
  | 'kernel-reference-only'
  | 'kernel-build-unavailable'
  | 'kernel-build-revoked'
  | 'kernel-failure';
export type CadStepImportResult =
  | { status: 'ok'; report: CadStepImportReport; brep: Uint8Array }
  | {
      status: 'rejected';
      code: CadStepImportCode;
      /** What the refusal is about, e.g. the schema name, unit or tolerance found. */
      detail?: string;
    };

class Rejected extends Error {
  constructor(
    readonly code: CadStepImportCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}
const reject = (code: CadStepImportCode, detail?: string): never => {
  throw new Rejected(code, detail);
};

/** Entities that point outside the file. The geometry subset never needs them. */
const externalEntities = [
  'DOCUMENT_FILE',
  'EXTERNAL_SOURCE',
  'EXTERNALLY_DEFINED_ITEM',
  'APPLIED_DOCUMENT_REFERENCE',
  'DOCUMENT_REPRESENTATION_TYPE',
];
/**
 * PMI: refused (ST-29 #2) rather than dropped, since dimensions and tolerances carry intent.
 * Matched by family, not by a list of subtypes: a simple-entity encoding names only its leaf
 * type (`CIRCULARITY_TOLERANCE`, `GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE`, …).
 */
const pmiEntity =
  /^(?:DIMENSIONAL_(?:SIZE|LOCATION|CHARACTERISTIC_REPRESENTATION)\w*|DATUM(?:_\w+)?|GEOMETRIC_TOLERANCE\w*|\w+_TOLERANCE|ANNOTATION_OCCURRENCE\w*|DRAUGHTING_CALLOUT\w*)$/;
const lossEntities: [CadStepLoss, string[]][] = [
  [
    'appearance',
    ['STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM', 'COLOUR_RGB', 'DRAUGHTING_PRE_DEFINED_COLOUR'],
  ],
  ['material', ['MATERIAL_DESIGNATION', 'MATERIAL_PROPERTY']],
];

/**
 * Limits of the scan: the file's size is the import's own limit, and no STEP geometry nests
 * lists deeper than a few levels.
 */
const scanLimits = Object.freeze({
  bytes: cadLimits.stepBytes,
  entities: cadLimits.stepBytes,
  depth: 64,
});

/**
 * Reads the exchange structure before the kernel sees it (`geometry-core`'s P21 reader, R2c-1):
 * the ISO 10303-21 header, the application protocol and the entity types that this import
 * refuses or cannot keep. Names inside strings and comments are never entities. References are
 * not resolved here; the kernel's reader reads the file.
 */
export function scanStep(
  bytes: Uint8Array,
  /** R2b-5: an assembly's usages are read, and AP242 (as this kernel writes it) is accepted. */
  options: { assembly?: true } = {},
): {
  schema: 'AP203' | 'AP214' | 'AP242';
  fileSchema: string;
  sourceUnit: CadLengthUnit;
  losses: CadStepLoss[];
  /** Each `PRODUCT`'s entity number, id, name and description, in file order. */
  products: { entity: number; id: string; name: string; description: string }[];
  /** Each `NEXT_ASSEMBLY_USAGE_OCCURRENCE`'s entity number and name (an instance's name). */
  usages: { entity: number; name: string }[];
} {
  let file: P21File;
  try {
    file = readP21(bytes, scanLimits, { references: 'keep' });
  } catch (e) {
    if (!(e instanceof P21ReadError)) throw e;
    return e.code === 'p21-too-large'
      ? reject('step-too-large', e.detail)
      : reject('step-unreadable', e.code);
  }
  // The FILE_SCHEMA entity of the header holds one quoted name.
  const schemaArg = file.header.find((h) => h.type === 'FILE_SCHEMA')?.args[0];
  const first = schemaArg?.t === 'list' ? schemaArg.v[0] : undefined;
  if (first?.t !== 'str') return reject('step-unreadable', 'FILE_SCHEMA');
  const fileSchema = first.v.trim();
  const name = fileSchema.split(/[\s{]/)[0].toUpperCase();
  // A complex instance names its partial entities.
  const types = new Set<string>();
  for (const e of file.entities.values()) for (const p of e.parts ?? [e]) types.add(p.type);
  const assembly = types.has('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  // AP242 is read as an assembly only; a single-body scan names it `step-assembly` below.
  const schema = /^CONFIG_CONTROL_DESIGN$|^AP203_CONFIGURATION_CONTROLLED_3D_DESIGN/.test(name)
    ? 'AP203'
    : /^AUTOMOTIVE_DESIGN(_CC2)?$/.test(name)
      ? 'AP214'
      : (options.assembly || assembly) && /^AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/.test(name)
        ? 'AP242'
        : reject('step-schema-unsupported', fileSchema);
  const external = externalEntities.find((t) => types.has(t));
  if (external) reject('step-external-reference', external);
  if (!options.assembly && assembly) reject('step-assembly', 'NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  const pmi = [...types].find((t) => pmiEntity.test(t));
  if (pmi) reject('step-pmi', pmi);
  const losses: CadStepLoss[] = ['product-names', 'source-feature-history'];
  for (const [loss, names] of lossEntities) if (names.some((t) => types.has(t))) losses.push(loss);
  const text = (v: P21Value | undefined) => (v?.t === 'str' ? v.v : '');
  const products = [...file.entities.values()].flatMap((e) =>
    partsOf(e)
      .filter((p) => p.type === 'PRODUCT')
      .map((p) => ({
        entity: e.id,
        id: text(p.args[0]),
        name: text(p.args[1]),
        description: text(p.args[2]),
      })),
  );
  const usages = [...file.entities.values()].flatMap((e) =>
    partsOf(e)
      .filter((p) => p.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE')
      .map((p) => ({ entity: e.id, name: text(p.args[1]) })),
  );
  return { schema, fileSchema, sourceUnit: lengthUnit(file), losses, products, usages };
}

/** Prefixes of an SI metre and the conversion-based unit names this import can name. */
const siLength: Record<string, CadLengthUnit> = {
  MICRO: 'um',
  MILLI: 'mm',
  CENTI: 'cm',
  $: 'm',
};
const namedLength: Record<string, CadLengthUnit> = { INCH: 'in', FOOT: 'ft' };
/** The partial entities of an instance: itself when simple. */
const partsOf = (e: P21Instance) => e.parts ?? [e];
/**
 * The length unit of the representation context (`GLOBAL_UNIT_ASSIGNED_CONTEXT`), which the
 * reader converts to mm. Every context must name the same one; anything else is unknown.
 */
function lengthUnit(file: P21File): CadLengthUnit {
  const units = new Set<string>();
  for (const e of file.entities.values())
    for (const context of partsOf(e)) {
      const refs = context.type === 'GLOBAL_UNIT_ASSIGNED_CONTEXT' ? context.args[0] : undefined;
      if (refs?.t !== 'list') continue;
      for (const ref of refs.v) {
        const target = ref.t === 'ref' ? file.entities.get(ref.id) : undefined;
        const parts = target ? partsOf(target) : [];
        if (!parts.some((p) => p.type === 'LENGTH_UNIT')) continue;
        const converted = parts.find((p) => p.type === 'CONVERSION_BASED_UNIT');
        if (converted) {
          const n = converted.args[0];
          const name = n?.t === 'str' ? n.v.trim().toUpperCase() : '';
          units.add(namedLength[name] ?? `?${name}`);
        } else {
          const [prefix, unit] = parts.find((p) => p.type === 'SI_UNIT')?.args ?? [];
          const key = prefix?.t === 'enum' ? prefix.v : prefix?.t === 'unset' ? '$' : undefined;
          units.add((unit?.t === 'enum' && unit.v === 'METRE' && key && siLength[key]) || '?SI');
        }
      }
    }
  const [unit] = units;
  if (units.size !== 1 || unit.startsWith('?'))
    reject('step-unit-unknown', [...units].map((u) => u.replace(/^\?/, '')).join(',') || 'none');
  return unit as CadLengthUnit;
}

export const stepImportPaths = Object.freeze({ step: '/i.step', brep: '/i.brep' });

/**
 * Reads one STEP file into one exact solid or sheet in mm and writes it as the normalized BRep
 * asset. Refuses rather than heals: anything but one valid solid, or one valid connected shell
 * without a solid, within the profile's result
 * tolerance, unknown units, other schemas, assemblies and external references. Every handle is
 * deleted before returning.
 */
export function importStep(
  oc: OcModule,
  bytes: Uint8Array,
  importerBuildHash: string,
): CadStepImportResult {
  const owned = new Set<{ delete(): void; isDeleted?(): boolean }>();
  const own = <T>(value: T): T => (owned.add(value as never), value);
  const { step: stepPath, brep: brepPath } = stepImportPaths;
  try {
    if (bytes.byteLength > cadLimits.stepBytes) reject('step-too-large', String(bytes.byteLength));
    if (
      typeof oc.STEPControl_Reader_1 !== 'function' ||
      typeof oc.BRepTools?.Write_3 !== 'function'
    )
      reject('step-import-unsupported-build');
    const scan = scanStep(bytes);
    oc.FS.writeFile(stepPath, bytes);
    const reader = own(new oc.STEPControl_Reader_1());
    if (reader.ReadFile(stepPath) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
      reject('step-unreadable', 'read');
    reader.TransferRoots(own(new oc.Message_ProgressRange_1()));
    const shape = own(reader.OneShape());
    const count = (kind: string, avoid = 'TopAbs_SHAPE', of: unknown = shape) => {
      let n = 0;
      const ex = own(
        new oc.TopExp_Explorer_2(of, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum[avoid]),
      );
      for (; ex.More(); ex.Next()) n++;
      return n;
    };
    // One solid (`manifold_solid_brep`) is a solid body; without a solid, one shell of connected
    // faces (`shell_based_surface_model`, open or closed) is a sheet (docs/cad/r2a-freeform.md).
    const solids = count('TopAbs_SOLID');
    const shells = count('TopAbs_SHELL');
    if (solids > 1) reject('step-multiple-solids', String(solids));
    if (!solids && !shells) reject('step-no-solid', '0');
    if (!solids && shells > 1) reject('step-multiple-shells', String(shells));
    const kind: CadBodyKind = solids ? 'solid' : 'sheet';
    const ex = own(
      new oc.TopExp_Explorer_2(
        shape,
        oc.TopAbs_ShapeEnum[solids ? 'TopAbs_SOLID' : 'TopAbs_SHELL'],
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      ),
    );
    const current = own(ex.Current());
    const solid = own(solids ? oc.TopoDS.Solid_1(current) : oc.TopoDS.Shell_1(current));
    // Free shells, faces, edges or points beside the body are not part of the subset: the
    // whole shape must have no sub-shape the body does not.
    for (const sub of ['TopAbs_SHELL', 'TopAbs_FACE', 'TopAbs_EDGE', 'TopAbs_VERTEX'])
      if (count(sub) !== count(sub, 'TopAbs_SHAPE', solid)) reject('step-not-single-solid', sub);
    const sheet = kind === 'sheet' ? sheetTopology(oc, solid, own) : undefined;
    if (sheet && !sheet.connected) reject('step-multiple-shells', 'faces');
    if (!own(new oc.BRepCheck_Analyzer(solid, true, false)).IsValid_2())
      reject(sheet ? 'step-invalid-sheet' : 'step-invalid-solid');
    const maxToleranceMm = own(new oc.ShapeAnalysis_ShapeTolerance()).Tolerance(
      solid,
      1,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    // The D2 profile is not decided: above the D1 result limit is unsupported, never relaxed.
    if (maxToleranceMm > cadTolerance.maxResultLinearToleranceMm)
      reject('step-tolerance-unsupported', String(maxToleranceMm));
    const metrics = shapeMetrics(oc, solid, own, !sheet);
    if (!sheet && !(metrics.volumeMm3! > 0)) reject('step-invalid-solid', 'volume');
    const box = own(new oc.Bnd_Box_1());
    oc.BRepBndLib.AddOptimal(solid, box, false, false);
    const [min, max] = [own(box.CornerMin()), own(box.CornerMax())];
    const bounds: [Vec3, Vec3] = [
      [min.X(), min.Y(), min.Z()],
      [max.X(), max.Y(), max.Z()],
    ];
    if (bounds.flat().some((v) => !(Math.abs(v) <= cadLimits.coordinateMm)))
      reject('step-coordinate-range');
    if (!oc.BRepTools.Write_3(solid, brepPath, own(new oc.Message_ProgressRange_1())))
      reject('kernel-failure', 'brep-write');
    const brep = oc.FS.readFile(brepPath) as Uint8Array;
    if (brep.byteLength > cadLimits.brepBytes) reject('step-too-large', 'brep');
    return {
      status: 'ok',
      brep,
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
        maxToleranceMm,
        body: sheet
          ? {
              kind: 'sheet',
              areaMm2: metrics.areaMm2,
              bounds,
              freeEdges: sheet.freeEdges,
              freeEdgeLengthMm: sheet.freeEdgeLengthMm,
            }
          : { kind: 'solid', volumeMm3: metrics.volumeMm3!, areaMm2: metrics.areaMm2, bounds },
        brep: { sha256: `sha256:${bytesToHex(sha256(brep))}`, byteLength: brep.byteLength },
        healing: 'none',
        losses: scan.losses,
      },
    };
  } catch (error) {
    if (error instanceof Rejected)
      return {
        status: 'rejected',
        code: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
      };
    // An OCCT exception on malformed input is the file's fault; anything else is ours.
    const decoded = decodeKernelException(oc, error);
    return typeof error === 'number'
      ? { status: 'rejected', code: 'step-unreadable', detail: decoded.type }
      : { status: 'rejected', code: 'kernel-failure', detail: decoded.message };
  } finally {
    for (const path of [stepPath, brepPath])
      if (oc.FS?.analyzePath(path).exists) oc.FS.unlink(path);
    for (const value of [...owned].reverse())
      if (value && typeof value.delete === 'function' && !value.isDeleted?.()) value.delete();
  }
}
