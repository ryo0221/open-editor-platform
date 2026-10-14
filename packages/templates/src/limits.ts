import { problem } from './types';

/** Native reuse budgets are independent from the larger Office input budgets. */
export const templateLimits = Object.freeze({
  assetCharacters: 8 * 1024 * 1024,
  totalAssetCharacters: 16 * 1024 * 1024,
  definitionBytes: 24 * 1024 * 1024,
  packBytes: 32 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  definitions: 100,
  depth: 64,
  values: 200_000,
});
export function assertTemplateTextSize(text: string, limit: number) {
  if (text.length > limit || new TextEncoder().encode(text).byteLength > limit)
    problem('template-limit', `Template data exceeds ${limit} UTF-8 bytes`);
}
export function assertTemplateSize(value: unknown, limit = templateLimits.definitionBytes) {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }],
    ancestors = new Set<object>();
  let values = 0,
    characters = 0;
  while (stack.length) {
    const item = stack.pop()!,
      v = item.value;
    if (item.exit) {
      ancestors.delete(v as object);
      continue;
    }
    if (++values > templateLimits.values || item.depth > templateLimits.depth)
      problem('template-limit', 'Template structure exceeds its value/depth budget');
    if (typeof v === 'string') characters += v.length;
    else if (v && typeof v === 'object') {
      if (ancestors.has(v)) problem('template-schema', 'Cyclic template data');
      ancestors.add(v);
      stack.push({ value: v, depth: item.depth, exit: true });
      for (const [key, child] of Object.entries(v)) {
        if (!Array.isArray(v)) characters += key.length;
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
    if (characters > limit) problem('template-limit', 'Template data exceeds its byte budget');
  }
  const serialized = JSON.stringify(value);
  if (serialized !== undefined) assertTemplateTextSize(serialized, limit);
}
