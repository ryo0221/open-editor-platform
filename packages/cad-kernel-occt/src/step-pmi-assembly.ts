/**
 * PMI-5a (docs/cad/pmi.md, 組立経路の参照): the items a STEP assembly attaches to particular
 * instances (`pmiPathItems`), kept in the assembly document's `assembly-pmi` asset. Each path's
 * occurrences are matched with the usages the import's instances were placed through (the
 * names the import gave XDE's components), and each face, edge or vertex is named by the kernel
 * as a sub-shape of its product (`OCJS.pmiEntityShapes`, by the entity's rank in the file). A
 * target that is not one instance's one sub-shape is not kept, and nothing is moved to a near
 * face or another instance.
 */
import {
  cadPmiLimits,
  type CadPmiAsset,
  type CadPmiDatumReference,
  type CadPmiItem,
  type CadPmiKind,
  type CadPmiTarget,
} from '@editor-platform/cad-core';
import type { OcModule } from '@editor-platform/geometry-kernel-occt';
import {
  pmiDatumModifiers,
  pmiDimensionTypes,
  pmiLossless,
  pmiToleranceModifiers,
  pmiToleranceTypes,
  type CadPmiAxis,
  type CadPmiFamily,
  type CadStepPmiReport,
} from './step-pmi';
import { pmiSubShapes, type PmiProduct } from './step-pmi-keep';
import type { PmiPath, PmiPathItem, PmiPathProblem, PmiPathTarget } from './step-pmi-path';

/** One leaf placement of the import: its components from the root and its instances. */
export interface PmiPlacement {
  /**
   * The `NEXT_ASSEMBLY_USAGE_OCCURRENCE`s from the free shape down to the leaf, as XDE named its
   * components (0 for a component whose usage is not known).
   */
  chain: number[];
  /** The leaf product's label entry. */
  product: string;
  /** The import's instances of this placement: one per body of the product. */
  instances: { shape: number; instance: number }[];
}

/** What the kernel's helper says of one entity. */
type EntityShape =
  | { entity: number; product: string; shape: number; index: number }
  | { entity: number; component: string }
  | { entity: number; matches?: number };

export interface KeptAssemblyPmi {
  /** The asset, with each target's `component` the instance's index; undefined when empty. */
  asset?: CadPmiAsset;
  /** Kept items by kind (a datum copied onto an instance for a tolerance is not counted). */
  kept: Record<CadPmiKind, number>;
  /** Path items found in the file, by kind. */
  found: Record<CadPmiKind, number>;
  /** Path items not kept, by why. */
  problems: Partial<Record<PmiPathProblem, number>>;
  /** `COMPONENT_PATH_SHAPE_ASPECT`s every kept item's targets go through. */
  paths: Set<number>;
  /** The file's datum system entities of the kept tolerances that no other tolerance uses. */
  systems: number[];
  /** The datum features of the kept datums. */
  features: number;
}

const noKinds = (): Record<CadPmiKind, number> => ({
  dimension: 0,
  'geometric-tolerance': 0,
  datum: 0,
  'datum-target': 0,
});
/** An item before its id (distributes over the kinds). */
type NewItem = CadPmiItem extends infer T ? (T extends CadPmiItem ? Omit<T, 'id'> : never) : never;
const qualifiers: Record<string, 'min' | 'max' | 'avg' | undefined> = {
  '': undefined,
  '|q:min': 'min',
  '|q:max': 'max',
  '|q:avg': 'avg',
};

/** A datum system's compartments (`A,B-C(FREE_STATE)`) as letters and modifiers. */
function compartments(text: string): { letters: string[]; modifiers: string[] }[] | undefined {
  if (!text) return [];
  const out: { letters: string[]; modifiers: string[] }[] = [];
  for (const c of text.split(',')) {
    const m = /^([^()]*)(?:\(([^()]*)\))?$/.exec(c);
    if (!m) return undefined;
    const letters = m[1]!.split('-');
    const modifiers = m[2] ? m[2].split('+') : [];
    if (
      letters.some((l) => !l || l === '?') ||
      modifiers.some((x) => !(pmiDatumModifiers as readonly string[]).includes(x))
    )
      return undefined;
    out.push({ letters, modifiers });
  }
  return out;
}

