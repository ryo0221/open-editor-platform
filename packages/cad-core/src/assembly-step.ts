/**
 * R2b-5 (docs/cad/r2b-assembly.md, STEP AP242): the product structure an assembly is written
 * as. One product per reached version (its shape once), one instance per component and pattern
 * copy with its pose in the owning document; sub-assemblies stay nested. Pure: the kernel writes
 * the file from this plan and each version's exact shapes.
 */
import {
  cadAssemblyLimits,
  expandAssembly,
  parseCopyStep,
  type CadPartLookup,
  type CadSolvedPose,
} from './assembly';
import type { CadBodyKind, CadDocument } from './model';

/** STEP export limits (上限): products and nesting; instances follow `cadAssemblyLimits`. */
export const cadStepAssemblyLimits = Object.freeze({ products: 512, depth: 8 });

export interface CadStepInstance {
  /** The product placed. */
  product: string;
  /** The component's name (a copy's: its pattern's name and number). */
  name: string;
  /** Pose in the owning product's frame. */
  pose: CadSolvedPose;
}
export interface CadStepProduct {
  /** `root`, a version's content hash, or `<key> bodies` for an assembly's own bodies. */
  key: string;
  name: string;
  /** The part number, else the part definition's ID (the document's for the root). */
  id: string;
  /**
   * The version whose active bodies are this product's shape (a BRep compound, in body order),
   * with each body's kind and colour. Absent for a product that only places others.
   */
  shape?: { contentHash: string; bodies: { kind: CadBodyKind; color: string }[] };
  instances: CadStepInstance[];
}
export interface CadStepPlan {
  /** Placed before placing: a product's instances name products earlier in the list. */
  products: CadStepProduct[];
  root: string;
  /** Instances written, nested ones counted once per product. */
  instances: number;
}
export type CadStepPlanResult =
  | { status: 'ok'; plan: CadStepPlan }
  | { status: 'refused'; code: 'step-product-limit' | 'step-part-missing' | 'limit-instances' };

const identity: CadSolvedPose = { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] };
const bodiesOf = (doc: CadDocument) =>
  doc.bodies
    .filter((b) => b.state === 'active')
    .map((b) => ({ kind: b.kind, color: b.appearance.color }));

/**
 * The products and instances of `doc` (its own bodies, its components and their copies) and of
 * every version it reaches. `name` and `contentHash` are the root document's.
 */
export function assemblyStepPlan(
  doc: CadDocument,
  contentHash: string,
  lookup: CadPartLookup,
  name: string,
): CadStepPlanResult {
  const reached = expandAssembly(doc, lookup);
  if (reached.limit === 'limit-instances') return { status: 'refused', code: 'limit-instances' };
  if (reached.missing.size || reached.limit)
    return { status: 'refused', code: 'step-part-missing' };
  const products: CadStepProduct[] = [];
  const done = new Set<string>();
  let instances = 0;
  const visit = (key: string, owner: CadDocument, hash: string, label: string, id: string) => {
    if (done.has(key)) return;
    done.add(key);
    const bodies = bodiesOf(owner);
    const shape = bodies.length ? { contentHash: hash, bodies } : undefined;
    if (!owner.components.length) {
      products.push({ key, name: label, id, ...(shape ? { shape } : {}), instances: [] });
      return;
    }
    // An assembly's own bodies are a product of their own, placed where they stand.
    const placed: CadStepInstance[] = [];
    if (shape) {
      const own = `${key} bodies`;
      products.push({
        key: own,
        name: `${label} bodies`,
        id: `${id}-bodies`,
        shape,
        instances: [],
      });
      placed.push({ product: own, name: `${label} bodies`, pose: identity });
    }
    const components = new Map(owner.components.map((c) => [c.id, c]));
    const patterns = new Map(owner.componentPatterns.map((p) => [p.id, p]));
    for (const o of expandAssembly(owner, lookup).occurrences) {
      if (o.path.length !== 1) continue;
      const version = o.part.source.contentHash;
      const content = lookup(version)!;
      visit(version, content, version, o.part.name, content.partProperties.partNumber || o.part.id);
      const step = o.path[0]!;
      const copy = parseCopyStep(step);
      placed.push({
        product: version,
        name: copy
          ? `${patterns.get(copy.patternId)?.name ?? copy.patternId} ${copy.index + 1}`
          : (components.get(step)?.name ?? step),
        pose: o.pose,
      });
    }
    instances += placed.length;
    products.push({ key, name: label, id, instances: placed });
  };
  visit('root', doc, contentHash, name, doc.partProperties.partNumber || 'assembly');
  if (products.length > cadStepAssemblyLimits.products)
    return { status: 'refused', code: 'step-product-limit' };
  if (instances > cadAssemblyLimits.instances)
    return { status: 'refused', code: 'limit-instances' };
  return { status: 'ok', plan: { products, root: 'root', instances } };
}
