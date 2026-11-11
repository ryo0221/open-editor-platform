import {
  cadLengthUnits,
  cadLimits,
  cadImportToleranceMm,
  cadPmiLimits,
  type CadPmiAsset,
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
import {
  canReadPmi,
  comparePmi,
  pmiCensus,
  pmiJsonOf,
  linkedCallouts,
  pmiLossless,
  presentationOfItems,
  presentedVertices,
  viewsOfItems,
  verifiedPmi,
  type CadItemViews,
  type CadPmiCensus,
  type PmiItemJson,
  type CadStepPmiReport,
  readPmiText,
  type CadPmiSemantics,
} from './step-pmi';
import { keepPmi, type PmiProduct } from './step-pmi-keep';
import { pmiPresentation, type PmiFilePresentation } from './step-pmi-presentation';
import { pmiPathOf, type PmiPath } from './step-pmi-path';
/** No semantics read: nothing matches, so nothing is reported as read. */
const noSemantics: CadPmiSemantics = {
  dimensions: [],
  tolerances: [],
  datums: [],
  datumTargets: [],
  systems: [],
  targets: {
    dimension: [],
    'geometric-tolerance': [],
    datum: [],
    'datum-target': [],
  },
  datumFeatures: [],
  entities: { dimension: [], 'geometric-tolerance': [], datum: [], 'datum-target': [] },
};

/** Information a STEP file carried that the imported body does not keep. */
export type CadStepLoss =
  | 'product-names'
  | 'appearance'
  | 'material'
  | 'source-feature-history'
  /** PMI-1: the file's PMI, which the document does not keep yet (report `pmi`). */
  | 'pmi';
/**
 * PMI-1 (docs/cad/pmi.md, PMI-U3): a file with PMI is refused (`step-pmi-partial`) unless the
 * user agreed to import its shape without the PMI, which the report then lists as lost.
 */
export interface CadStepImportOptions {
  pmi?: 'refuse' | 'discard';
}
/**
 * Preflight report of one STEP import (docs/cad/integration.md): what was read, how it was
 * converted and what is lost. Shown before the user adopts the body.
 */
export interface CadStepImportReport {
  source: {
    sha256: string;
    byteLength: number;
    /** Application protocol of `FILE_SCHEMA` (AP242: R2b-5 for an assembly, #811 for one part). */
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
  /** The file's PMI, read, compared and (PMI-2) what of it is kept; absent without PMI. */
  pmi?: CadStepPmiReport;
  /** PMI-2: the body's `pmi` asset, when at least one item is kept (the bytes are `pmi`). */
  pmiAsset?: { sha256: string; byteLength: number };
}
export type CadStepImportCode =
  | 'step-too-large'
  | 'step-unreadable'
  | 'step-schema-unsupported'
  | 'step-external-reference'
  | 'step-assembly'
  /**
   * Product manufacturing information (dimensions, tolerances, datums) that this build cannot
   * read. A PMI-1 build reads it and refuses with `step-pmi-partial` instead.
   */
  | 'step-pmi'
  /**
   * PMI-1: the file has PMI that the import would not keep. The result carries the PMI report;
   * the same file is imported when the user agrees (`pmi: 'discard'`).
   */
  | 'step-pmi-partial'
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
  | { status: 'ok'; report: CadStepImportReport; brep: Uint8Array; pmi?: Uint8Array }
  | {
      status: 'rejected';
      code: CadStepImportCode;
      /** What the refusal is about, e.g. the schema name, unit or tolerance found. */
      detail?: string;
      /** `step-pmi-partial`: what the file's PMI holds and what of it was read. */
      pmi?: CadStepPmiReport;
    };

export class Rejected extends Error {
  constructor(
    readonly code: CadStepImportCode,
    readonly detail?: string,
    readonly pmi?: CadStepPmiReport,
  ) {
    super(code);
  }
}
const reject = (code: CadStepImportCode, detail?: string): never => {
  throw new Rejected(code, detail);
};

/**
 * The products of an XDE document by label entry, each holding `bodies` (a single part: the
 * one body is in whichever product the PMI names).
 */
export function pmiProducts(
  oc: OcModule,
  own: <T>(value: T) => T,
  doc: unknown,
  bodies: PmiProduct['bodies'],
): Map<string, PmiProduct> {
  const products = new Map<string, PmiProduct>();
  const tool = own(
    oc.XCAFDoc_DocumentTool.ShapeTool((doc as { get(): { Main(): unknown } }).get().Main()),
  ).get();
  const labels = own(new oc.TDF_LabelSequence_1());
  tool.GetShapes(labels);
  for (let i = 1; i <= labels.Length(); i++) {
    const label = labels.Value(i);
    products.set(own(oc.OCJS.labelEntry(label)).ToCString() as string, {
      shape: own(oc.XCAFDoc_ShapeTool.GetShape_2(label)),
      bodies,
    });
  }
  return products;
}

/** A file with PMI needs a build that reads it: an earlier build refuses with `step-pmi`. */
export function pmiReadable(oc: OcModule, scan: { pmi?: CadPmiCensus }): boolean {
  if (!scan.pmi) return false;
  if (!canReadPmi(oc)) reject('step-pmi', Object.keys(scan.pmi).join(',') || 'other');
  return true;
}

/** The `pmi` asset of one body, as stored. */
export interface CadStepPmiAsset {
  sha256: string;
  byteLength: number;
  bytes: Uint8Array;
}

/**
 * PMI-2: the file's PMI after the XDE read of `doc` (GD&T and view mode), the same document
 * the bodies come from. Compares it with the file's text, keeps the verified items on the
 * bodies (`keepPmi`) and refuses with `step-pmi-partial` unless nothing is lost or the user
 * agreed to the loss (`pmi: 'discard'`). Returns the report and each body's asset.
 */
export function pmiKept(
  oc: OcModule,
  own: <T>(value: T) => T,
  scan: {
    pmi?: CadPmiCensus;
    pmiSemantics?: CadPmiSemantics;
    pmiPresentation?: PmiFilePresentation;
  },
  doc: unknown,
  products: Map<string, PmiProduct>,
  options: CadStepImportOptions,
  /** PMI-5a: adds what an assembly keeps through its paths, before the loss is judged. */
  extend: (report: CadStepPmiReport) => CadStepPmiReport = (r) => r,
): { report: CadStepPmiReport; assets: Map<number, CadStepPmiAsset> } | undefined {
  const census = scan.pmi;
  if (!census) return undefined;
  const json = pmiJsonOf(oc, own, doc);
  const semantics = scan.pmiSemantics ?? noSemantics;
  const compared = comparePmi(census, json, semantics, scan.pmiPresentation);
  const verified = verifiedPmi(json, semantics);
  const linked = scan.pmiPresentation ? linkedCallouts(scan.pmiPresentation, verified) : [];
  // The lines of the kept items are bounded as one asset's (cadPmiLimits.vertices) before they
  // are copied to each item: past that no asset could hold them (`pmiAssetFiles` refuses).
  if (presentedVertices(linked) > cadPmiLimits.vertices) reject('step-too-large', 'pmi');
  // An item or a callout in more saved views than one asset holds: refused before the
  // memberships are copied (no asset could hold them).
  const memberships = scan.pmiPresentation
    ? viewsOfItems(scan.pmiPresentation, linked, verified)
    : new Map<PmiItemJson, CadItemViews>();
  const viewsOf = memberships === 'too-many' ? reject('step-too-large', 'pmi') : memberships;
  const kept = keepPmi(
    oc,
    own,
    verified,
    products,
    new Map(json.datums.map((d) => [d.label, d])),
    presentationOfItems(linked),
    viewsOf,
  );
  // A callout is kept when an item it presents is, a relationship between two when both are
  // (the census counts both as callouts).
  const shown = new Set(
    linked.filter((l) => l.items.some((i) => kept.keptItems.has(i))).map((l) => l.callout.id),
  );
  const related = (scan.pmiPresentation?.relationships ?? []).filter(
    ([a, b]) => shown.has(a) && shown.has(b),
  );
  const callout = shown.size + related.length;
  const onParts: CadStepPmiReport = {
    ...compared,
    kept: { ...kept.kept, callout, view: kept.keptViews.size },
  };
  onParts.lossless = pmiLossless(onParts);
  const report = extend(onParts);
  if (!report.lossless && options.pmi !== 'discard')
    throw new Rejected('step-pmi-partial', report.complete ? 'not-kept' : 'unread', report);
  return { report, assets: pmiAssetFiles(kept.assets) };
}

/**
 * Each body's `pmi` asset as bytes. An asset over the limits (docs/cad/pmi.md) is refused as
 * `step-too-large` (`pmi`): an import never writes an asset its evaluation refuses.
 */
export function pmiAssetFiles(kept: Map<number, CadPmiAsset>): Map<number, CadStepPmiAsset> {
  const assets = new Map<number, CadStepPmiAsset>();
  for (const [body, asset] of kept) {
    if (
      asset.items.length > cadPmiLimits.items ||
      asset.items.some(
        (i) =>
          i.targets.length > cadPmiLimits.targets ||
          (i.kind === 'dimension' && (i.targets2?.length ?? 0) > cadPmiLimits.targets),
      ) ||
      (asset.views?.length ?? 0) > cadPmiLimits.views ||
      asset.items.reduce((n, i) => n + (i.presentation?.segments.length ?? 0) / 3, 0) >
        cadPmiLimits.vertices
    )
      reject('step-too-large', 'pmi');
    const bytes = new TextEncoder().encode(JSON.stringify(asset));
    if (bytes.byteLength > cadPmiLimits.bytes) reject('step-too-large', 'pmi');
    assets.set(body, {
      sha256: `sha256:${bytesToHex(sha256(bytes))}`,
      byteLength: bytes.byteLength,
      bytes,
    });
  }
  return assets;
}

/** Entities that point outside the file. The geometry subset never needs them. */
const externalEntities = [
  'DOCUMENT_FILE',
  'EXTERNAL_SOURCE',
  'EXTERNALLY_DEFINED_ITEM',
  'APPLIED_DOCUMENT_REFERENCE',
  'DOCUMENT_REPRESENTATION_TYPE',
];
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
  /** R2b-5: an assembly's usages are read. */
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
  /**
   * PMI-1: the file's PMI by family, undefined without PMI. The caller reads it with the kernel
   * (`pmiGate`); PMI is refused (ST-29 #2) or lost with consent, never dropped silently.
   */
  pmi?: CadPmiCensus;
  /** PMI-U1: the meaning of the file's PMI items, compared with what the kernel reads. */
  pmiSemantics?: CadPmiSemantics;
  /** PMI-3: the presentation and saved views of the file's PMI, in mm. */
  pmiPresentation?: PmiFilePresentation;
  /** PMI-5a: an assembly's PMI through assembly paths (`{assembly: true}` only). */
  pmiPath?: PmiPath;
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
  // #811: AP242 is read as one part too; an assembly is named `step-assembly` below.
  const schema = /^CONFIG_CONTROL_DESIGN$|^AP203_CONFIGURATION_CONTROLLED_3D_DESIGN/.test(name)
    ? 'AP203'
    : /^AUTOMOTIVE_DESIGN(_CC2)?$/.test(name)
      ? 'AP214'
      : /^AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/.test(name)
        ? 'AP242'
        : reject('step-schema-unsupported', fileSchema);
  const external = externalEntities.find((t) => types.has(t));
  if (external) reject('step-external-reference', external);
  if (!options.assembly && assembly) reject('step-assembly', 'NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  const pmi = pmiCensus(file);
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
  if (pmi) losses.push('pmi');
  const sourceUnit = lengthUnit(file);
  const pmiText = pmi ? readPmiText(file) : undefined;
  return {
    schema,
    fileSchema,
    sourceUnit,
    losses,
    products,
    usages,
    ...(pmi
      ? {
          pmi,
          pmiSemantics: pmiText!.semantics,
          // PMI-5a: an assembly's items through paths, which the kernel's reader does not read.
          ...(options.assembly && { pmiPath: pmiPathOf(file, pmiText!.texts) }),
          pmiPresentation: pmiPresentation(file, cadLengthUnits[sourceUnit]),
        }
      : {}),
  };
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
/** The SI metre of a unit's partial entities, as a CAD length unit (`?SI` when not one). */
function siLengthUnit(parts: { type: string; args: P21Value[] }[]): string {
  const [prefix, unit] = parts.find((p) => p.type === 'SI_UNIT')?.args ?? [];
  const key = prefix?.t === 'enum' ? prefix.v : prefix?.t === 'unset' ? '$' : undefined;
  return (unit?.t === 'enum' && unit.v === 'METRE' && key && siLength[key]) || '?SI';
}
/**
 * A conversion-based length unit by what it converts to (#810): `conversion_factor` is a
 * `LENGTH_MEASURE_WITH_UNIT` of an SI metre, and the product of the two must be one of the CAD
 * length units. CAx writers name 1 mm `MILLIMETRE` this way. A factor that cannot be read (no
 * measure, a non-number, a unit that is not an SI metre) falls back to the name (`INCH`,
 * `FOOT`); a factor that is read and matches no unit is unknown.
 */
function conversionUnit(file: P21File, converted: { args: P21Value[] }, name: string): string {
  const byName = namedLength[name] ?? `?${name}`;
  const factor = converted.args[1];
  const measure = factor?.t === 'ref' ? file.entities.get(factor.id) : undefined;
  // A simple `LENGTH_MEASURE_WITH_UNIT(v,#u)`, or a complex instance whose inherited
  // attributes sit in its `MEASURE_WITH_UNIT` partial entity.
  const withUnit = (measure ? partsOf(measure) : []).find(
    (p) =>
      (p.type === 'LENGTH_MEASURE_WITH_UNIT' || p.type === 'MEASURE_WITH_UNIT') &&
      p.args.length >= 2,
  );
  const [component, ref] = withUnit?.args ?? [];
  const value = component?.t === 'typed' ? component.v : component;
  const target = ref?.t === 'ref' ? file.entities.get(ref.id) : undefined;
  const base = target ? siLengthUnit(partsOf(target)) : '?SI';
  // A factor that cannot be read is named as before; one that is read decides.
  if ((value?.t !== 'real' && value?.t !== 'int') || base.startsWith('?')) return byName;
  const mm = value.v * cadLengthUnits[base as CadLengthUnit];
  const match = (Object.keys(cadLengthUnits) as CadLengthUnit[]).find(
    (u) => Math.abs(mm / cadLengthUnits[u] - 1) < 1e-9,
  );
  return match ?? `?${name}`;
}
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
          units.add(
            conversionUnit(file, converted, n?.t === 'str' ? n.v.trim().toUpperCase() : ''),
          );
        } else units.add(siLengthUnit(parts));
      }
    }
  const [unit] = units;
  if (units.size !== 1 || unit.startsWith('?'))
    reject('step-unit-unknown', [...units].map((u) => u.replace(/^\?/, '')).join(',') || 'none');
  return unit as CadLengthUnit;
}

