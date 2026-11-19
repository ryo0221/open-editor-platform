/**
 * DW2 (docs/cad/drawing-editor.md): a kept CAD version as the placed bodies a projection reads.
 * A part's own active bodies sit where they are; an assembly's parts are placed by each
 * occurrence's saved world pose (nested ones included), with the occurrence path as the anchor's
 * path. Meshes come from the exact kernel build at a deflection the drawing fixes (never the
 * display's level of detail), so a view is the same every time it is derived.
 */
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  bomRows,
  cadBodyPmi,
  cadPmiItemStates,
  cadPmiTrackedIndex,
  elementName,
  expandAssembly,
  rotateVector,
  type CadPmiAsset,
  type CadPmiItem,
  type CadDocument,
  type CadPartDef,
  type CadPartLookup,
  type CadSolvedPose,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import type {
  DrawingMeshBody,
  DrawingPartsInfo,
  DrawingPmiItem,
  DrawingPmiLive,
} from '@editor-platform/drawing-core';

/** The kernel triangles of one exact version, or why there are none. */
export type DrawingMeshSource = (
  content: CadDocument,
  contentHash: string,
) => Promise<CadMesh[] | { code: string }>;

const isSolid = (content: CadDocument, bodyId: string) =>
  content.bodies.find((b) => b.id === bodyId)?.kind !== 'sheet';
const shown = (content: CadDocument, m: CadMesh) =>
  !m.lod &&
  !m.beforeFailure &&
  content.bodies.some((b) => b.id === m.bodyId && b.state === 'active');

