import { cadLimits, cadLoftSections, type CadDocument } from './model';
import { cadSketchLimits } from './sketch';
import { canonicalContentBytes } from './validation';

/**
 * #14: how close a document is to each of its count and size limits, so an editor or a Host can
 * warn before an edit is refused at the limit and suggest how to split the model.
 */
export type CadLimitKey =
  | 'bodies'
  | 'allBodies'
  | 'features'
  | 'profiles'
  | 'sketches'
  | 'parameters'
  | 'loftSections'
  | 'contentBytes';

export type CadLimitLevel = 'ok' | 'near' | 'over';

export interface CadLimitUsage {
  key: CadLimitKey;
  used: number;
  max: number;
  level: CadLimitLevel;
  /** For `loftSections`: the feature with the most sections. */
  featureId?: string;
}

/** A count at or past this share of its limit is `near` (#14). */
export const cadLimitWarnRatio = 0.8;

export const cadLimitLevel = (used: number, max: number): CadLimitLevel =>
  used > max ? 'over' : used >= max * cadLimitWarnRatio ? 'near' : 'ok';

const loftTypes = new Set(['loft', 'surfaceLoft']);

/**
 * Usage of every limit, in a fixed order. `contentBytes` serialises the document, so pass
 * `{ bytes: false }` where that is too costly to do on every edit.
 */
export function cadLimitUsage(
  doc: Pick<CadDocument, 'bodies' | 'features' | 'profiles' | 'sketches' | 'parameters'>,
  options: { bytes?: boolean } = {},
): CadLimitUsage[] {
  const entry = (key: CadLimitKey, used: number, max: number, featureId?: string) => ({
    key,
    used,
    max,
    level: cadLimitLevel(used, max),
    ...(featureId === undefined ? {} : { featureId }),
  });
  let sections = 0;
  let loftId: string | undefined;
  for (const f of doc.features) {
    if (!loftTypes.has(f.type)) continue;
    const n = (f.args as { sections?: unknown[] }).sections?.length ?? 0;
    if (n > sections) [sections, loftId] = [n, f.id];
  }
  const out: CadLimitUsage[] = [
    entry('bodies', doc.bodies.filter((b) => b.state !== 'consumed').length, cadLimits.bodies),
    entry('allBodies', doc.bodies.length, cadLimits.allBodies),
    entry('features', doc.features.length, cadLimits.features),
    entry('profiles', doc.profiles.length, cadLimits.profiles),
    entry('sketches', doc.sketches.length, cadSketchLimits.sketches),
    entry('parameters', doc.parameters.length, cadLimits.parameters),
    entry('loftSections', sections, cadLoftSections, loftId),
  ];
  if (options.bytes !== false)
    out.push(entry('contentBytes', canonicalContentBytes(doc), cadLimits.contentBytes));
  return out;
}

/** The limits a document is near or over, worst first. */
export const cadLimitWarnings = (usage: readonly CadLimitUsage[]) =>
  usage.filter((u) => u.level !== 'ok').sort((a, b) => b.used / b.max - a.used / a.max);
