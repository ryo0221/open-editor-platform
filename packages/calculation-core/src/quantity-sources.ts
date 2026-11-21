import type { SourcePin } from './contracts';

// What a calculation (Estimate) and a geometric source adapter (estimate-engineering) hand each
// other. Office calculations use these types without importing CAD or BIM; the adapters fill
// them without importing the calculation's own model. See docs/kind-registry-design.md.

/** A saved source copied into the calculation, with the keys of the sources it needs. */
export interface RetainedSource {
  key: string;
  pin: SourcePin;
  nativeContent: unknown;
  dependencies: string[];
}

/** Where a source-backed quantity came from; compared verbatim on reload. */
export interface QuantitySourceRef {
  snapshotKey: string;
  identity: string;
  metric: string;
  scope: 'whole';
  coverage: string[];
  extractionBasis: string;
}

/** One quantity read from a retained source. The calculation decides its id, name and use. */
export interface MeasuredQuantity {
  name: string;
  unit: string;
  value: string;
  quality: 'cad' | 'analytic' | 'kernel';
  evidence: string;
  /** The source itself excludes this row (a CAD BOM exclusion). */
  excluded: boolean;
  source: QuantitySourceRef;
}

/** The part of a calculation's quantity that a verifier checks against its source. */
export interface SourceBackedQuantity {
  id: string;
  unit: string;
  value: string | null;
  quality: string;
  source?: QuantitySourceRef;
  inclusion: 'include' | 'exclude' | 'pending';
}

/** Host-supplied checks for retained geometric sources and the quantities read from them. */
export interface QuantityVerification {
  verifySource(source: RetainedSource, sources: RetainedSource[]): Promise<void>;
  verifyQuantities(
    quantities: readonly SourceBackedQuantity[],
    sources: RetainedSource[],
  ): Promise<void>;
}

/** A saved geometric source offered to the calculation, with the saved parts it may need. */
export interface GeometrySourceInput {
  pin: SourcePin;
  content: unknown;
  closure: { contentHash: string; content: unknown }[];
}

/** One countable CAD row (body, part or assembly) with a version-independent identity. */
export interface SourceQuantityRow {
  identity: string;
  name: string;
  kind: 'body' | 'part' | 'assembly';
  count: number;
  path: string[];
  bodyId?: string;
  reference?: { artifactId: string; versionId: string; contentHash: string };
  coverage: string[];
  excluded: boolean;
}

export type BimQuantityMetric = 'length' | 'grossArea' | 'netArea' | 'grossVolume' | 'netVolume';

/** One BIM element a quantity can be read from. */
export interface SourceElement {
  id: string;
  name?: string;
  kind: string;
}

/**
 * Geometric quantity sources a Host gives the calculation. Every method may load the CAD/BIM
 * code on first use, so a Host without engineering simply omits it.
 */
export interface GeometryQuantitySources {
  verification: QuantityVerification;
  retainCad(
    input: GeometrySourceInput,
  ): Promise<{ root: RetainedSource; sources: RetainedSource[] }>;
  cadRows(root: RetainedSource, sources: RetainedSource[]): Promise<SourceQuantityRow[]>;
  measureCad(
    root: RetainedSource,
    sources: RetainedSource[],
    identity: string,
  ): Promise<MeasuredQuantity>;
  /** The elements of a saved BIM, or undefined when the content is not BIM. */
  bimElements(content: unknown): Promise<SourceElement[] | undefined>;
  retainBim(
    input: GeometrySourceInput,
  ): Promise<{ root: RetainedSource; sources: RetainedSource[] }>;
  measureBim(
    root: RetainedSource,
    elementId: string,
    metric: BimQuantityMetric,
    signal?: AbortSignal,
  ): Promise<MeasuredQuantity>;
}
