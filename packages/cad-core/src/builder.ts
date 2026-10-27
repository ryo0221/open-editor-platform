/**
 * O1 builder (docs/cad/complex-models.md, CM-8): a pure API that assembles a schema 2 document
 * from named parameters, sketches and bodies. Every step is an ordinary `CadOperation` applied by
 * `applyCadOperation`, so the result passes the same validation as an edit and opens through the
 * native JSON import. IDs come from names; values are numbers (mm, rad, copies) or expression text
 * over the parameters by name (`{Deck height} + 500mm`). Nothing here evaluates geometry.
 */
import { parseExpression, type CadExpression, type CadParameterType } from './expression';
import {
  emptyCad,
  identityQuaternion,
  type Angle,
  type CadAppearance,
  type CadDocument,
  type CadFeature,
  type CadDerivedSection,
  type CadKernelProfile,
  type CadToleranceSet,
  type CadLoftSection,
  type CadPatternLayout,
  type CadCurveLayout,
  type CadSketchPath,
  type CadSketchSection,
  type Count,
  type Length,
  type Position3,
  type Quaternion,
  type Vec3,
} from './model';
import { applyCadOperation, type CadOperation } from './operations';
import { cadId } from './validation';
import type { CadSketch, CadSketchConstraint } from './sketch';

/** mm, or expression text of a length. */
export type CadBuildLength = number | string | Length;
/** rad, or expression text of an angle. */
export type CadBuildAngle = number | string | Angle;
/** A whole number of copies, or expression text. */
export type CadBuildCount = number | string | Count;
export type CadBuildPoint = [CadBuildLength, CadBuildLength, CadBuildLength];
export interface CadBuildPlane {
  origin?: CadBuildPoint;
  orientation?: Quaternion;
}
export type CadBuildLayout =
  | { type: 'linear'; direction: Vec3; count: CadBuildCount; spacing: CadBuildLength }
  | {
      type: 'circular';
      axisOrigin?: CadBuildPoint;
      axisDirection: Vec3;
      count: CadBuildCount;
      angle: CadBuildAngle;
    }
  /** K5a: along the open chain of lines and arcs a sketch draws, from its start (the tool). */
  | { type: 'curve'; path: CadSketchPath; count: CadBuildCount; align?: boolean };
type Placed = { origin?: CadBuildPoint; orientation?: Quaternion };
/** A sketch constraint whose sizes are numbers (mm, rad) or expressions, as elsewhere here. */
export type CadBuildConstraint = CadSketchConstraint extends infer C
  ? C extends { type: 'angle'; value: Angle }
    ? Omit<C, 'value'> & { value: CadBuildAngle }
    : C extends { value: Length }
      ? Omit<C, 'value'> & { value: CadBuildLength }
      : C extends { at: [Length, Length] }
        ? Omit<C, 'at'> & { at: [CadBuildLength, CadBuildLength] }
        : C
  : never;
/** A feature that reads no other feature, before the builder names it. */
export type CadBuildFeature =
  Extract<CadFeature, { inputFeatureIds: [] }> extends infer F
    ? F extends CadFeature
      ? Omit<F, 'id' | 'name'>
      : never
    : never;

/** Sketch plane orientations: u/v along the named axes, normal +Z, −Y and +X. */
export const cadBuildPlanes = Object.freeze({
  XY: [0, 0, 0, 1] as Quaternion,
  XZ: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quaternion,
  YZ: [0.5, 0.5, 0.5, 0.5] as Quaternion,
});

const grey: CadAppearance = { color: '#9aa4b1', opacity: 1 };

/** A step the document refused: its 1-based number, what it built, and the refusal's code. */
export class CadBuildError extends Error {
  constructor(
    readonly step: number,
    readonly what: string,
    readonly code: string,
  ) {
    super(`step ${step} (${what}): ${code}`);
  }
}

export interface CadBuild {
  document: CadDocument;
  /** What was applied to the empty document, in order; replaying them gives `document`. */
  operations: CadOperation[];
}

export function cadBuilder(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>): CadBuilder {
  return new CadBuilder(kernel);
}

export class CadBuilder {
  #doc: CadDocument;
  readonly #operations: CadOperation[] = [];
  readonly #ids = new Set<string>();
  /** Steps applied so far; a named Boolean or pattern is one step of two operations. */
  #steps = 0;
  /** IDs taken by the step being built, given back when it is refused. */
  #taken: string[] = [];

  constructor(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>) {
    this.#doc = emptyCad(kernel);
  }

