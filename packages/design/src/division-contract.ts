import type { DesignContent, DesignElement } from './model';
import { materializeDivision, nearDivision, validPanelGeometry } from './division-geometry';

/** Runs only after the ordinary hierarchy and pagination validator. */
export function validDivisionContent(d: DesignContent): boolean {
  // Shared style storage is untrusted on import; path validation runs later.
  if (
    d.styles !== undefined &&
    (!Array.isArray(d.styles) ||
      d.styles.some(
        (s) => !s || typeof s !== 'object' || !s.appearance || typeof s.appearance !== 'object',
      ))
  )
    return false;
  const polygons = d.elements.filter((e) => e.panelGeometry !== undefined);
  const divisions = d.pagination?.pages.filter((p) => p.division !== undefined) ?? [];
  if (
    d.schemaVersion !== 4 &&
    (d.pagination?.schemaVersion === 2 || polygons.length || divisions.length)
  )
    return false;
  if (d.schemaVersion === 4 && d.pagination?.schemaVersion !== 2) return false;
  const forbidden = (e: Partial<DesignElement>, depth = 0): boolean =>
    depth > 16 ||
    e.panelGeometry !== undefined ||
    Object.values(e.overrides ?? {}).some((p) => forbidden(p, depth + 1));
  if (
    d.components.some((c) => forbidden(c.template) || c.elements?.some((e) => forbidden(e))) ||
    d.elements.some((e) => Object.values(e.overrides ?? {}).some((p) => forbidden(p))) ||
    d.styles?.some((s) => Object.hasOwn(s.appearance, 'panelGeometry'))
  )
    return false;
  if (!polygons.length && !divisions.length) return true;
  if (d.reuse) return false;
  const elements = new Map(d.elements.map((e) => [e.id, e]));
  const styles = new Map(d.styles?.map((s) => [s.id, s.appearance]));
  const effective = (e: DesignElement) => ({ ...e, ...styles.get(e.styleId ?? '') });
  const absolute = (e: DesignElement) =>
    !e.rotation &&
    (!e.layout || e.layout.direction === 'absolute') &&
    (!e.sizing || e.sizing === 'fixed');
  const panelPages = new Map(
    d.pagination!.pages.flatMap((p) => p.panelIds.map((id) => [id, p] as const)),
  );
  for (const e of polygons) {
    const p = panelPages.get(e.id),
      v = effective(e),
      page = p && elements.get(p.frameId);
    if (
      !p ||
      !page ||
      e.type !== 'frame' ||
      !validPanelGeometry(e.panelGeometry) ||
      v.clipContent !== true ||
      !absolute(v) ||
      !absolute(effective(page)) ||
      v.shape !== undefined ||
      v.flipX !== undefined ||
      v.flipY !== undefined ||
      v.radius !== undefined ||
      v.vector ||
      v.path ||
      v.reference
    )
      return false;
  }
  const ids = new Set(elements.keys());
  try {
    for (const p of divisions) {
      const frame = elements.get(p.frameId)!;
      if (!absolute(effective(frame))) return false;
      const { panels, dividers } = materializeDivision(p.division!, frame.bounds);
      if (
        panels.length !== p.panelIds.length ||
        panels.some((p2) => !p.panelIds.includes(p2.panelId))
      )
        return false;
      for (const divider of dividers) {
        if (ids.has(divider.dividerId)) return false;
        ids.add(divider.dividerId);
      }
      for (const panel of panels) {
        const saved = elements.get(panel.panelId)!;
        if (
          !saved.panelGeometry ||
          !['x', 'y', 'width', 'height'].every((k) =>
            nearDivision(
              saved.bounds[k as keyof typeof saved.bounds],
              panel.bounds[k as keyof typeof panel.bounds],
            ),
          ) ||
          saved.panelGeometry.polygon.length !== panel.panelGeometry.polygon.length ||
          saved.panelGeometry.polygon.some(
            (v, i) =>
              !nearDivision(v.x, panel.panelGeometry.polygon[i].x) ||
              !nearDivision(v.y, panel.panelGeometry.polygon[i].y),
          )
        )
          return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}
