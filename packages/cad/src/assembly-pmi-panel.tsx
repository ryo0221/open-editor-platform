/**
 * PMI-5b (docs/cad/pmi.md, 一覧・表示): the PMI of an assembly on its screen. The assembly's own
 * items (`assembly-pmi`) belong to particular instances; a component's part keeps the items
 * common to every instance (`pmi` of its version). Choosing an item highlights its faces and
 * edges on the components it names (display only).
 */
import { Fragment, useEffect, useMemo, useSyncExternalStore, type RefObject } from 'react';
import { Section } from '@editor-platform/editor-ui';
import {
  cadBodyPmiPlacements,
  cadPmiItemText,
  expandAssembly,
  occurrenceAccess,
  poseMatrix,
  type CadDocument,
  type CadPmiItem,
  type CadPmiKind,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import type { CadAssembly, CadAssemblyPmiFocus, CadAssemblyPmiView } from './assembly';
import type { CadSnapshot } from './controller';
import { PmiLineCache, pmiKindTitles, pmiMarks, targetCount } from './pmi-view';
import type { CadViewport } from './viewport';

const staleText = {
  component: 'stale (a component it names was deleted)',
  part: 'stale (another part version is placed)',
  datum: 'stale (a datum is stale)',
} as const;

/** The components an item's targets name, in order. */
const componentsOf = (item: CadPmiItem) => [
  ...new Set(
    [...item.targets, ...(item.kind === 'dimension' ? (item.targets2 ?? []) : [])].flatMap((t) =>
      t.component === undefined ? [] : [t.component],
    ),
  ),
];

export function AssemblyPmiSection({
  assembly,
  snapshot,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
}) {
  const parts = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const doc = snapshot.content;
  const own = assembly.assemblyPmi(doc);
  const selected = doc.components.find((c) => c.id === parts.selected);
  // A part's PMI is read from its version, which may arrive after the content (`meshes`).
  const common = useMemo(
    () => (selected ? assembly.componentPmi(selected.id) : []),
    [assembly, selected, doc, parts.meshes],
  );
  if (!own && !common.length) return null;
  const focus = parts.pmiFocus;
  const names = new Map(doc.components.map((c) => [c.id, c.name]));
  const part = selected && doc.parts.find((p) => p.id === selected.partId);
  return (
    <Section title="PMI">
      <div data-testid="cad-assembly-pmi">
        {own && (
          <OwnPmi view={own} names={names} focus={focus} onFocus={(f) => assembly.focusPmi(f)} />
        )}
        {selected &&
          common.map(({ bodyId, name, view }) => {
            const { state, asset } = view;
            const stale = state.status === 'stale';
            const itemCurrent = (id: string) =>
              !stale && (state.status === 'current' || view.items?.get(id)?.current === true);
            return (
              <div key={bodyId} data-testid="cad-part-pmi">
                <h4 className="cad-pmi-kind">
                  Every instance of {part?.name ?? name}
                  {common.length > 1 ? ` (${name})` : ''}
                </h4>
                {!asset ? (
                  <p className="cad-muted">The PMI kept with this part could not be read.</p>
                ) : (
                  <>
                    <p className="cad-muted">
                      The part&apos;s own PMI, the same on each instance. Choose an item to
                      highlight it on {selected.name}.
                    </p>
                    <ul className="cad-pmi-list" aria-label={`PMI of ${part?.name ?? name}`}>
                      {asset.items.map((item) => {
                        const on =
                          focus?.source === 'part' &&
                          focus.componentId === selected.id &&
                          focus.bodyId === bodyId &&
                          focus.itemId === item.id;
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              className="cad-item"
                              aria-pressed={on}
                              disabled={!itemCurrent(item.id)}
                              onClick={() =>
                                assembly.focusPmi(
                                  on
                                    ? undefined
                                    : {
                                        source: 'part',
                                        componentId: selected.id,
                                        bodyId,
                                        itemId: item.id,
                                      },
                                )
                              }
                            >
                              <span>{cadPmiItemText(item, asset)}</span>
                              <small>
                                {targetCount(item)}
                                {itemCurrent(item.id) ? '' : ' · stale (changed)'}
                              </small>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            );
          })}
      </div>
    </Section>
  );
}

function OwnPmi({
  view,
  names,
  focus,
  onFocus,
}: {
  view: CadAssemblyPmiView;
  names: ReadonlyMap<string, string>;
  focus: CadAssemblyPmiFocus | undefined;
  onFocus: (focus: CadAssemblyPmiFocus | undefined) => void;
}) {
  const { asset, items: states } = view;
  if (!asset) return <p className="cad-muted">The PMI this assembly keeps could not be read.</p>;
  const stale = [...(states?.values() ?? [])].filter((s) => !s.current).length;
  return (
    <div data-testid="cad-instance-pmi">
      <h4 className="cad-pmi-kind">Of particular instances ({asset.items.length})</h4>
      <p className="cad-muted">
        Read through assembly paths: each item belongs to the instances it names, never to the
        part&apos;s other instances.
        {stale ? ` ${stale} of ${asset.items.length} are stale.` : ''}
      </p>
      {(Object.keys(pmiKindTitles) as CadPmiKind[]).map((kind) => {
        const items = asset.items.filter((i) => i.kind === kind);
        if (!items.length) return null;
        return (
          <Fragment key={kind}>
            <h5 className="cad-pmi-kind">
              {pmiKindTitles[kind]} ({items.length})
            </h5>
            <ul className="cad-pmi-list" aria-label={`Instance ${pmiKindTitles[kind]}`}>
              {items.map((item) => {
                const s = states?.get(item.id);
                const on = focus?.source === 'assembly' && focus.itemId === item.id;
                const named = componentsOf(item).map((id) => names.get(id) ?? 'deleted component');
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="cad-item"
                      aria-pressed={on}
                      disabled={s?.current !== true}
                      onClick={() =>
                        onFocus(on ? undefined : { source: 'assembly', itemId: item.id })
                      }
                    >
                      <span>{cadPmiItemText(item, asset)}</span>
                      <small>
                        {named.length ? `on ${named.join(', ')}` : 'on the assembly'}
                        {targetCount(item) ? ` · ${targetCount(item)}` : ''}
                        {s && !s.current ? ` · ${staleText[s.reason]}` : ''}
                      </small>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * PMI-5b: the focused item's faces and edges on the components it names, at each one's pose,
 * and the selected component's part PMI lines (PMI-3a, the part's own presentation, placed with
 * the instance). Display only.
 */
export function AssemblyPmiLayer({
  assembly,
  view,
  snapshot,
  restored,
  linesShown,
}: {
  assembly: CadAssembly;
  view: RefObject<CadViewport | null>;
  snapshot: CadSnapshot;
  restored: number;
  /** The view's PMI switch (PMI-3a): presentation lines are drawn only while it is on. */
  linesShown: boolean;
}) {
  const parts = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const lineCache = useMemo(() => new PmiLineCache(), []);
  const { pmiFocus: focus, selected, meshes, creating } = parts;
  // Where the parts are drawn: a joint's or a rebind's preview moves them as `AssemblyLayer` does.
  const content = (creating?.preview ?? snapshot.rebindPreview ?? snapshot).content;
  useEffect(() => {
    const viewport = view.current;
    if (!viewport) return;
    viewport.showPartPmi(
      ...assemblyPmiDrawing(assembly, content, focus, selected, lineCache, linesShown),
    );
  }, [assembly, view, content, focus, selected, meshes, restored, lineCache, linesShown]);
  useEffect(() => () => view.current?.showPartPmi([]), [view]);
  return null;
}

type Marks = Parameters<CadViewport['showPartPmi']>[0];
type Lines = NonNullable<Parameters<CadViewport['showPartPmi']>[1]>;

function assemblyPmiDrawing(
  assembly: CadAssembly,
  content: CadDocument,
  focus: CadAssemblyPmiFocus | undefined,
  selected: string | undefined,
  lineCache: PmiLineCache,
  linesShown: boolean,
): [Marks, Lines] {
  const marks: Marks = [];
  const lines: Lines = [];
  const { occurrences } = expandAssembly(content, assembly.lookup);
  // As the parts are drawn: a revoked occurrence shows nothing of its part, even from meshes
  // another readable occurrence of the same content filled.
  const allowed = occurrenceAccess(occurrences, assembly.access);
  /** A direct component's one body mesh of its version, at its pose. */
  const placed = (componentId: string, bodyId?: string) => {
    const i = occurrences.findIndex((x) => x.path.length === 1 && x.path[0] === componentId);
    const o = occurrences[i];
    if (!o || !allowed[i]) return undefined;
    const meshes = (assembly.meshes(o.part.source.contentHash) ?? []).filter(
      (m) => !m.beforeFailure && !m.lod,
    );
    const mesh: CadMesh | undefined = bodyId
      ? meshes.find((m) => m.bodyId === bodyId)
      : meshes.length === 1
        ? meshes[0]
        : undefined;
    return mesh && { mesh, matrix: poseMatrix(o.pose), version: o.content };
  };
  if (focus?.source === 'assembly') {
    const own = assembly.assemblyPmi(content);
    const asset = own?.asset;
    // Only a current item on the content drawn: a preview's replaced version makes it stale.
    const item =
      own?.items?.get(focus.itemId)?.current === true
        ? asset?.items.find((i) => i.id === focus.itemId)
        : undefined;
    for (const id of item ? componentsOf(item) : []) {
      const at = placed(id);
      const read = asset!.parts[id];
      // Indices are the part's as read: a mesh of another shape is never marked.
      if (
        !at ||
        !read ||
        at.mesh.topology.faces.length !== read.faces ||
        at.mesh.topology.edges.length !== read.edges
      )
        continue;
      const only = (ts: CadPmiItem['targets']) => ts.filter((t) => t.component === id);
      const own = {
        ...item!,
        targets: only(item!.targets),
        ...(item!.kind === 'dimension' && item!.targets2 ? { targets2: only(item!.targets2) } : {}),
      } as CadPmiItem;
      for (const m of pmiMarks(at.mesh, own))
        marks.push({ ...m, mesh: at.mesh, matrix: at.matrix });
    }
  }
  if (selected) {
    for (const { bodyId, view } of assembly.componentPmi(selected, content)) {
      const at = placed(selected, bodyId);
      if (!at || !view.asset || !at.version) continue;
      const on =
        focus?.source === 'part' && focus.componentId === selected && focus.bodyId === bodyId;
      const current =
        on &&
        (view.state.status === 'current' ||
          (view.state.status === 'changed' && view.items?.get(focus.itemId)?.current === true));
      const item = current ? view.asset.items.find((i) => i.id === focus.itemId) : undefined;
      if (item)
        for (const m of pmiMarks(at.mesh, item, view.tracking))
          marks.push({ ...m, mesh: at.mesh, matrix: at.matrix });
      // The PMI switch hides the presentation lines, never the chosen item's faces.
      const placements = linesShown && cadBodyPmiPlacements(at.version, bodyId);
      if (!placements) continue;
      for (const l of lineCache.get(
        view.asset,
        placements,
        at.mesh.origin,
        item?.id,
        undefined,
        view.items,
      ))
        lines.push({ ...l, mesh: at.mesh, matrix: at.matrix });
    }
  }
  return [marks, lines];
}

/**
 * PMI-5b: whether the selected component's part draws presentation lines, so the view offers
 * its PMI switch in an assembly too.
 */
export function selectedPartPresented(assembly: CadAssembly): boolean {
  const selected = assembly.getSnapshot().selected;
  return (
    !!selected &&
    assembly
      .componentPmi(selected)
      .some(({ view }) => view.asset?.items.some((i) => i.presentation))
  );
}
