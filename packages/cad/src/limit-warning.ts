import {
  cadLimitUsage,
  cadLimitWarnings,
  type CadDocument,
  type CadLimitKey,
} from '@editor-platform/cad-core';

/** #14: names of the limits in the status line's warning. */
const limitNames: Record<CadLimitKey, string> = {
  bodies: 'shown bodies',
  allBodies: 'bodies',
  features: 'features',
  profiles: 'profiles',
  sketches: 'sketches',
  parameters: 'parameters',
  loftSections: 'loft sections',
  contentBytes: 'document size',
};
/**
 * #14: the limits the document is near (80 %) or over, with how to split it; undefined when all
 * are well within. Counts only: the document's size is checked when it is saved.
 */
export function limitWarningText(doc: CadDocument): string | undefined {
  const warnings = cadLimitWarnings(cadLimitUsage(doc, { bytes: false }));
  if (!warnings.length) return undefined;
  const items = warnings.map(
    (w) =>
      `${limitNames[w.key]} ${w.used.toLocaleString('en-US')} / ${w.max.toLocaleString('en-US')}`,
  );
  const hint =
    warnings[0]!.key === 'loftSections'
      ? 'split the loft into two lofts'
      : 'split the model into part versions and an assembly';
  return warnings.some((w) => w.level === 'over')
    ? `Over the limit: ${items.join(', ')}. To save it, ${hint}.`
    : `Near the limit: ${items.join(', ')}. Before it is reached, ${hint}.`;
}