/** One kernel mesh as a body placed by `pose` (none: where it is). */
export function drawingMeshBody(
  mesh: CadMesh,
  path: string[],
  pose?: CadSolvedPose,
  solid = true,
): DrawingMeshBody {
  const [ox, oy, oz] = mesh.origin;
  const place = (x: number, y: number, z: number): [number, number, number] => {
    if (!pose) return [x + ox, y + oy, z + oz];
    const r = rotateVector(pose.rotation, [x + ox, y + oy, z + oz]);
    const t = pose.translationMm;
    return [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
  };
  const n = mesh.positions.length / 3;
  const positions = new Float64Array(n * 3);
  for (let i = 0; i < n; i++)
    positions.set(
      place(mesh.positions[3 * i]!, mesh.positions[3 * i + 1]!, mesh.positions[3 * i + 2]!),
      3 * i,
    );
  const faceCount = mesh.topology.faces.length;
  const faces = new Int32Array(mesh.indices.length / 3);
  for (let t = 0; t < faces.length; t++) {
    const f = mesh.faceIds[t]! - mesh.faceBase - 1;
    faces[t] = f >= 0 && f < faceCount ? f : -1;
  }
  // Segments of one edge in order, joined where one ends at the next one's start.
  const edgeCount = mesh.topology.edges.length;
  const edges: DrawingMeshBody['edges'] = [];
  let current: { index: number; points: number[] } | undefined;
  for (let s = 0; s < mesh.edgeIds.length; s++) {
    const index = mesh.edgeIds[s]! - mesh.edgeBase - 1;
    if (index < 0 || index >= edgeCount) continue;
    // A solid's seam (one face on both sides, as a cylinder's) is no edge of the drawing.
    if (solid && new Set(mesh.topology.edges[index]!.faces).size < 2) continue;
    const a = place(mesh.edges[6 * s]!, mesh.edges[6 * s + 1]!, mesh.edges[6 * s + 2]!);
    const b = place(mesh.edges[6 * s + 3]!, mesh.edges[6 * s + 4]!, mesh.edges[6 * s + 5]!);
    const last = current?.points.slice(-3);
    if (
      current &&
      current.index === index &&
      last &&
      Math.hypot(last[0]! - a[0], last[1]! - a[1], last[2]! - a[2]) < 1e-9
    ) {
      current.points.push(...b);
      continue;
    }
    current = { index, points: [...a, ...b] };
    edges.push(current);
  }
  // DW3c: the edge's persistent name, which a dimension follows to a newer version (none for
  // imported geometry, whose faces have no names).
  const nameOf = (index: number) => {
    const n = elementName(mesh.topology, 'edge', index);
    return n === null ? {} : { name: canonicalJson(n) };
  };
  return {
    path,
    bodyId: mesh.bodyId,
    // A sheet encloses nothing: a section draws its cut lines, no filled face (Codex on #1278).
    ...(solid ? {} : { sheet: true as const }),
    positions,
    indices: mesh.indices,
    faces,
    edges: edges.map((e) => ({
      index: e.index,
      points: Float64Array.from(e.points),
      ...nameOf(e.index),
    })),
  };
}

/** DW3c-2b: a part's PMI item as a drawing writes it (datum references as their letters). */
function drawingItem(item: CadPmiItem, asset: CadPmiAsset): DrawingPmiItem {
  switch (item.kind) {
    case 'dimension':
      return {
        kind: 'dimension',
        type: item.type,
        values: [...item.values],
        ...(item.deviation ? { deviation: { ...item.deviation } } : {}),
        ...(item.qualifier ? { qualifier: item.qualifier } : {}),
      };
    case 'geometric-tolerance': {
      const letter = (id: string) => {
        const d = asset.items.find((i) => i.id === id);
        return d?.kind === 'datum' ? d.name : '?';
      };
      return {
        kind: 'geometric-tolerance',
        type: item.type,
        value: item.value,
        ...(item.zone ? { zone: item.zone } : {}),
        modifiers: [...item.modifiers],
        ...(item.maxValue !== undefined ? { maxValue: item.maxValue } : {}),
        datums: item.references.map((r) => r.datums.map(letter).join('-')),
        // Every requirement of the frame is kept, so a change to any of them is an update.
        ...(item.references.some((r) => r.modifiers.length)
          ? { datumModifiers: item.references.map((r) => [...r.modifiers]) }
          : {}),
      };
    }
    case 'datum':
      return { kind: 'datum', name: item.name };
    case 'datum-target':
      return { kind: 'datum-target', datum: item.datum, number: item.number, type: item.type };
  }
}

/**
 * DW3c-2b: the PMI items a body carries from an import (docs/cad/pmi.md), each current or not on
 * this version by the PMI rules (`cadBodyPmi`, `cadPmiItemStates`), with its first target's
 * centre placed where the body is (`pose`). A body whose PMI asset bytes are not kept has none.
 */
export function drawingBodyPmi(
  doc: CadDocument,
  mesh: CadMesh,
  path: string[],
  pose: CadSolvedPose | undefined,
  readAsset: (sha256: string) => CadPmiAsset | undefined,
): DrawingPmiLive[] {
  const state = cadBodyPmi(doc, mesh.bodyId);
  if (state.status === 'none') return [];
  const ref = doc.assets.find((a) => a.id === state.assetId);
  const asset = ref ? readAsset(ref.sha256) : undefined;
  if (!ref || !asset) return [];
  const tracking =
    state.status === 'changed' ? mesh.pmi?.find((t) => t.featureId === state.featureId) : undefined;
  const states = state.status === 'current' ? undefined : cadPmiItemStates(asset, tracking);
  const place = (p: readonly number[]): [number, number, number] => {
    if (!pose) return [p[0]!, p[1]!, p[2]!];
    const r = rotateVector(pose.rotation, [p[0]!, p[1]!, p[2]!]);
    const t = pose.translationMm;
    return [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
  };
  return asset.items.map((item) => {
    const current = !states || states.get(item.id)?.current === true;
    let target: [number, number, number] | undefined;
    for (const t of item.targets) {
      const i = tracking ? cadPmiTrackedIndex(tracking, t) : t.index - 1;
      if (i === undefined || i < 0) continue;
      const c =
        t.shape === 'face'
          ? mesh.topology.faces[i]?.centroid
          : t.shape === 'edge'
            ? mesh.topology.edges[i]?.centroid
            : mesh.topology.vertices[i]?.centroid;
      if (c) {
        target = place(c);
        break;
      }
    }
    return {
      path,
      bodyId: mesh.bodyId,
      itemId: item.id,
      assetSha256: ref.sha256,
      item: drawingItem(item, asset),
      current,
      ...(target ? { target } : {}),
    };
  });
}

/**
 * Every body a view of `content` shows: its own, then each occurrence's part bodies. `only`
 * keeps the bodies whose ID (own) or occurrence ID (anywhere on the path) it lists. A version
 * whose meshes cannot be made fails the whole view with its code, so a drawing never silently
 * leaves a part out.
 */
export async function drawingCadBodies(
  content: CadDocument,
  contentHash: string,
  lookup: CadPartLookup,
  meshes: DrawingMeshSource,
  only: readonly string[] = [],
  /** DW3c-2b: a kept PMI asset by hash, to read the bodies' PMI (none: no PMI). */
  readPmi?: (sha256: string) => CadPmiAsset | undefined,
): Promise<DrawingMeshBody[] | { code: string }> {
  const keep = (path: string[], bodyId: string) =>
    !only.length || (path.length ? path.some((p) => only.includes(p)) : only.includes(bodyId));
  const out: DrawingMeshBody[] = [];
  const cache = new Map<string, CadMesh[]>();
  const of = async (doc: CadDocument, hash: string) => {
    const kept = cache.get(hash);
    if (kept) return kept;
    if (!doc.bodies.some((b) => b.state === 'active')) return [];
    const r = await meshes(doc, hash);
    if (!Array.isArray(r)) return r;
    const list = r.filter((m) => shown(doc, m));
    cache.set(hash, list);
    return list;
  };
  const own = await of(content, contentHash);
  if (!Array.isArray(own)) return own;
  const withPmi = (
    body: DrawingMeshBody,
    doc: CadDocument,
    m: CadMesh,
    pose?: CadSolvedPose,
  ): DrawingMeshBody => {
    const pmi = readPmi ? drawingBodyPmi(doc, m, body.path, pose, readPmi) : [];
    return pmi.length ? { ...body, pmi } : body;
  };
  for (const m of own)
    if (keep([], m.bodyId))
      out.push(withPmi(drawingMeshBody(m, [], undefined, isSolid(content, m.bodyId)), content, m));
  const expansion = expandAssembly(content, lookup);
  if (expansion.missing.size) return { code: 'source-missing' };
  if (expansion.limit) return { code: expansion.limit };
  for (const o of expansion.occurrences) {
    if (!o.content) return { code: 'source-missing' };
    const list = await of(o.content, o.part.source.contentHash);
    if (!Array.isArray(list)) return list;
    for (const m of list)
      if (keep(o.path, m.bodyId))
        out.push(
          withPmi(
            drawingMeshBody(m, o.path, o.pose, isSolid(o.content, m.bodyId)),
            o.content,
            m,
            o.pose,
          ),
        );
  }
  return out;
}

/** A placed part's row key: its exact saved version (or, imported, its content). */
const partKey = ({ source }: CadPartDef) =>
  source.kind === 'version'
    ? `v ${source.artifactId} ${source.versionId}`
    : `i ${source.contentHash}`;

/**
 * DW4 (docs/cad/drawing-editor.md, 組立図): the flat BOM of a kept CAD version (`bomRows`, as the
 * CAD Surface lists it) as a drawing's parts list, and the row each placed body counts in: the
 * version's own bodies, then each occurrence by its part version. A part left out of the BOM
 * (`bom: 'exclude'`) has no row, so it takes no balloon.
 */
export function drawingCadParts(content: CadDocument, lookup: CadPartLookup): DrawingPartsInfo {
  const rows = bomRows(content, lookup, 'flat');
  const own = content.bodies.filter((b) => b.state === 'active');
  const expansion = expandAssembly(content, lookup);
  // The occurrences counted in the BOM. A component left out of it leaves out its pattern
  // copies and all it places. The expansion lists a seed, its subtree, then each copy (and its
  // subtree): a step that is no component of its owner is a copy of the last seed listed under
  // that owner.
  const counted: typeof expansion.occurrences = [];
  const owners = new Map<string, CadDocument | undefined>([['', content]]);
  const lastSeed = new Map<string, { bom?: string }>();
  const excluded = new Set<string>();
  for (const o of expansion.occurrences) {
    const parent = o.path.slice(0, -1).join('/');
    const step = o.path[o.path.length - 1]!;
    const self = o.path.join('/');
    owners.set(self, o.content);
    const owner = owners.get(parent);
    const component = owner?.components.find((c) => c.id === step);
    if (component) lastSeed.set(parent, component);
    const seed = component ?? lastSeed.get(parent);
    if (excluded.has(parent) || seed?.bom === 'exclude') excluded.add(self);
    else counted.push(o);
  }
  // Imported parts have no saved version on their row; two may share a name (Codex on #1228).
  // The flat BOM lists them as it first counts them, depth first as the expansion runs: the
  // k-th imported row is the k-th imported content counted that is not only an assembly.
  const importedKeys: { key: string; name: string }[] = [];
  for (const o of counted) {
    if (o.part.source.kind === 'version') continue;
    const onlyPlaces =
      !!o.content &&
      !o.content.bodies.some((b) => b.state === 'active') &&
      o.content.components.length > 0;
    const key = partKey(o.part);
    if (!onlyPlaces && !importedKeys.some((k) => k.key === key))
      importedKeys.push({ key, name: o.part.name });
  }
  // DW4b: a saved part version's hash, for its part drawing.
  const hashes = new Map<string, string>();
  for (const o of counted)
    if (o.part.source.kind === 'version') hashes.set(partKey(o.part), o.part.source.contentHash);
  const out: DrawingPartsInfo = { rows: [], occurrences: [] };
  let nextImported = 0;
  rows.forEach((r, i) => {
    let key: string;
    if (i < own.length) key = `b ${own[i]!.id}`;
    else if (r.reference) key = `v ${r.reference.artifactId} ${r.reference.versionId}`;
    else {
      const k = importedKeys[nextImported++];
      key = k && k.name === r.name ? k.key : `row ${r.item}`;
    }
    out.rows.push({
      item: r.item,
      partNumber: r.partNumber,
      name: r.name,
      description: r.description,
      quantity: r.quantity,
      key,
      ...(i < own.length ? { bodyId: own[i]!.id } : {}),
      ...(r.reference && hashes.has(key)
        ? {
            source: {
              artifactId: r.reference.artifactId,
              versionId: r.reference.versionId,
              contentHash: hashes.get(key)!,
            },
          }
        : {}),
    });
  });
  for (const b of own) out.occurrences.push({ path: [], bodyId: b.id, key: `b ${b.id}` });
  for (const o of counted) out.occurrences.push({ path: [...o.path], key: partKey(o.part) });
  return out;
}
