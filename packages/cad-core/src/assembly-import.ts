/**
 * R2b-5 (docs/cad/r2b-assembly.md, STEP AP242 取り込み, R2b-U7): a STEP assembly read by the
 * kernel becomes imported parts and fixed components of one empty document. Each distinct
 * shape (one solid or sheet of a product) is a history-less part document kept in the retained
 * closure like a saved version; every instance, flattened from the file's tree, is a direct
 * component with its placement. Pure: the kernel reads the file, the Surface stores the bytes.
 */
import {
  cadAssemblyLimits,
  type CadComponent,
  type CadPartDef,
  type CadSolvedPose,
} from './assembly';
import {
  cadLimits,
  emptyCad,
  position,
  type CadAssetRef,
  type CadBodyKind,
  type CadDocument,
  type CadKernelProfile,
  type CadLengthUnit,
  type Vec3,
} from './model';
import { applyCadOperation, cadContentHash } from './operations';

/**
 * Import limits (上限): every flattened instance becomes a direct component; the file's tree is
 * read to the nesting an assembly may have (the root's own instances are depth 1).
 */
export const cadStepImportLimits = Object.freeze({
  components: cadAssemblyLimits.components,
  depth: cadAssemblyLimits.depth,
});

/** A product as the file named it. */
export interface CadStepProductName {
  id: string;
  name: string;
  description: string;
}
/** What the kernel read from a STEP assembly (`importStepAssembly`), before anything is stored. */
export interface CadStepAssemblyRead {
  /** Each distinct shape once: a product's solids (or sheets) in file order. */
  shapes: {
    /** The product's name, `name (n)` when the product held more than one. */
    name: string;
    product: CadStepProductName;
    kind: CadBodyKind;
    /** The normalized BRep's `sha256:<hex>` and size. */
    brep: { sha256: string; byteLength: number };
    boundsMm: [Vec3, Vec3];
  }[];
  /** Every instance, flattened: its shape, its path of names in the file and its pose. */
  instances: { shape: number; path: string[]; pose: CadSolvedPose }[];
  /** Products with no solid or sheet, left out. */
  skipped: string[];
}

/**
 * A STEP name as a document name: control characters as spaces, within the name limit with
 * `suffix` (a split shape's ` (n)`) kept whole at its end.
 */
export const stepName = (value: string, fallback: string, suffix = '') =>
  [...(value.replace(/\p{Cc}/gu, ' ').trim() || fallback)]
    .slice(0, cadLimits.nameCodePoints - [...suffix].length)
    .join('')
    .trimEnd() + suffix;

/**
 * An imported shape as a part document: one imported feature and its body, the source STEP and
 * the shape's BRep as its assets, the product's id and description as its part properties.
 * Fixed IDs, so one shape is always one content hash.
 */
export function importedPartDocument(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>,
  shape: CadStepAssemblyRead['shapes'][number],
  assets: { source: CadAssetRef; brep: CadAssetRef },
  conversion: { sourceUnit: CadLengthUnit; scaleToMm: number },
): CadDocument {
  const name = stepName(shape.name, 'STEP');
  const source = { ...assets.source, id: 'source' };
  const brep = { ...assets.brep, id: 'brep' };
  let doc = applyCadOperation(emptyCad(kernel), {
    type: 'insertImportedBody',
    assets: [source, brep],
    feature: {
      id: 'imported',
      name,
      type: 'imported',
      inputFeatureIds: [],
      args: {
        kind: shape.kind,
        sourceAssetId: source.id,
        brepAssetId: brep.id,
        importer: { id: kernel.id, buildHash: kernel.buildHash },
        sourceUnit: conversion.sourceUnit,
        scaleToMm: conversion.scaleToMm,
      },
    },
    body: {
      id: 'body',
      name,
      sourceFeatureId: 'imported',
      placementFeatureId: 'placement',
      appearance: { color: '#8aa1b8', opacity: 1 },
    },
  });
  doc = applyCadOperation(doc, {
    type: 'setPartProperties',
    partNumber: stepName(shape.product.id, ''),
    description: stepName(shape.product.description, ''),
  });
  return doc;
}

export type CadStepImportPlan =
  | {
      status: 'ok';
      /** The part documents, by shape, for the retained closure. */
      versions: CadDocument[];
      parts: CadPartDef[];
      components: CadComponent[];
    }
  | { status: 'refused'; code: 'step-instance-limit' | 'step-assembly-empty' };

/**
 * The edit that places `read` in an empty document: one imported part per shape and one fixed
 * component per instance, named by its path in the file. `brepRefs[i]` is shape i's BRep asset.
 */
export function stepImportPlan(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>,
  read: CadStepAssemblyRead,
  assets: { source: CadAssetRef; breps: CadAssetRef[] },
  conversion: { sourceUnit: CadLengthUnit; scaleToMm: number },
  newId: (prefix: string) => string,
): CadStepImportPlan {
  if (!read.instances.length) return { status: 'refused', code: 'step-assembly-empty' };
  if (read.instances.length > cadStepImportLimits.components)
    return { status: 'refused', code: 'step-instance-limit' };
  // Shapes whose documents are identical (same product, name and BRep) are one part.
  const versions: CadDocument[] = [];
  const parts: CadPartDef[] = [];
  const byHash = new Map<string, CadPartDef>();
  const partOf = read.shapes.map((shape, i) => {
    const doc = importedPartDocument(
      kernel,
      shape,
      { source: assets.source, brep: assets.breps[i]! },
      conversion,
    );
    const contentHash = cadContentHash(doc);
    const known = byHash.get(contentHash);
    if (known) return known;
    const part: CadPartDef = {
      id: newId('part'),
      name: stepName(shape.name, 'STEP'),
      source: {
        kind: 'imported',
        contentHash,
        sourceAssetId: 'source',
        brepAssetId: 'brep',
        stepProduct: {
          id: stepName(shape.product.id, ''),
          name: stepName(shape.product.name, ''),
          description: stepName(shape.product.description, ''),
        },
      },
      hint: { boundsMm: shape.boundsMm },
    };
    byHash.set(contentHash, part);
    versions.push(doc);
    parts.push(part);
    return part;
  });
  const components: CadComponent[] = read.instances.map((instance) => {
    const part = partOf[instance.shape]!;
    const { translationMm: t, rotation } = instance.pose;
    return {
      id: newId('component'),
      // Nested assemblies are flattened: the path in the file stays in the name.
      name: stepName(instance.path.join(' / '), part.name),
      partId: part.id,
      placement: { translation: position(t[0], t[1], t[2]), rotation },
      bom: 'include',
    };
  });
  return { status: 'ok', versions, parts, components };
}
