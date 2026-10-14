import { structureTemplates, authoredViewTemplates } from './structure-builtins';
import definitions from './builtins.json' with { type: 'json' };
import type { TemplateDefinition } from './types';
import { MemoryCatalog } from './catalog';
/** Immutable checked-in data, usable without React, network access or an API key. */
export const builtinTemplates = definitions as unknown as TemplateDefinition[];
export function builtinCatalog() {
  return new MemoryCatalog([...builtinTemplates, ...structureTemplates, ...authoredViewTemplates]);
}