export const stepImportPaths = Object.freeze({ step: '/i.step', brep: '/i.brep' });

/**
 * The largest tolerance of the BRep written at `path`, as the evaluator reads it back. The
 * writer rounds each tolerance to 15 significant digits, sometimes up: the tolerance measured
 * before writing can be just below the one the part is evaluated with, so the recorded
 * `maxToleranceMm` is taken from the file (#802, JAMA bracket and C-pillar parts).
 */
export function writtenTolerance(oc: OcModule, own: <T>(value: T) => T, path: string): number {
  const shape = own(new oc.TopoDS_Shape());
  if (
    !oc.BRepTools.Read_2(
      shape,
      path,
      own(new oc.BRep_Builder()),
      own(new oc.Message_ProgressRange_1()),
    )
  )
    reject('kernel-failure', 'brep-read');
  return own(new oc.ShapeAnalysis_ShapeTolerance()).Tolerance(
    shape,
    1,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
}

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
  options: CadStepImportOptions = {},
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
    // PMI-2: a file with PMI is read once with the XDE reader in GD&T and view mode, so the
    // PMI's targets are sub-shapes of the same shape; the shape is the reader's as before.
    const withPmi = pmiReadable(oc, scan);
    let doc: unknown;
    let shape: unknown;
    if (withPmi) {
      const xde = own(new oc.STEPCAFControl_Reader_1());
      xde.SetGDTMode(true);
      xde.SetViewMode(true);
      if (xde.ReadFile(stepPath) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
        reject('step-unreadable', 'read');
      const text = own(new oc.TCollection_ExtendedString_2('MDTV-XCAF', false));
      doc = own(new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(text)));
      if (!xde.Transfer_1(doc, own(new oc.Message_ProgressRange_1())))
        reject('step-unreadable', 'transfer');
      shape = own(own(xde.ChangeReader()).OneShape());
    } else {
      const reader = own(new oc.STEPControl_Reader_1());
      if (reader.ReadFile(stepPath) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
        reject('step-unreadable', 'read');
      reader.TransferRoots(own(new oc.Message_ProgressRange_1()));
      shape = own(reader.OneShape());
    }
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
    const measuredToleranceMm = own(new oc.ShapeAnalysis_ShapeTolerance()).Tolerance(
      solid,
      1,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    // #820: the shape is kept with the tolerance it was read with, up to the import limit (no
    // healing). Above the document's result limit its body is placed, never machined.
    if (!(measuredToleranceMm <= cadImportToleranceMm))
      reject('step-tolerance-unsupported', String(measuredToleranceMm));
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
    // Recorded as written, so the evaluator's check on the read-back body holds.
    const maxToleranceMm = Math.max(measuredToleranceMm, writtenTolerance(oc, own, brepPath));
    if (!(maxToleranceMm <= cadImportToleranceMm))
      reject('step-tolerance-unsupported', String(maxToleranceMm));
    // Every product of the file holds the one body (a single part has one product).
    const pmi = withPmi
      ? pmiKept(
          oc,
          own,
          scan,
          doc,
          pmiProducts(oc, own, doc, [{ index: 0, shape: solid }]),
          options,
        )
      : undefined;
    const pmiAsset = pmi?.assets.get(0);
    return {
      status: 'ok',
      brep,
      ...(pmiAsset ? { pmi: pmiAsset.bytes } : {}),
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
        // PMI-2: PMI is a loss unless all of it is kept.
        losses: pmi?.report.lossless ? scan.losses.filter((l) => l !== 'pmi') : scan.losses,
        ...(pmi ? { pmi: pmi.report } : {}),
        ...(pmiAsset
          ? { pmiAsset: { sha256: pmiAsset.sha256, byteLength: pmiAsset.byteLength } }
          : {}),
      },
    };
  } catch (error) {
    if (error instanceof Rejected)
      return {
        status: 'rejected',
        code: error.code,
        ...(error.detail ? { detail: error.detail } : {}),
        ...(error.pmi ? { pmi: error.pmi } : {}),
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
