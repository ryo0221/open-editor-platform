import type { DesignComponent, DesignContent, DesignElement } from './model';

/** Same shape as prototype diagnostics: a stable code, an ID-based path and a message. */
export interface DesignDiagnostic {
  code: 'missing-component' | 'missing-nested-component' | 'missing-override-part';
  path: string;
  message: string;
}
/** Matches the native override/instance expansion depth. */
const overrideDepth = 16;

/**
 * Broken component references that `isDesign` keeps readable: instances whose
 * component is missing, nested instance parts that point at a missing component
 * and overrides keyed by a part their component does not have. Pure and read-only;
 * it never repairs content, so Hosts decide whether to open, warn or refuse.
 */
export function diagnoseDesign(d: DesignContent): DesignDiagnostic[] {
  const diagnostics: DesignDiagnostic[] = [];
  const components = new Map<string, DesignComponent>();
  for (const c of d.components) if (!components.has(c.id)) components.set(c.id, c);
  const component = (id: string | undefined) => (id ? components.get(id) : undefined);
  const overrides = (
    values: DesignElement['overrides'],
    c: DesignComponent,
    path: string,
    depth: number,
    swap?: string,
  ) => {
    for (const [key, override] of Object.entries(values ?? {})) {
      // A template-only component has a single implicit `root` part.
      const part = c.elements?.find((p) => p.id === key);
      if (c.elements ? !part : key !== 'root') {
        diagnostics.push({
          code: 'missing-override-part',
          // Inherited definition overrides have no instance-local record; point at the swap.
          path: swap ?? `${path}/${key}`,
          message: swap
            ? `Inherited override targets a part missing from swapped component ${c.id}: ${key}`
            : `Override targets a part missing from component ${c.id}: ${key}`,
        });
        continue;
      }
      // Native projection applies the override first, so its type decides (retained content).
      if (!part || !override || (override.type ?? part.type) !== 'instance') continue;
      if (override.componentId !== undefined && !component(override.componentId))
        diagnostics.push({
          code: 'missing-nested-component',
          path: `${path}/${key}/componentId`,
          message: `Nested instance override points at a missing component: ${override.componentId}`,
        });
      // A part without a component is reported once, at its definition.
      const nested = component(override.componentId ?? part.componentId);
      if (!nested || depth + 1 >= overrideDepth) continue;
      // Without its own overrides, a swapped part keeps the definition's overrides
      // (applyDesignOverride), which then apply to the replacement component.
      const inherited =
        override.overrides === undefined &&
        override.componentId !== undefined &&
        override.componentId !== part.componentId;
      if (inherited)
        overrides(part.overrides, nested, path, depth + 1, swap ?? `${path}/${key}/componentId`);
      else overrides(override.overrides, nested, `${path}/${key}/overrides`, depth + 1, swap);
    }
  };
  for (const e of d.elements) {
    if (e.type !== 'instance') continue;
    const c = component(e.componentId);
    if (c) overrides(e.overrides, c, `elements/${e.id}/overrides`, 0);
    else
      diagnostics.push({
        code: 'missing-component',
        path: `elements/${e.id}/componentId`,
        message: `Instance points at a missing component: ${e.componentId ?? '(none)'}`,
      });
  }
  for (const c of d.components)
    for (const part of c.elements ?? []) {
      if (part.type !== 'instance') continue;
      const path = `components/${c.id}/elements/${part.id}`;
      const nested = component(part.componentId);
      if (nested) overrides(part.overrides, nested, `${path}/overrides`, 0);
      else
        diagnostics.push({
          code: 'missing-nested-component',
          path: `${path}/componentId`,
          message: `Nested instance in component ${c.id} points at a missing component: ${part.componentId ?? '(none)'}`,
        });
    }
  return diagnostics;
}
