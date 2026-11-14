import {
  pinLabel,
  type FictionMapArtifactRefHost,
  type FictionMapArtifactRefStatus,
} from '@editor-platform/fiction-map/artifact-refs';
import type { FictionMapArtifactRef } from '@editor-platform/fiction-map/model';
import type { StoredArtifact } from '../model';

/** GV2a: the kinds a map feature may pin. Both are 3D models with committed versions. */
export const pinnableKinds: readonly string[] = ['cad', 'bim'];

/**
 * Pinned versions resolve against saved records only: a draft is never a pin target, and a pin
 * never follows a newer version.
 */
export function playgroundArtifactRefHost(context: {
  mapId: string;
  saved(): ReadonlyMap<string, StoredArtifact>;
  activate(id: string): void;
  setStatus(message: string): void;
}): FictionMapArtifactRefHost {
  function find(ref: FictionMapArtifactRef) {
    const record = context.saved().get(ref.artifactId);
    const index = record ? record.versions.findIndex((v) => v.versionId === ref.versionId) : -1;
    return { record, index, version: record?.versions[index] };
  }
  function status(ref: FictionMapArtifactRef): FictionMapArtifactRefStatus {
    const { record, version } = find(ref);
    if (!record) return 'missing-source';
    if (record.kind !== ref.domain || !pinnableKinds.includes(record.kind)) return 'wrong-domain';
    if (!version) return 'missing-version';
    return version.contentHash === ref.contentHash ? 'ready' : 'hash-mismatch';
  }
  return {
    options() {
      const out = [];
      for (const record of context.saved().values()) {
        const latest = record.versions.at(-1);
        if (record.id === context.mapId || !latest || !pinnableKinds.includes(record.kind))
          continue;
        // The Artifact name is free text; the pin's label is optional and bounded (Codex).
        const label = pinLabel(record.name);
        out.push({
          label: `${label ?? record.id} · ${record.kind.toUpperCase()} · version ${record.versions.length}`,
          ref: {
            artifactId: record.id,
            domain: record.kind,
            versionId: latest.versionId,
            contentHash: latest.contentHash,
            ...(label ? { label } : {}),
          },
        });
      }
      return out.sort((a, b) => a.label.localeCompare(b.label));
    },
    status,
    open(ref) {
      const { record, index } = find(ref);
      if (!record || status(ref) !== 'ready') return;
      context.activate(record.id);
      const total = record.versions.length,
        drift = record.draft.baseVersionId !== ref.versionId;
      context.setStatus(
        `Opened ${record.name}: the map pins version ${index + 1} of ${total}` +
          (drift ? '. The draft starts from another version; History shows the pinned one.' : '.'),
      );
    },
  };
}
