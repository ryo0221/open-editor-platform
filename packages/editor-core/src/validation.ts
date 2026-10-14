const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const optional = (value: unknown, valid: (value: unknown) => boolean) =>
  value === undefined || valid(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const color = (value: unknown) =>
  typeof value === 'string' && /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\))$/i.test(value);
export function validTextStyle(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    ['bold', 'italic', 'underline', 'strike', 'list'].every((key) =>
      optional(value[key], (v) => typeof v === 'boolean'),
    ) &&
    optional(value.color, color) &&
    optional(
      value.fontFamily,
      (v) => typeof v === 'string' && /^[a-zA-Z0-9 ,'-]{1,200}$/.test(v),
    ) &&
    ['fontSize', 'lineHeight', 'padding'].every((key) =>
      optional(value[key], (v) => finite(v) && v >= 0 && (key !== 'fontSize' || v > 0)),
    ) &&
    optional(value.letterSpacing, finite) &&
    optional(value.align, (v) => ['left', 'center', 'right'].includes(String(v))) &&
    optional(value.verticalAlign, (v) => ['top', 'middle', 'bottom'].includes(String(v))) &&
    optional(value.overflow, (v) => ['clip', 'expand', 'fit'].includes(String(v)))
  );
}
export function validVisualStyle(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    ['rotation', 'strokeWidth', 'radius'].every((key) => optional(value[key], finite)) &&
    optional(value.opacity, (v) => finite(v) && v >= 0 && v <= 1) &&
    ['hidden', 'locked', 'flipX', 'flipY'].every((key) =>
      optional(value[key], (v) => typeof v === 'boolean'),
    ) &&
    optional(value.stroke, color) &&
    optional(value.typography, validTextStyle) &&
    optional(
      value.runs,
      (runs) =>
        Array.isArray(runs) &&
        runs.every(
          (run) =>
            record(run) && typeof run.text === 'string' && optional(run.style, validTextStyle),
        ),
    ) &&
    optional(
      value.crop,
      (crop) =>
        record(crop) && finite(crop.x) && finite(crop.y) && finite(crop.scale) && crop.scale > 0,
    ) &&
    optional(value.imageFit, (v) => v === 'fit' || v === 'fill') &&
    optional(value.alt, (v) => typeof v === 'string')
  );
}

/** Validate references without requiring parent-before-child storage order. */
export function validHierarchy(items: { id: string; parentId?: string }[]): boolean {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length) return false;
  return items.every((item) => {
    const visited = new Set([item.id]);
    let id = item.parentId;
    while (id) {
      if (visited.has(id) || !byId.has(id)) return false;
      visited.add(id);
      id = byId.get(id)!.parentId;
    }
    return true;
  });
}
