import type { PcbBoardSource, PcbSchematicSource } from '@editor-platform/pcb';
import { isSchematicDocument } from '@editor-platform/schematic-core';
import { validatePcb, type PcbDocument } from '@editor-platform/pcb-core';
import type { StoredArtifact } from '../model';

/**
 * PB8: the boards a board can stack: the saved versions of the Playground's other circuit
 * boards. A stacked board names an exact version by its content hash; a version that is gone,
 * changed or not a valid board is refused by code, and the 3D view says so.
 */
export function createPcbBoardSource(options: {
  records(): StoredArtifact[];
  /** The board's own Artifact, which cannot be stacked on itself. */
  self: string;
}): PcbBoardSource {
  return {
    async list() {
      return options
        .records()
        .filter((r) => r.kind === 'pcb' && r.id !== options.self && r.versions.length)
        .map((r) => ({
          artifactId: r.id,
          name: r.name,
          versions: [...r.versions].reverse().map((v, i, all) => ({
            versionId: v.versionId,
            label: `v${all.length - i}${v.reason ? ` — ${v.reason}` : ''}`,
            contentHash: v.contentHash,
          })),
        }));
    },
    async document(source) {
      if (source.artifactId === options.self) throw new Error('board-stack-self');
      const record = options.records().find((r) => r.id === source.artifactId && r.kind === 'pcb');
      const version = record?.versions.find((v) => v.versionId === source.versionId);
      if (!version || version.contentHash !== source.contentHash)
        throw new Error('board-source-missing');
      if (validatePcb(version.content).length) throw new Error('board-source-invalid');
      return version.content as unknown as PcbDocument;
    },
  };
}

/**
 * SL3b: the schematics a board can take parts and nets from: the saved versions of the
 * Playground's schematics. One exact version is read by its content hash; a version that is gone,
 * changed or not a valid schematic is refused by code.
 */
export function createPcbSchematicSource(options: {
  records(): StoredArtifact[];
}): PcbSchematicSource {
  return {
    async list() {
      return options
        .records()
        .filter((r) => r.kind === 'schematic' && r.versions.length)
        .map((r) => ({
          artifactId: r.id,
          name: r.name,
          versions: [...r.versions].reverse().map((v, i, all) => ({
            versionId: v.versionId,
            label: `v${all.length - i}${v.reason ? ` — ${v.reason}` : ''}`,
            contentHash: v.contentHash,
          })),
        }));
    },
    async document(ref) {
      const record = options
        .records()
        .find((r) => r.id === ref.artifactId && r.kind === 'schematic');
      const version = record?.versions.find((v) => v.versionId === ref.versionId);
      if (!version || version.contentHash !== ref.contentHash)
        throw new Error('schematic-source-missing');
      if (!isSchematicDocument(version.content)) throw new Error('schematic-source-invalid');
      return version.content;
    },
  };
}
