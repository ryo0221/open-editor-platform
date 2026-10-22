import type { ScheduleLane } from './model';

/** A structurally valid synthetic lane. Its snapshot is not hash-checked here. */
export function syntheticLane(id = 'lane-1'): ScheduleLane {
  return {
    id,
    reference: {
      schemaVersion: 1,
      source: {
        artifactId: 'artifact_data',
        domain: 'data',
        target: { kind: 'timeline', viewId: 'view-1' },
      },
      mode: 'fixed',
      fit: 'contain',
      snapshot: {
        artifactId: 'artifact_data',
        domain: 'data',
        versionId: 'version_1',
        revision: 1,
        contentHash: 'a'.repeat(64),
        content: {},
        dependencies: [],
      },
    },
  };
}