export function keepAssemblyPmi(
  oc: OcModule,
  own: <T>(value: T) => T,
  reader: unknown,
  doc: unknown,
  path: PmiPath,
  placements: PmiPlacement[],
  products: Map<string, PmiProduct>,
  /** The file's datum system entities by tolerance entity (`CadPmiSemantics`). */
  systemsOf: Map<number, number[]>,
  /** How many of a datum's features are datum features (the census's family), by datum. */
  datumFeatures: (datum: number) => number,
): KeptAssemblyPmi {
  const found = noKinds();
  const kept = noKinds();
  const problems: KeptAssemblyPmi['problems'] = {};
  const paths = new Set<number>();
  const systems: number[] = [];
  let features = 0;
  for (const i of path.items) found[i.text.kind]++;
  // A datum system that a tolerance outside the paths also uses is the kernel reader's to count.
  const pathTolerances = new Set(path.items.map((i) => i.text.entity));
  const shared = new Set(
    [...systemsOf].filter(([t]) => !pathTolerances.has(t)).flatMap(([, s]) => s),
  );
  const result = { kept, found, problems, paths, systems, features };
  if (!path.items.length) return result;
  // The kernel's names for the faces, edges and vertices.
  const byRank = new Map([...path.ranks].map(([id, rank]) => [rank, id]));
  const spec = [...path.ranks.values()].join(' ');
  const json = own(
    oc.OCJS.pmiEntityShapes(reader, doc, own(new oc.TCollection_AsciiString_2(spec))),
  ).ToCString() as string;
  const entities = new Map(
    (JSON.parse(json) as EntityShape[]).map((e) => [byRank.get(e.entity) ?? 0, e]),
  );
  const subShapes = pmiSubShapes(oc, own);
  const ends = (chain: number[], suffix: number[]) =>
    chain.length >= suffix.length &&
    suffix.every((s, i) => chain[chain.length - suffix.length + i] === s);

  /** An entity as one sub-shape of one body of a product, or the problem. */
  const onProduct = (entity: number, product: string) => {
    const e = entities.get(entity);
    if (!e || !('product' in e) || e.product !== product) return undefined;
    const p = products.get(product);
    const on = p ? subShapes(p, e.shape, e.index) : new Map<number, CadPmiTarget>();
    return on.size === 1 ? [...on][0]! : undefined;
  };
  /** One path target's sub-shapes on the instances, or the problem. */
  /**
   * A placement's usages without the trailing components XDE adds when it splits one product's
   * representation into sub-shapes (unnamed, no usage of the file): one instance of the file.
   */
  const usagesOf = (p: PmiPlacement) => {
    let n = p.chain.length;
    while (n && p.chain[n - 1] === 0) n--;
    return p.chain.slice(0, n);
  };
  const place = (t: PmiPathTarget): CadPmiTarget[] | PmiPathProblem => {
    // The usages of the placements end with the path's occurrences (a path may start at a
    // sub-assembly), and they are all one instance of the file: its split sub-shapes, if any.
    const at = placements.filter((p) => ends(usagesOf(p), t.occurrences));
    const instance = at[0] && usagesOf(at[0]).join(' ');
    if (!at.length || at.some((p) => usagesOf(p).join(' ') !== instance)) return 'path-unplaced';
    const out: CadPmiTarget[] = [];
    for (const item of t.items) {
      // The sub-shape's product picks the placement; exactly one may hold it.
      const held = at.flatMap((p) => {
        const on = onProduct(item, p.product);
        const i = on && p.instances.find((x) => x.shape === on[0]);
        return on && i ? [{ ...on[1], component: String(i.instance) }] : [];
      });
      if (held.length !== 1) return 'path-shape';
      out.push(held[0]!);
    }
    return out;
  };

  /** Every target of an end, or the first problem. */
  const placeEnd = (end: PmiPathTarget[]): CadPmiTarget[] | PmiPathProblem => {
    const out: CadPmiTarget[] = [];
    for (const t of end) {
      const placed = place(t);
      if (typeof placed === 'string') return placed;
      out.push(...placed);
    }
    return out;
  };

  const items: CadPmiItem[] = [];
  const add = (item: NewItem) => {
    const id = `pmi-${items.length + 1}`;
    items.push({ id, ...item } as CadPmiItem);
    return id;
  };
  const lose = (problem: PmiPathProblem) => (problems[problem] = (problems[problem] ?? 0) + 1);
  const keep = (i: PmiPathItem, targets: CadPmiTarget[][]) => {
    kept[i.text.kind]++;
    for (const end of i.ends) for (const t of end) paths.add(t.path);
    return targets;
  };
  /** Each end's targets, or undefined with the problem counted. */
  const placed = (i: PmiPathItem): CadPmiTarget[][] | undefined => {
    if (i.problem) return void lose(i.problem);
    const out: CadPmiTarget[][] = [];
    for (const end of i.ends) {
      const p = placeEnd(end);
      if (typeof p === 'string') return void lose(p);
      out.push(p);
    }
    return out;
  };

  // Datums first. A tolerance names its datums by entity: letters repeat across parts.
  const datumIds = new Map<number, string>();
  /** Path datums, kept at the end when on geometry or referenced by a kept tolerance. */
  const pathDatums: { item: PmiPathItem; targets: CadPmiTarget[][]; id: string }[] = [];
  for (const i of path.items) {
    if (i.text.kind !== 'datum') continue;
    const targets = placed(i);
    if (!targets) continue;
    if (!i.text.letter || i.text.letter === '?') {
      lose('path-unreadable');
      continue;
    }
    const id = add({ kind: 'datum', name: i.text.letter, targets: targets[0] ?? [] });
    pathDatums.push({ item: i, targets, id });
    datumIds.set(i.text.entity, id);
  }
  // A part's datum referenced by a path tolerance is copied onto the tolerance's instance.
  const partDatums = new Map(path.partDatums.map((d) => [d.text.entity, d]));
  const copies = new Map<string, string>();
  const datumFor = (datum: number, component: string | undefined): string | undefined => {
    const ofPath = datumIds.get(datum);
    if (ofPath) return ofPath;
    const d = partDatums.get(datum);
    if (!d || component === undefined) return undefined;
    const key = `${datum} ${component}`;
    const known = copies.get(key);
    if (known) return known;
    const placement = placements.find((p) =>
      p.instances.some((i) => String(i.instance) === component),
    );
    if (!placement) return undefined;
    const targets: CadPmiTarget[] = [];
    for (const item of d.items) {
      const held = placements
        .filter((p) => p.instances.some((i) => String(i.instance) === component))
        .flatMap((p) => {
          const on = onProduct(item, p.product);
          const i = on && p.instances.find((x) => x.shape === on[0]);
          return on && String(i?.instance) === component ? [{ ...on[1], component }] : [];
        });
      // The datum's faces must be on the tolerance's own instance.
      if (held.length !== 1) return undefined;
      targets.push(held[0]!);
    }
    const id = add({ kind: 'datum', name: d.text.letter, targets });
    copies.set(key, id);
    return id;
  };

  for (const i of path.items) {
    const text = i.text;
    if (text.kind === 'datum') continue;
    const targets = placed(i);
    if (!targets) continue;
    if (text.kind === 'dimension') {
      const qualifier = qualifiers[text.qualifier];
      if (
        text.signature.includes('?') ||
        text.deviation === 'fit' ||
        !(text.qualifier in qualifiers) ||
        !(pmiDimensionTypes as readonly string[]).includes(text.type) ||
        /_WithPath$/.test(text.type) ||
        !text.values.length ||
        !text.values.every(Number.isFinite) ||
        (text.deviation && !text.deviation.every(Number.isFinite))
      ) {
        lose('path-unreadable');
        continue;
      }
      keep(i, targets);
      add({
        kind: 'dimension',
        type: text.type,
        values: text.deviation ? text.values.slice(0, 1) : text.values,
        ...(text.deviation && {
          deviation: { lower: text.deviation[0], upper: text.deviation[1] },
        }),
        ...(qualifier && { qualifier }),
        targets: targets[0] ?? [],
        ...(targets[1]?.length ? { targets2: targets[1] } : {}),
      });
      continue;
    }
    const groups = compartments(text.datums);
    const zone = text.zone === undefined ? undefined : text.zone;
    if (
      !groups ||
      groups.length !== text.datumEntities.length ||
      text.signature.includes('?') ||
      !(pmiToleranceTypes as readonly string[]).includes(text.type) ||
      !Number.isFinite(text.value) ||
      text.modifiers.some((m) => !(pmiToleranceModifiers as readonly string[]).includes(m)) ||
      (zone !== undefined && zone !== 'D' && zone !== 'SD') ||
      (text.maximum !== undefined && !Number.isFinite(text.maximum))
    ) {
      lose('path-unreadable');
      continue;
    }
    // The datums of the instance the tolerance is on (one instance for a copied datum).
    const components = new Set(targets.flat().map((t) => t.component!));
    const component = components.size === 1 ? [...components][0] : undefined;
    const references: CadPmiDatumReference[] = [];
    let missing = false;
    for (const [n, g] of groups.entries()) {
      const entities = [...new Set(text.datumEntities[n] ?? [])];
      const ids = entities.map((e) => datumFor(e, component));
      if (!entities.length || ids.some((id) => id === undefined)) missing = true;
      references.push({ datums: ids as string[], modifiers: g.modifiers });
    }
    if (missing) {
      lose('path-datum');
      continue;
    }
    keep(i, targets);
    systems.push(...(systemsOf.get(text.entity) ?? []).filter((x) => !shared.has(x)));
    add({
      kind: 'geometric-tolerance',
      type: text.type,
      value: text.value,
      modifiers: text.modifiers,
      ...(zone ? { zone } : {}),
      ...(text.maximum !== undefined ? { maxValue: text.maximum } : {}),
      references,
      targets: targets[0] ?? [],
    });
  }
  // A path datum on no geometry stands only for the tolerances that use it (JAMA's datums on the
  // assembly): without a kept one it means nothing and is not kept. Ids are given again in order.
  const referenced = new Set(
    items.flatMap((i) =>
      i.kind === 'geometric-tolerance' ? i.references.flatMap((r) => r.datums) : [],
    ),
  );
  const dropped = new Set<string>();
  for (const d of pathDatums)
    if (d.targets.flat().length || referenced.has(d.id)) {
      keep(d.item, d.targets);
      if (d.item.text.kind === 'datum') features += datumFeatures(d.item.text.entity);
    } else {
      dropped.add(d.id);
      lose('path-empty');
    }
  const ids = new Map<string, string>();
  const left = items.filter((i) => !dropped.has(i.id));
  left.forEach((i, n) => ids.set(i.id, `pmi-${n + 1}`));
  const renumbered = left.map((i) =>
    i.kind === 'geometric-tolerance'
      ? {
          ...i,
          id: ids.get(i.id)!,
          references: i.references.map((r) => ({ ...r, datums: r.datums.map((d) => ids.get(d)!) })),
        }
      : { ...i, id: ids.get(i.id)! },
  );
  return {
    ...result,
    features,
    ...(renumbered.length ? { asset: { version: 1, items: renumbered } } : {}),
  };
}

