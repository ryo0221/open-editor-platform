import type { DesignContent } from './model';
export interface DesignPagination {
  schemaVersion: 1;
  direction: 'rtl' | 'ltr';
  /** IDs are native frame IDs; array order is reading order, independent of z-order. */
  pages: { frameId: string; panelIds: string[] }[];
  images: { elementId: string; source: string; license: string }[];
}
export const designPaginationLimits = Object.freeze({
  pages: 128,
  panelsPerPage: 64,
  images: 8192,
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096;
export function validDesignPagination(
  raw: unknown,
  elements: DesignContent['elements'],
): raw is DesignPagination {
  if (
    !object(raw) ||
    !fields(raw, ['schemaVersion', 'direction', 'pages', 'images']) ||
    raw.schemaVersion !== 1 ||
    !['rtl', 'ltr'].includes(String(raw.direction)) ||
    !Array.isArray(raw.pages) ||
    raw.pages.length > designPaginationLimits.pages ||
    !Array.isArray(raw.images) ||
    raw.images.length > designPaginationLimits.images
  )
    return false;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const used = new Set<string>();
  for (const page of raw.pages) {
    if (
      !object(page) ||
      !fields(page, ['frameId', 'panelIds']) ||
      !text(page.frameId) ||
      used.has(page.frameId) ||
      !Array.isArray(page.panelIds) ||
      page.panelIds.length > designPaginationLimits.panelsPerPage
    )
      return false;
    const frame = byId.get(page.frameId);
    if (frame?.type !== 'frame' || frame.parentId) return false;
    used.add(page.frameId);
    for (const id of page.panelIds) {
      if (!text(id) || used.has(id)) return false;
      const panel = byId.get(id);
      if (panel?.type !== 'frame' || panel.parentId !== page.frameId) return false;
      used.add(id);
    }
  }
  const images = new Set<string>();
  for (const image of raw.images) {
    if (
      !object(image) ||
      !fields(image, ['elementId', 'source', 'license']) ||
      !text(image.elementId) ||
      !text(image.source) ||
      !text(image.license) ||
      images.has(image.elementId) ||
      byId.get(image.elementId)?.type !== 'image'
    )
      return false;
    images.add(image.elementId);
  }
  return true;
}

/** Native Duplicate owns one complete ID map for elements and their reading/source metadata. */
export function duplicateDesignPagination(
  pagination: DesignPagination,
  mapping: ReadonlyMap<string, string>,
): DesignPagination {
  return {
    ...pagination,
    pages: pagination.pages.flatMap((page) => {
      const frameId = mapping.get(page.frameId);
      return [
        {
          ...page,
          panelIds: page.panelIds.flatMap((id) => [
            id,
            ...(!frameId && mapping.has(id) ? [mapping.get(id)!] : []),
          ]),
        },
        ...(frameId ? [{ frameId, panelIds: page.panelIds.map((id) => mapping.get(id)!) }] : []),
      ];
    }),
    images: pagination.images.flatMap((image) => [
      image,
      ...(mapping.has(image.elementId)
        ? [{ ...image, elementId: mapping.get(image.elementId)! }]
        : []),
    ]),
  };
}
