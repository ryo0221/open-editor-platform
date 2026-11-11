/**
 * PMI-5a (docs/cad/pmi.md, 組立経路の参照): the PMI items that reach a part's faces through an
 * assembly path (`COMPONENT_PATH_SHAPE_ASPECT`), which OCCT 7.6's XDE reader does not read. The
 * path is read from the text: the chain of `NEXT_ASSEMBLY_USAGE_OCCURRENCE`s from the assembly
 * the aspect is on to the leaf part, and the leaf part's faces, edges or vertices the aspect's
 * `GEOMETRIC_ITEM_SPECIFIC_USAGE` names. The kernel then tells which component and which
 * sub-shape each is (`OCJS.pmiEntityShapes`). Nothing is guessed: a path that does not join
 * up, or names items outside its leaf part, is a problem and the item is not kept.
 */
import type { P21File, P21Instance, P21Value } from '@editor-platform/geometry-core';
import { familyOf, type PmiTextItem } from './step-pmi';

/** One target through a path: the occurrences from the root to the leaf, and the leaf's items. */
export interface PmiPathTarget {
  /** The `COMPONENT_PATH_SHAPE_ASPECT`. */
  path: number;
  /** `NEXT_ASSEMBLY_USAGE_OCCURRENCE` entities, root first. */
  occurrences: number[];
  /** The leaf part's faces, edges or vertices (`identified_item` entities). */
  items: number[];
}
/** Why an item through a path is not kept. */
export type PmiPathProblem =
  /** The occurrences do not join up from the aspect's assembly to one leaf part. */
  | 'path-broken'
  /** An item the aspect names is not in the leaf part's representation. */
  | 'path-outside-leaf'
  /** An end mixes a path with a part's own aspect, so its instance is not known. */
  | 'path-mixed'
  /** An end names no geometry. */
  | 'path-empty'
  /** The kernel did not find exactly one imported instance for the occurrences. */
  | 'path-unplaced'
  /** An item is not exactly one sub-shape of one of the instance's bodies. */
  | 'path-shape'
  /** A value, modifier or type this import cannot keep as it is (a `?` in its reading). */
  | 'path-unreadable'
  /** A tolerance's datum letter names no datum, or more than one, on its instance. */
  | 'path-datum';
/** An item with at least one end through a path. */
export interface PmiPathItem {
  text: PmiTextItem;
  /** Each end's targets: one end for a size, tolerance or datum, two for a location. */
  ends: PmiPathTarget[][];
  problem?: PmiPathProblem;
}