/** Whether an asset is within the limits an evaluation accepts (`pmiAssetFiles`). */
export const assemblyPmiWithinLimits = (asset: CadPmiAsset) =>
  asset.items.length <= cadPmiLimits.items &&
  asset.items.every(
    (i) =>
      i.targets.length <= cadPmiLimits.targets &&
      (i.kind !== 'dimension' || (i.targets2?.length ?? 0) <= cadPmiLimits.targets),
  ) &&
  new TextEncoder().encode(JSON.stringify(asset)).byteLength <= cadPmiLimits.bytes;

/**
 * The import report with the path items: each family's items read through a path count as read
 * on the meaning and target axes (the own reader read them; the kernel's reader cannot), a
 * `path` row per family says how many of the file's path items were kept, and the paths
 * themselves are read when kept items use them. `kept` adds the kept items.
 */
export function withPathPmi(report: CadStepPmiReport, path: KeptAssemblyPmi): CadStepPmiReport {
  const families: [CadPmiKind & CadPmiFamily, number][] = (
    ['dimension', 'geometric-tolerance', 'datum'] as const
  ).map((k) => [k, path.kept[k]]);
  const axes: CadPmiAxis[] = report.axes.map((a) => ({ ...a }));
  const bump = (axis: CadPmiAxis['axis'], family: CadPmiFamily, n: number) => {
    const row = axes.find((a) => a.axis === axis && a.family === family);
    if (!row || !n) return;
    row.read = Math.min(row.inFile, row.read + n);
    row.unread = Math.max(0, row.inFile - row.read);
  };
  for (const [family, n] of families) {
    bump('semantic', family, n);
    bump('target', family, n);
  }
  bump('target', 'datum-feature', path.features);
  if (path.systems.length) {
    // A system counts once however many tolerances use it.
    bump('semantic', 'datum-system', new Set(path.systems).size);
  }
  const paths = axes.findIndex((a) => a.family === 'component-path');
  if (paths >= 0) {
    const inFile = axes[paths]!.inFile;
    const read = Math.min(inFile, path.paths.size);
    axes[paths] = { axis: 'path', family: 'component-path', inFile, read, unread: inFile - read };
  }
  for (const [family] of families) {
    const inFile = path.found[family];
    if (inFile)
      axes.push({
        axis: 'path',
        family,
        inFile,
        read: path.kept[family],
        unread: inFile - path.kept[family],
      });
  }
  const kept = { ...report.kept };
  for (const [family, n] of families) kept[family] += n;
  const complete = axes.every((a) => a.unread === 0 && a.read === a.inFile);
  const next: CadStepPmiReport = {
    ...report,
    axes,
    kept,
    complete,
    lossless: false,
    ...(Object.keys(path.problems).length ? { pathProblems: { ...path.problems } } : {}),
  };
  next.lossless = pmiLossless(next);
  return next;
}
