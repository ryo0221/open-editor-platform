/**
 * Experimental analysis Profiles and templates (docs/analysis-references-design.md): the Fishbone
 * and FTA Graph Profiles (the older versions without items and the current ones with items@1-draft
 * declarations) and the FMEA Data templates. They reuse the Graph and Data models; a Host opens
 * these diagrams and tables with the ordinary Surfaces. Not an industry-certified implementation.
 */
import type { GraphProfile } from '@editor-platform/structured-graph/model';
import { fishboneProfile, fishboneProfileV1, ftaProfile, ftaProfileV1 } from './graph';

export * from './graph';
export * from './fmea';

/** Every analysis Graph Profile version, older ones included, so that saved diagrams keep opening. */
export const analysisGraphProfiles: readonly GraphProfile[] = [
  fishboneProfileV1,
  fishboneProfile,
  ftaProfileV1,
  ftaProfile,
];

/** The analysis Profile a diagram refers to, by exact ID and version; undefined for others. */
export function analysisGraphProfileFor(ref: {
  id: string;
  version: number;
}): GraphProfile | undefined {
  return analysisGraphProfiles.find((p) => p.id === ref.id && p.version === ref.version);
}