type Part = { type: string; args: P21Value[] };
const partsOf = (e: P21Instance): Part[] => e.parts ?? [e];
const refs = (v: P21Value | undefined): number[] => {
  const value = v?.t === 'typed' ? v.v : v;
  if (value?.t === 'ref') return [value.id];
  if (value?.t === 'list') return value.v.flatMap(refs);
  return [];
};
const append = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/** The path items of `texts` (`readPmiText`), with the entities the kernel resolves. */
export function pmiPathItems(
  file: P21File,
  texts: readonly PmiTextItem[],
): {
  items: PmiPathItem[];
  occurrences: number[];
  shapes: number[];
  /**
   * Datums on a part's own aspects (no path), with their features' items: a path tolerance that
   * references one has it copied onto its instance. Their items are in `shapes`.
   */
  partDatums: { text: Extract<PmiTextItem, { kind: 'datum' }>; items: number[] }[];
} {
  const get = (id: number) => file.entities.get(id);
  const part = (id: number, type: string) => {
    const e = get(id);
    return e && partsOf(e).find((p) => p.type === type);
  };
  // Shape aspects: their own items (`GEOMETRIC_ITEM_SPECIFIC_USAGE`), the aspects a composite is
  // made of (`SHAPE_ASPECT_RELATIONSHIP` to anything but a datum), and the paths.
  const usages = new Map<number, { rep: number | undefined; items: number[] }[]>();
  const members = new Map<number, number[]>();
  const paths = new Map<
    number,
    { shape: number | undefined; location: number[]; aspect: number | undefined }
  >();
  // Representations: the product definition each defines, and the representations related to it.
  const definitionOfShape = new Map<number, number>();
  const shapeOfRep = new Map<number, number>();
  const relatedReps = new Map<number, number[]>();
  const occurrences = new Map<
    number,
    { relating: number | undefined; related: number | undefined }
  >();
  const datums = new Set<number>();
  for (const e of file.entities.values())
    for (const p of partsOf(e)) {
      if (p.type === 'GEOMETRIC_ITEM_SPECIFIC_USAGE' && p.args.length >= 5) {
        const [definition] = refs(p.args[2]);
        if (definition !== undefined)
          append(usages, definition, { rep: refs(p.args[3])[0], items: refs(p.args[4]) });
      } else if (p.type === 'COMPONENT_PATH_SHAPE_ASPECT' && p.args.length >= 6) {
        paths.set(e.id, {
          shape: refs(p.args[2])[0],
          location: refs(p.args[4]),
          aspect: refs(p.args[5])[0],
        });
      } else if (p.type === 'SHAPE_ASPECT_RELATIONSHIP' && p.args.length >= 4) {
        const [relating] = refs(p.args[2]);
        const [related] = refs(p.args[3]);
        if (relating !== undefined && related !== undefined) append(members, relating, related);
      } else if (p.type === 'DATUM' || p.type === 'COMMON_DATUM') datums.add(e.id);
      else if (p.type === 'PRODUCT_DEFINITION_SHAPE' && p.args.length >= 3) {
        const [definition] = refs(p.args[2]);
        if (definition !== undefined) definitionOfShape.set(e.id, definition);
      } else if (p.type === 'SHAPE_DEFINITION_REPRESENTATION' && p.args.length >= 2) {
        const [shape] = refs(p.args[0]);
        const [rep] = refs(p.args[1]);
        if (shape !== undefined && rep !== undefined) shapeOfRep.set(rep, shape);
      } else if (p.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE' && p.args.length >= 5)
        occurrences.set(e.id, { relating: refs(p.args[3])[0], related: refs(p.args[4])[0] });
    }
  // `SHAPE_REPRESENTATION_RELATIONSHIP` is a complex or simple entity of its own type.
  for (const e of file.entities.values())
    for (const p of partsOf(e))
      if (p.type === 'SHAPE_REPRESENTATION_RELATIONSHIP' && p.args.length >= 4) {
        if (e.parts?.some((q) => q.type === 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION'))
          continue;
        const [a] = refs(p.args[2]);
        const [b] = refs(p.args[3]);
        if (a !== undefined && b !== undefined) {
          append(relatedReps, a, b);
          append(relatedReps, b, a);
        }
      }
  /** The product definitions a representation defines (through related representations). */
  const definitionsOfRep = new Map<number, Set<number>>();
  const repDefinitions = (rep: number): Set<number> => {
    const known = definitionsOfRep.get(rep);
    if (known) return known;
    const found = new Set<number>();
    const seen = new Set([rep]);
    const queue = [rep];
    while (queue.length) {
      const r = queue.shift()!;
      const shape = shapeOfRep.get(r);
      const definition = shape !== undefined ? definitionOfShape.get(shape) : undefined;
      if (definition !== undefined) found.add(definition);
      for (const o of relatedReps.get(r) ?? [])
        if (!seen.has(o)) {
          seen.add(o);
          queue.push(o);
        }
    }
    definitionsOfRep.set(rep, found);
    return found;
  };

  const usedOccurrences = new Set<number>();
  const usedShapes = new Set<number>();
  /** One path's target, or its problem. */
  const pathTarget = (id: number): PmiPathTarget | PmiPathProblem => {
    const path = paths.get(id)!;
    const root = path.shape !== undefined ? definitionOfShape.get(path.shape) : undefined;
    // A single occurrence, or a `MULTI_LEVEL_REFERENCE_DESIGNATOR`'s list of them.
    const chain = path.location.flatMap((l) => {
      if (occurrences.has(l)) return [l];
      const designator = part(l, 'MULTI_LEVEL_REFERENCE_DESIGNATOR');
      return designator ? designator.args.flatMap((a) => (a.t === 'list' ? refs(a) : [])) : [l];
    });
    let at = root;
    for (const o of chain) {
      const occurrence = occurrences.get(o);
      if (at === undefined || !occurrence || occurrence.relating !== at) return 'path-broken';
      at = occurrence.related;
    }
    if (!chain.length || at === undefined || path.aspect === undefined) return 'path-broken';
    const own = usages.get(path.aspect) ?? [];
    const items = own.flatMap((u) => u.items);
    if (!items.length) return 'path-empty';
    const leaf = at;
    if (own.some((u) => u.rep === undefined || !repDefinitions(u.rep).has(leaf)))
      return 'path-outside-leaf';
    for (const o of chain) usedOccurrences.add(o);
    for (const i of items) usedShapes.add(i);
    return { path: id, occurrences: chain, items };
  };
  /** An end's targets: its paths, or a part's own aspects (undefined), through composites. */
  const endTargets = (
    aspect: number | undefined,
    depth = 0,
  ): (PmiPathTarget | PmiPathProblem | 'part')[] => {
    if (aspect === undefined || depth > 8) return [];
    if (paths.has(aspect)) return [pathTarget(aspect)];
    const own: ('part' | PmiPathTarget | PmiPathProblem)[] = usages.has(aspect) ? ['part'] : [];
    const parts = (members.get(aspect) ?? [])
      .filter((m) => !datums.has(m))
      .flatMap((m) => endTargets(m, depth + 1));
    return [...own, ...parts];
  };
  // The shapes of assemblies: a product definition some occurrence is in.
  const assemblyDefinitions = new Set([...occurrences.values()].map((o) => o.relating));
  const assemblyShapes = new Set(
    [...definitionOfShape].filter(([, d]) => assemblyDefinitions.has(d)).map(([s]) => s),
  );
  const datumShape = (id: number) => {
    const e = get(id);
    const d =
      e &&
      partsOf(e).find(
        (p) => (p.type === 'DATUM' || p.type === 'COMMON_DATUM') && p.args.length >= 3,
      );
    return d ? refs(d.args[2])[0] : undefined;
  };
  const out: PmiPathItem[] = [];
  const pending: PmiTextItem[] = [];
  for (const text of texts) {
    const aspects =
      text.kind === 'dimension'
        ? text.ends
        : text.kind === 'geometric-tolerance'
          ? [text.aspect]
          : [text.features];
    const ends = aspects.map((a) =>
      Array.isArray(a) ? a.flatMap((f) => endTargets(f)) : endTargets(a),
    );
    // A datum on an assembly's shape stands for the instances its features name: JAMA's datums
    // are there, with features that name no geometry. Kept with the tolerances that use it.
    const onAssembly = text.kind === 'datum' && assemblyShapes.has(datumShape(text.entity) ?? -1);
    if (!onAssembly && !ends.some((end) => end.some((t) => t !== 'part'))) continue;
    const problem =
      (ends.flat().find((t) => typeof t === 'string' && t !== 'part') as
        | PmiPathProblem
        | undefined) ??
      (ends.some((end) => end.includes('part')) ? 'path-mixed' : undefined) ??
      (text.kind !== 'datum' && ends.some((end) => !end.length) ? 'path-empty' : undefined);
    if (onAssembly && problem === 'path-mixed') continue;
    // A datum with no path of its own is kept only for a path tolerance that uses its letter.
    if (onAssembly && !ends.some((end) => end.length)) {
      pending.push(text);
      continue;
    }
    out.push({
      text,
      ends: ends.map((end) => end.filter((t): t is PmiPathTarget => typeof t === 'object')),
      ...(problem && { problem }),
    });
  }
  // The datums the path tolerances reference, by entity (letters repeat across parts).
  const referenced = new Set(
    out.flatMap((i) => (i.text.kind === 'geometric-tolerance' ? i.text.datumEntities.flat() : [])),
  );
  for (const text of pending)
    if (text.kind === 'datum' && referenced.has(text.entity)) out.push({ text, ends: [[]] });
  // A part's datum a path tolerance may reference: its features' own items, through composites.
  const ownItems = (aspect: number, depth = 0): number[] =>
    depth > 8 || paths.has(aspect)
      ? []
      : [
          ...(usages.get(aspect) ?? []).flatMap((u) => u.items),
          ...(members.get(aspect) ?? [])
            .filter((m) => !datums.has(m))
            .flatMap((m) => ownItems(m, depth + 1)),
        ];
  const inPath = new Set(out.map((i) => i.text));
  const partDatums = texts.flatMap((text) => {
    if (text.kind !== 'datum' || inPath.has(text) || !referenced.has(text.entity)) return [];
    const items = text.features.flatMap((f) => ownItems(f));
    for (const i of items) usedShapes.add(i);
    return items.length ? [{ text, items }] : [];
  });
  return { items: out, occurrences: [...usedOccurrences], shapes: [...usedShapes], partDatums };
}

/** `pmiPathItems` with how many of each kept datum's features are datum features (the census). */
export type PmiPath = ReturnType<typeof pmiPathItems> & {
  datumFeatures: Map<number, number>;
  /**
   * The rank of each of `shapes` in the file (1-based, in the order the entities are written),
   * as OCCT's `Interface_InterfaceModel` numbers them: an entity's `#id` need not be its rank.
   */
  ranks: Map<number, number>;
};
export function pmiPathOf(file: P21File, texts: readonly PmiTextItem[]): PmiPath {
  const path = pmiPathItems(file, texts);
  const datumFeatures = new Map<number, number>();
  for (const { text } of path.items)
    if (text.kind === 'datum')
      datumFeatures.set(
        text.entity,
        text.features.filter((f) => {
          const e = file.entities.get(f);
          return !!e && partsOf(e).some((p) => familyOf(p.type) === 'datum-feature');
        }).length,
      );
  const wanted = new Set(path.shapes);
  const ranks = new Map<number, number>();
  let rank = 0;
  for (const id of file.entities.keys()) {
    rank++;
    if (wanted.has(id)) ranks.set(id, rank);
  }
  return { ...path, datumFeatures, ranks };
}