  /** The document so far (each step is already validated). */
  get document(): CadDocument {
    return this.#doc;
  }

  build(): CadBuild {
    return { document: this.#doc, operations: [...this.#operations] };
  }

  /** A length, angle or count parameter: a value, or expression text over earlier parameters. */
  parameter(name: string, type: CadParameterType, value: number | string): string {
    const id = this.#id(name, 'parameter');
    const parameter =
      typeof value === 'number'
        ? { id, name, type, value }
        : { id, name, type, expression: this.#expression(value, name) };
    this.#apply(`parameter "${name}"`, {
      type: 'insertFeatures',
      parameters: [parameter],
      features: [],
    });
    return id;
  }

  /** K2: the document's named tolerance set (`standard` when the document is made). */
  toleranceSet(set: CadToleranceSet) {
    this.#apply(`tolerance set "${set}"`, { type: 'setToleranceSet', set });
  }

  /** A new value or expression for the parameter named `name`. */
  setParameter(name: string, value: number | string) {
    const parameterId = this.#parameterId(name);
    this.#apply(
      `set "${name}"`,
      typeof value === 'number'
        ? { type: 'setParameter', parameterId, value }
        : { type: 'setParameter', parameterId, expression: this.#expression(value, name) },
    );
  }

  length(v: CadBuildLength): Length {
    if (typeof v === 'number') return { literalMm: v };
    return typeof v === 'string' ? { expression: this.#expression(v, v) } : v;
  }
  angle(v: CadBuildAngle): Angle {
    if (typeof v === 'number') return { literalRad: v };
    return typeof v === 'string' ? { expression: this.#expression(v, v) } : v;
  }
  count(v: CadBuildCount): Count {
    if (typeof v === 'number') return { literal: v };
    return typeof v === 'string' ? { expression: this.#expression(v, v) } : v;
  }
  point(p: CadBuildPoint = [0, 0, 0]): Position3 {
    return [this.length(p[0]), this.length(p[1]), this.length(p[2])];
  }

  /**
   * A sketch: `points` are the `[u, v]` of its point elements, which seed the solver. With
   * `constraints` (sizes as numbers or expressions of parameters) it is solved when inserted and
   * again whenever a parameter it reads changes; without them its points stay where they are.
   * Entity and constraint IDs are the sketch's own.
   */
  sketch(
    name: string,
    plane: CadBuildPlane,
    points: Record<string, [number, number]>,
    entities: Exclude<CadSketch['entities'][number], { type: 'point' }>[],
    options: { constraints?: CadBuildConstraint[]; solved?: Record<string, [number, number]> } = {},
  ): string {
    const id = this.#id(name, 'sketch');
    const sketch: CadSketch = {
      id,
      name,
      plane: {
        origin: this.point(plane.origin),
        orientation: plane.orientation ?? identityQuaternion(),
      },
      entities: [
        ...Object.keys(points).map((p) => ({ type: 'point' as const, id: p })),
        ...entities,
      ],
      constraints: (options.constraints ?? []).map((c) => this.#constraint(c)),
      solved: { ...points, ...options.solved },
    };
    this.#apply(`sketch "${name}"`, { type: 'insertFeatures', sketches: [sketch], features: [] });
    return id;
  }
  #constraint(c: CadBuildConstraint): CadSketchConstraint {
    if (c.type === 'angle') return { ...c, value: this.angle(c.value) };
    if (c.type === 'fix') return { ...c, at: [this.length(c.at[0]), this.length(c.at[1])] };
    if ('value' in c) return { ...c, value: this.length(c.value) } as CadSketchConstraint;
    return c;
  }
  /** A closed polygon sketch through `points`; its region is the whole loop. */
  polygon(name: string, plane: CadBuildPlane, points: [number, number][]): CadSketchSection {
    const p = Object.fromEntries(points.map((q, i) => [`p${i}`, q] as const));
    const lines = points.map((_, i) => ({
      type: 'line' as const,
      id: `l${i}`,
      start: `p${i}`,
      end: `p${(i + 1) % points.length}`,
    }));
    const sketchId = this.sketch(name, plane, p, lines);
    return { sketchId, region: { outer: lines.map((l) => l.id), holes: [] } };
  }
  /** A closed cubic spline sketch on the control points `poles`; its region is the spline. */
  closedSpline(name: string, plane: CadBuildPlane, poles: [number, number][]): CadSketchSection {
    const p = Object.fromEntries(poles.map((q, i) => [`p${i}`, q] as const));
    const sketchId = this.sketch(name, plane, p, [
      { type: 'spline', id: 's', poles: Object.keys(p), degree: 3, closed: true },
    ]);
    return { sketchId, region: { outer: ['s'], holes: [] } };
  }

  box(name: string, a: Placed & { size: CadBuildPoint }, appearance?: Partial<CadAppearance>) {
    return this.body(
      name,
      {
        type: 'box',
        inputFeatureIds: [],
        args: { size: this.point(a.size), ...this.#placed(a) },
      },
      appearance,
    );
  }
  /** Base centre at `origin`, axis +Z turned by `orientation`. */
  cylinder(
    name: string,
    a: Placed & { radius: CadBuildLength; height: CadBuildLength },
    appearance?: Partial<CadAppearance>,
  ) {
    return this.body(
      name,
      {
        type: 'cylinder',
        inputFeatureIds: [],
        args: { radius: this.length(a.radius), height: this.length(a.height), ...this.#placed(a) },
      },
      appearance,
    );
  }
  sphere(
    name: string,
    a: Placed & { radius: CadBuildLength },
    appearance?: Partial<CadAppearance>,
  ) {
    return this.body(
      name,
      {
        type: 'sphere',
        inputFeatureIds: [],
        args: { radius: this.length(a.radius), ...this.#placed(a) },
      },
      appearance,
    );
  }
  extrude(
    name: string,
    section: CadSketchSection,
    distance: CadBuildLength,
    appearance?: Partial<CadAppearance>,
    direction: 1 | -1 = 1,
  ) {
    return this.body(
      name,
      {
        type: 'extrude',
        inputFeatureIds: [],
        args: { ...section, distance: this.length(distance), direction },
      },
      appearance,
    );
  }
  /** About the axis through `axisOrigin` (plane u/v) along the unit u/v `axisDirection`. */
  revolve(
    name: string,
    section: CadSketchSection,
    a: {
      axisOrigin?: [CadBuildLength, CadBuildLength];
      axisDirection: [number, number];
      angle?: CadBuildAngle;
    },
    appearance?: Partial<CadAppearance>,
  ) {
    const [u, v] = a.axisOrigin ?? [0, 0];
    return this.body(
      name,
      {
        type: 'revolve',
        inputFeatureIds: [],
        args: {
          ...section,
          axisOrigin: [this.length(u), this.length(v)],
          axisDirection: a.axisDirection,
          angle: this.angle(a.angle ?? 2 * Math.PI),
        },
      },
      appearance,
    );
  }
  loft(
    name: string,
    sections: CadLoftSection[],
    ruled: boolean,
    appearance?: Partial<CadAppearance>,
  ) {
    return this.body(
      name,
      { type: 'loft', inputFeatureIds: [], args: { sections, ruled } },
      appearance,
    );
  }

  /**
   * K6: a loft section derived from section `from` (a sketch section of the same loft): scaled
   * by `scale` and turned by `angle` about its sketch's origin, then moved by `offset` (u, v, then
   * along the sketch's normal). Values or expression text.
   */
  derived(
    from: number,
    a: { offset: CadBuildPoint; scale?: number | string; angle?: CadBuildAngle },
  ): CadDerivedSection {
    const scale = a.scale ?? 1;
    return {
      derivedFrom: from,
      offset: this.point(a.offset),
      scale:
        typeof scale === 'number'
          ? { literal: scale }
          : { expression: this.#expression(scale, scale) },
      angle: this.angle(a.angle ?? 0),
    };
  }

  /** A new body named `name` from one feature that reads no other feature. */
  body(name: string, feature: CadBuildFeature, appearance: Partial<CadAppearance> = {}): string {
    const id = this.#id(name, 'body');
    const featureId = this.#id(`${id}-${feature.type}`, 'feature');
    this.#apply(`body "${name}"`, {
      type: 'insertFeatures',
      features: [{ ...feature, id: featureId, name } as CadFeature],
      bodies: [
        {
          id,
          name,
          sourceFeatureId: featureId,
          placementFeatureId: this.#id(`${id}-placement`, 'feature'),
          appearance: { ...grey, ...appearance },
        },
      ],
    });
    return id;
  }

  /** One Boolean of `tools` into `target` (body IDs); the tools are consumed. */
  boolean(
    target: string,
    tools: string[],
    mode: 'union' | 'cut' | 'common',
    name?: string,
  ): string {
    const booleanFeatureId = this.#id(name ?? `${target}-${mode}`, 'feature');
    this.#apply(
      `${mode} "${name ?? target}"`,
      {
        type: 'booleanBodies',
        targetId: target,
        toolIds: tools,
        mode,
        booleanFeatureId,
        placementFeatureId: this.#id(`${booleanFeatureId}-placement`, 'feature'),
      },
      ...(name ? [{ type: 'rename' as const, targetId: booleanFeatureId, name }] : []),
    );
    return booleanFeatureId;
  }
  /** Copies of `tool` by `layout`, joined into or cut from `target`; the tool is consumed. */
  pattern(
    target: string,
    tool: string,
    layout: CadBuildLayout,
    mode: 'union' | 'cut',
    name?: string,
  ) {
    const patternFeatureId = this.#id(name ?? `${target}-pattern`, 'feature');
    const resolved: CadPatternLayout | CadCurveLayout =
      layout.type === 'curve'
        ? { ...layout, count: this.count(layout.count), align: layout.align ?? true }
        : layout.type === 'linear'
          ? { ...layout, count: this.count(layout.count), spacing: this.length(layout.spacing) }
          : {
              ...layout,
              axisOrigin: this.point(layout.axisOrigin),
              count: this.count(layout.count),
              angle: this.angle(layout.angle),
            };
    this.#apply(
      `pattern "${name ?? target}"`,
      {
        type: 'patternBodies',
        targetId: target,
        toolId: tool,
        mode,
        layout: resolved,
        patternFeatureId,
        placementFeatureId: this.#id(`${patternFeatureId}-placement`, 'feature'),
      },
      ...(name ? [{ type: 'rename' as const, targetId: patternFeatureId, name }] : []),
    );
    return patternFeatureId;
  }
  /** The body joined with its mirror image in the plane through `origin` normal to `normal`. */
  mirror(body: string, plane: { origin?: CadBuildPoint; normal: Vec3 }, name = 'Mirror'): string {
    const result = this.#doc.bodies.find((b) => b.id === body)?.resultFeatureId;
    if (!result) throw this.#refuse(`mirror "${name}"`, 'body-unknown');
    const id = this.#id(`${body}-mirror`, 'feature');
    this.#apply(`mirror "${name}"`, {
      type: 'detailBody',
      bodyId: body,
      placementFeatureId: this.#id(`${id}-placement`, 'feature'),
      feature: {
        id,
        name,
        type: 'mirror',
        inputFeatureIds: [result],
        args: { plane: { origin: this.point(plane.origin), normal: plane.normal }, union: true },
      },
    });
    return id;
  }

  #placed(a: Placed) {
    return { origin: this.point(a.origin), orientation: a.orientation ?? identityQuaternion() };
  }
  /**
   * Applies one step's operations together: all of them, or none (the IDs it took are given
   * back). Each is copied first, so a caller's later change to its input changes neither.
   */
  #apply(what: string, ...ops: CadOperation[]) {
    const copies = ops.map((op) => structuredClone(op));
    let doc = this.#doc;
    try {
      for (const op of copies) doc = applyCadOperation(doc, op);
    } catch (e) {
      throw this.#refuse(what, (e as Error).message);
    }
    this.#doc = doc;
    this.#operations.push(...copies);
    this.#steps += 1;
    this.#taken = [];
  }
  #refuse(what: string, code: string) {
    for (const id of this.#taken) this.#ids.delete(id);
    this.#taken = [];
    return new CadBuildError(this.#steps + 1, what, code);
  }
  #parameterId(name: string): string {
    const hits = this.#doc.parameters.filter((p) => p.name === name);
    if (hits.length !== 1)
      throw this.#refuse(
        `parameter "${name}"`,
        hits.length ? 'expression-name-ambiguous' : 'expression-name-unknown',
      );
    return hits[0]!.id;
  }
  #expression(text: string, what: string): CadExpression {
    const parsed = parseExpression(text, (name) => {
      const hits = this.#doc.parameters.filter((p) => p.name === name);
      return hits.length === 1 ? hits[0]!.id : hits.length ? null : undefined;
    });
    if ('error' in parsed)
      throw this.#refuse(`expression "${what}"`, `${parsed.error.code}@${parsed.error.at}`);
    return parsed.expression;
  }
  /** A stable ID from a name: lower case words joined by `-`, numbered when taken. */
  #id(name: string, fallback: string): string {
    const base =
      name
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || fallback;
    let id = base;
    // A name such as `Prototype` gives a reserved key, which is never an ID: numbered instead.
    for (let n = 2; this.#ids.has(id) || !cadId(id); n++) id = `${base}-${n}`;
    this.#ids.add(id);
    this.#taken.push(id);
    return id;
  }
}
