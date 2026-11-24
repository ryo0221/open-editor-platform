import { describe, expect, it } from 'vitest';
import { graphItemsDeclaration, validateGraph } from '@editor-platform/structured-graph/model';
import {
  analysisGraphProfileFor,
  analysisGraphProfiles,
  createFishboneGraph,
  createFtaGraph,
  createFmeaData,
  fishboneProfile,
  fishboneProfileV1,
  isFmeaData,
} from './index';

describe('analysis templates as a package (for Hosts)', () => {
  it('finds a Profile by exact ID and version, older versions included, and nothing else', () => {
    expect(
      analysisGraphProfileFor({ id: fishboneProfile.id, version: fishboneProfile.version }),
    ).toBe(fishboneProfile);
    expect(
      analysisGraphProfileFor({ id: fishboneProfileV1.id, version: fishboneProfileV1.version }),
    ).toBe(fishboneProfileV1);
    expect(analysisGraphProfileFor({ id: fishboneProfile.id, version: 99 })).toBeUndefined();
    expect(analysisGraphProfileFor({ id: 'relation', version: 1 })).toBeUndefined();
    expect(new Set(analysisGraphProfiles.map((p) => `${p.id}@${p.version}`)).size).toBe(
      analysisGraphProfiles.length,
    );
  });

  it('opens its own examples with the Profile it names, and the current Profiles declare items', () => {
    for (const graph of [createFishboneGraph(), createFtaGraph()]) {
      const profile = analysisGraphProfileFor(graph.profile)!;
      expect(profile).toBeDefined();
      expect(validateGraph(graph, profile).filter((d) => d.severity === 'error')).toEqual([]);
      expect(graphItemsDeclaration(profile)?.version).toBe('items@1-draft');
    }
    expect(isFmeaData(createFmeaData('dfmea'))).toBe(true);
  });
});
