import type {
  CadPmiAsset,
  CadPmiDatumReference,
  CadPmiItem,
  CadPmiKind,
  CadPmiPresentation,
  CadPmiTarget,
  CadPmiView,
} from '@editor-platform/cad-core';
import type { OcModule } from '@editor-platform/geometry-kernel-occt';
import {
  datumKey,
  pmiDatumModifiers,
  pmiDimensionTypes,
  pmiToleranceModifiers,
  pmiToleranceTypes,
  type CadItemViews,
  type CadPmiVerified,
  type PmiItemJson,
  type PmiTargetJson,
} from './step-pmi';
import type { PmiFileView } from './step-pmi-presentation';

/**
 * PMI-2 (docs/cad/pmi.md): turns the verified items of one XDE read into `pmi` assets, one per
 * imported body. The reader names a target by its product and its index in `TopExp::MapShapes`
 * of the product's shape; the body is one solid or shell of that product (a product may be
 * split into several bodies), so each target is looked up as the same sub-shape (`IsSame`) in
 * the body's own map. An item is kept only when all its targets are sub-shapes of one body,
 * and a tolerance only with the datums it references on that body.
 */

/** A product the reader named, with the bodies the import made of it. */
export interface PmiProduct {
  /** The product's shape in the same XDE document as the PMI. */
  shape: unknown;
  /** The import's bodies of this product, by the import's shape index. */
  bodies: { index: number; shape: unknown }[];
}

export interface KeptPmi {
  /** The asset of each body that keeps at least one item, by the import's shape index. */
  assets: Map<number, CadPmiAsset>;
  /** Kept items by kind (an item kept on a product's several bodies counts once). */
  kept: Record<CadPmiKind, number>;
  /** The reader's items that were kept (PMI-3: which callouts are shown). */
  keptItems: Set<PmiItemJson>;
  /** PMI-3b: the file's saved views kept on any body, by entity. */
  keptViews: Set<number>;
}

/**
 * A product's sub-shape (its kind as `TopAbs_ShapeEnum`'s value and its 1-based index in
 * `TopExp::MapShapes` of the product's shape) as a sub-shape of each body that holds it: the
 * body's import index and the target's index there. Bodies split from one product can share a
 * face or edge, so a target may be on several.
 */
export function pmiSubShapes(
  oc: OcModule,
  own: <T>(value: T) => T,
): (product: PmiProduct, shape: number, index: number | undefined) => Map<number, CadPmiTarget> {
  const kinds: [number, CadPmiTarget['shape'], string][] = [
    [oc.TopAbs_ShapeEnum.TopAbs_FACE.value, 'face', 'TopAbs_FACE'],
    [oc.TopAbs_ShapeEnum.TopAbs_EDGE.value, 'edge', 'TopAbs_EDGE'],
    [oc.TopAbs_ShapeEnum.TopAbs_VERTEX.value, 'vertex', 'TopAbs_VERTEX'],
  ];
  const maps = new Map<
    unknown,
    Map<string, { FindKey(i: number): unknown; FindIndex(s: unknown): number; Extent(): number }>
  >();
  const mapOf = (shape: unknown, kind: string) => {
    let byKind = maps.get(shape);
    if (!byKind) maps.set(shape, (byKind = new Map()));
    let map = byKind.get(kind);
    if (!map) {
      map = own(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum[kind], map);
      byKind.set(kind, map!);
    }
    return map!;
  };
  return (product, shape, index) => {
    const found = new Map<number, CadPmiTarget>();
    const kind = kinds.find(([v]) => v === shape);
    if (!kind || !index || index < 1) return found;
    const productMap = mapOf(product.shape, kind[2]);
    if (index > productMap.Extent()) return found;
    const sub = productMap.FindKey(index);
    for (const body of product.bodies) {
      const at = mapOf(body.shape, kind[2]).FindIndex(sub);
      if (at > 0) found.set(body.index, { shape: kind[1], index: at });
    }
    return found;
  };
}

const targetTypes = ['point', 'line', 'rectangle', 'circle', 'area'] as const;
/** An item before its id (distributes over the kinds). */
type NewItem = CadPmiItem extends infer T ? (T extends CadPmiItem ? Omit<T, 'id'> : never) : never;

