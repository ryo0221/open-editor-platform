import type { DesignContent, DesignElement } from '@editor-platform/design/model';

/** Native Design dependencies; collection-qualified keys keep equal IDs in separate scopes. */
export function designCommandReads(d: DesignContent, ids: readonly string[]): string[] {
  if (!ids.length) return [];
  const reads = new Set<string>();
  const elements = new Map(d.elements.map((e) => [e.id, e]));
  const components = new Map(d.components.map((c) => [c.id, c]));
  const seenComponents = new Set<string>();
  const visit = (element: Partial<DesignElement>) => {
    if (element.styleId) reads.add(`entity:styles:${element.styleId}`);
    for (const interaction of element.interactions ?? [])
      if ('frameId' in interaction.action)
        reads.add(`entity:elements:${interaction.action.frameId}`);
    if (element.componentId) {
      const id = element.componentId;
      reads.add(`entity:components:${id}`);
      if (!seenComponents.has(id)) {
        seenComponents.add(id);
        const component = components.get(id);
        if (component) {
          visit(component.template);
          component.elements?.forEach(visit);
        }
      }
    }
    Object.values(element.overrides ?? {}).forEach(visit);
  };
  const children = new Map<string, string[]>();
  for (const e of d.elements) {
    if (!e.parentId) continue;
    const list = children.get(e.parentId) ?? [];
    list.push(e.id);
    children.set(e.parentId, list);
  }
  // The legacy direct API checks the native subtree, while both APIs check ancestors.
  const descendants = new Set(ids),
    pending = [...ids];
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i];
    reads.add(`children:entity:elements:${id}`);
    for (const child of children.get(id) ?? [])
      if (!descendants.has(child)) {
        descendants.add(child);
        pending.push(child);
      }
  }
  const visited = new Set<string>();
  for (const root of pending) {
    let id: string | undefined = root;
    while (id && !visited.has(id)) {
      visited.add(id);
      reads.add(`entity:elements:${id}`);
      const element = elements.get(id);
      if (element) visit(element);
      id = element?.parentId;
    }
  }
  return [...reads];
}
