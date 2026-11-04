import type { DesignContent } from './model';

/** Resolve native ownership; a cleared selection keeps the last page as view state. */
export function mangaEditingContext(
  content: DesignContent,
  selected: readonly string[],
  currentPageId?: string,
) {
  const index = new Map(content.elements.map((e) => [e.id, e]));
  const ancestors = new Set<string>();
  for (const id of selected) {
    let element = index.get(id);
    while (element && !ancestors.has(element.id)) {
      ancestors.add(element.id);
      element = element.parentId ? index.get(element.parentId) : undefined;
    }
  }
  const pages = content.pagination?.pages ?? [];
  const page =
    pages.find((p) => ancestors.has(p.frameId)) ??
    pages.find((p) => p.frameId === currentPageId) ??
    pages[0];
  const frame = page && index.get(page.frameId);
  const panelId = page?.panelIds.find((id) => ancestors.has(id)) ?? page?.panelIds[0];
  return { page, frame, panel: panelId ? index.get(panelId) : undefined };
}
