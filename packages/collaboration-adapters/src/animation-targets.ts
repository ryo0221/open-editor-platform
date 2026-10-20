import type { AnimationContent2, Layer2 } from '@editor-platform/animation-core/v2';

const inherited = new Set([
  'transform',
  'visible',
  'start',
  'end',
  'parentId',
  'clipId',
  'maskOnly',
  'motion',
  'source',
  'time',
]);
const transforms = new Set([
  'x',
  'y',
  'anchorX',
  'anchorY',
  'scaleX',
  'scaleY',
  'rotation',
  'opacity',
]);

/** Derive grants from validated native ownership and rendering dependencies, never wire targets. */
export function animationAuthorizationTargets(
  before: AnimationContent2,
  after: AnimationContent2,
  paths: readonly (readonly string[])[],
) {
  const targets = new Set<string>(),
    existing = new Set(before.compositions.flatMap((c) => c.layers.map((l) => l.id)));
  // Stable IDs preserve the layer, but changing collection ownership also edits
  // both compositions. Derive these grants from validated before/after owners.
  const owners = (content: AnimationContent2) =>
    new Map(content.compositions.flatMap((c) => c.layers.map((l) => [l.id, c.id] as const)));
  const beforeOwners = owners(before),
    afterOwners = owners(after);
  for (const [id, source] of beforeOwners) {
    const destination = afterOwners.get(id);
    if (destination && source !== destination) {
      targets.add(source);
      targets.add(destination);
    }
  }
  for (const content of [before, after]) {
    const layers = new Map(
        content.compositions.flatMap((c) => c.layers.map((l) => [l.id, l] as const)),
      ),
      dependents = new Map<string, Set<string>>(),
      lockDescendants = new Map<string, Set<string>>();
    const edge = (owner: string, child: string, graph = dependents) => {
      if (!graph.has(owner)) graph.set(owner, new Set());
      graph.get(owner)!.add(child);
    };
    for (const layer of layers.values()) {
      if (layer.parentId) {
        edge(layer.parentId, layer.id);
        edge(layer.parentId, layer.id, lockDescendants);
      }
      if (layer.clipId) edge(layer.clipId, layer.id);
      if (layer.type === 'composition' && layer.source.type === 'local') {
        const id = layer.source.compositionId;
        for (const child of content.compositions.find((c) => c.id === id)!.layers)
          edge(layer.id, child.id);
      }
    }
    const ancestors = (layer: Layer2) => {
      let current: Layer2 | undefined = layer;
      while (current) {
        if (existing.has(current.id)) targets.add(current.id);
        current = current.parentId ? layers.get(current.parentId) : undefined;
      }
    };
    const affected = (id: string, graph = dependents) => {
      const pending = [id],
        seen = new Set<string>();
      while (pending.length) {
        const current = pending.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        const layer = layers.get(current);
        if (layer) ancestors(layer);
        pending.push(...(graph.get(current) ?? []));
      }
    };
    for (const p of paths) {
      if (p[0] !== 'compositions') {
        targets.add('*');
        continue;
      }
      const c = content.compositions.find((c) => c.id === p[1]);
      if (!c) continue;
      if (p.length <= 3) {
        targets.add(c.id);
        if (p[2] !== 'name' && p[2] !== '$order:tracks')
          for (const layer of c.layers) affected(layer.id);
        continue;
      }
      const track = p[2] === 'tracks' ? c.tracks.find((t) => t.id === p[3]) : undefined,
        layer = c.layers.find((l) => l.id === (p[2] === 'layers' ? p[3] : track?.layerId));
      if (!layer) continue;
      if (!existing.has(layer.id)) targets.add(c.id);
      ancestors(layer);
      const field = p[2] === 'layers' ? p[4] : track?.property;
      // Shape changes affect clips; world transforms/lifetime also affect children
      // and native local instances. Exact retained sources keep their own owner.
      if (p.length === 4 || (field && (inherited.has(field) || transforms.has(field))))
        affected(layer.id);
      else if (field === 'locked') affected(layer.id, lockDescendants);
      else if (field && ['width', 'height', 'path'].includes(field)) {
        for (const clipped of c.layers) if (clipped.clipId === layer.id) affected(clipped.id);
      }
    }
  }
  return [...targets];
}