export function keepPmi(
  oc: OcModule,
  own: <T>(value: T) => T,
  verified: CadPmiVerified,
  products: Map<string, PmiProduct>,
  /** Every datum label the reader gave (a tolerance names its own copy of a datum). */
  datumLabels: Map<string, PmiItemJson>,
  /** PMI-3a: the presentation of verified items, kept with the item (not with a datum's copy). */
  presented: Map<PmiItemJson, CadPmiPresentation> = new Map(),
  /** PMI-3b: the saved views that show verified items, kept on the bodies that keep the items. */
  viewsOf: Map<PmiItemJson, CadItemViews> = new Map(),
): KeptPmi {
  const subShapes = pmiSubShapes(oc, own);
  const resolve = (t: PmiTargetJson): Map<number, CadPmiTarget> => {
    const product = t.product === undefined ? undefined : products.get(t.product);
    return product ? subShapes(product, t.shape, t.index) : new Map();
  };
  /**
   * The bodies that hold every target of an item (in import order), and the targets on a body.
   * `also` narrows the bodies further (a tolerance's datums must be on the same body).
   */
  const placed = (lists: PmiTargetJson[][], also: number[][] = []) => {
    const resolved = lists.map((list) => list.map(resolve));
    let bodies: number[] | undefined;
    for (const list of resolved)
      for (const on of list) bodies = (bodies ?? [...on.keys()]).filter((b) => on.has(b));
    for (const allowed of also) bodies = bodies?.filter((b) => allowed.includes(b));
    return {
      bodies: (bodies ?? []).sort((x, y) => x - y),
      on: (body: number) => resolved.map((list) => list.map((on) => on.get(body)!)),
    };
  };
  /** The targets of an item on one body, the first in import order that holds them all. */
  const onOneBody = (lists: PmiTargetJson[][], also?: number[][]) => {
    const p = placed(lists, also);
    const body = p.bodies[0];
    return body === undefined ? undefined : { body, targets: p.on(body) };
  };

  const items = new Map<number, CadPmiItem[]>();
  const kept: Record<CadPmiKind, number> = {
    dimension: 0,
    'geometric-tolerance': 0,
    datum: 0,
    'datum-target': 0,
  };
  const keptItems = new Set<PmiItemJson>();
  /** Each body's views by the file's view entity, and the file's views kept on any body. */
  const views = new Map<number, Map<number, CadPmiView>>();
  const keptViews = new Set<number>();
  const viewIds = (body: number, shown: PmiFileView[]) => {
    let mine = views.get(body);
    if (!mine) views.set(body, (mine = new Map()));
    return shown.flatMap((v) => {
      const c = v.camera;
      if (!c) return [];
      let view = mine.get(v.id);
      if (!view) {
        view = {
          id: `view-${mine.size + 1}`,
          name: v.name,
          camera: {
            eye: c.eye,
            direction: c.direction,
            up: c.up,
            width: c.width,
            height: c.height,
          },
        };
        mine.set(v.id, view);
      }
      keptViews.add(v.id);
      return [view.id];
    });
  };
  /** Adds an item; `from` is the reader's item it is kept from, undefined for a datum's copy. */
  const add = (body: number, item: NewItem, from?: PmiItemJson) => {
    const list = items.get(body) ?? [];
    items.set(body, list);
    const id = `pmi-${list.length + 1}`;
    const lines = from && presented.get(from);
    const of = from && viewsOf.get(from);
    const shownIn = of ? viewIds(body, of.views) : [];
    // The lines of each callout with the views that list it: a view shows only its own.
    const presentation =
      lines && of && shownIn.length
        ? {
            ...lines,
            ranges: of.ranges.map((range) => ({
              end: range.end,
              views: viewIds(body, range.views),
            })),
          }
        : lines;
    list.push({
      id,
      ...item,
      ...(presentation ? { presentation } : {}),
      ...(shownIn.length ? { views: shownIn } : {}),
    } as CadPmiItem);
    if (from) {
      kept[item.kind]++;
      keptItems.add(from);
    }
    return id;
  };

  // Datums first, each on the first body that holds it. A tolerance on another body that also
  // holds the datum gets its own copy of the datum there (bodies split from one product can
  // share the datum's face); a copy is not counted again.
  const datums = new Map<
    string,
    {
      name: string;
      bodies: number[];
      on: (body: number) => CadPmiTarget[][];
      ids: Map<number, string>;
    }
  >();
  for (const d of verified.datums) {
    const p = placed([d.targets]);
    if (!p.bodies.length || !d.name) continue;
    const body = p.bodies[0];
    const ids = new Map([
      [body, add(body, { kind: 'datum', name: d.name, targets: p.on(body)[0] }, d)],
    ]);
    datums.set(datumKey(d), { name: d.name, bodies: p.bodies, on: p.on, ids });
  }
  const datumOn = (key: string, body: number) => {
    const d = datums.get(key)!;
    let id = d.ids.get(body);
    if (id === undefined) {
      id = add(body, { kind: 'datum', name: d.name, targets: d.on(body)[0] });
      d.ids.set(body, id);
    }
    return id;
  };
  for (const d of verified.datumTargets) {
    const on = onOneBody([d.targets]);
    const type = d.target ? targetTypes[d.target.type] : undefined;
    if (!on || !d.target || !type) continue;
    add(
      on.body,
      {
        kind: 'datum-target',
        datum: d.name ?? '',
        number: d.target.number,
        type,
        targets: on.targets[0],
      },
      d,
    );
  }
  for (const d of verified.dimensions) {
    const on = onOneBody([d.targets, d.targets2 ?? []]);
    const type = d.type === undefined ? undefined : pmiDimensionTypes[d.type];
    if (!on || !type || !d.values?.length) continue;
    const values = d.plusMinus ? d.values.slice(0, 1) : [...d.values].sort((a, b) => a - b);
    add(
      on.body,
      {
        kind: 'dimension',
        type,
        values,
        // OCCT 7.6 keeps the lower deviation as a magnitude; a verified item's is below nominal.
        ...(d.plusMinus && {
          deviation: { lower: -Math.abs(d.lowerTol ?? 0), upper: d.upperTol ?? 0 },
        }),
        ...(d.qualifier !== undefined &&
          d.qualifier >= 1 &&
          d.qualifier <= 3 && { qualifier: (['min', 'max', 'avg'] as const)[d.qualifier - 1] }),
        targets: on.targets[0],
        ...(on.targets[1].length ? { targets2: on.targets[1] } : {}),
      },
      d,
    );
  }
  for (const t of verified.tolerances) {
    const type = t.type === undefined ? undefined : pmiToleranceTypes[t.type];
    if (!type || t.value === undefined) continue;
    const refs = (t.datums ?? []).map((label) => {
      const d = datumLabels.get(label);
      const key = d && datumKey(d);
      return d && key && datums.has(key) ? { d, key } : undefined;
    });
    if (refs.some((r) => !r)) continue;
    // The tolerance's faces and every datum it references on one body.
    const on = onOneBody(
      [t.targets],
      refs.map((r) => datums.get(r!.key)!.bodies),
    );
    if (!on) continue;
    // Compartments as the reader groups them (`readDatums`): a common datum shares a position.
    const references: (CadPmiDatumReference & { position?: number })[] = [];
    for (const r of refs) {
      const { d, key } = r!;
      const id = datumOn(key, on.body);
      const last = references[references.length - 1];
      if (last && d.position !== undefined && last.position === d.position) last.datums.push(id);
      else
        references.push({
          position: d.position,
          datums: [id],
          modifiers: (d.modifiers ?? []).map((m) => pmiDatumModifiers[m] ?? `#${m}`),
        });
    }
    add(
      on.body,
      {
        kind: 'geometric-tolerance',
        type,
        value: t.value,
        modifiers: [
          ...(t.modifiers ?? []).map((m) => pmiToleranceModifiers[m] ?? `#${m}`),
          ...(t.material === 1
            ? ['MAXIMUM_MATERIAL_REQUIREMENT']
            : t.material === 2
              ? ['LEAST_MATERIAL_REQUIREMENT']
              : []),
        ],
        ...(t.typeOfValue === 1
          ? { zone: 'D' as const }
          : t.typeOfValue === 2
            ? { zone: 'SD' as const }
            : {}),
        ...(t.maxValue ? { maxValue: t.maxValue } : {}),
        references: references.map(({ datums, modifiers }) => ({ datums, modifiers })),
        targets: on.targets[0],
      },
      t,
    );
  }
  const assets = new Map<number, CadPmiAsset>();
  for (const [body, list] of items) {
    const own = [...(views.get(body)?.values() ?? [])];
    assets.set(body, { version: 1, items: list, ...(own.length ? { views: own } : {}) });
  }
  return { assets, kept, keptItems, keptViews };
}
