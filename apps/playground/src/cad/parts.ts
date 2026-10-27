/**
 * The Playground's retained part closure (docs/cad/r2b-assembly.md, 部品の版の保持; R2b-U3): every
 * saved version an assembly's draft or versions place, nested ones included, kept by content
 * hash beside the Artifact envelope and carried in its native file.
 */
import {
  cadContentHash,
  expandAssembly,
  isCadDocument,
  type CadDocument,
} from '@editor-platform/cad-core';
import type { CadPartSourceHost, CadPartStore } from '@editor-platform/cad';
import type { StoredArtifact } from '../model';
import { decodeBytes } from './resources';

/** One retained version: its content and the hash it is named by. */
export interface CadPartRecord {
  contentHash: string;
  content: CadDocument;
}

const roots = (record: Pick<StoredArtifact, 'draft' | 'versions'>) =>
  [record.draft.content, ...record.versions.map((v) => v.content)] as CadDocument[];
/**
 * Versions reachable from the draft and every version through `cadParts`, by hash. Hashes the
 * record does not keep are listed in `missing`.
 */
export function cadPartClosure(record: Pick<StoredArtifact, 'draft' | 'versions' | 'cadParts'>) {
  const kept = new Map((record.cadParts ?? []).map((p) => [p.contentHash, p.content]));
  const reached = new Map<string, CadDocument>();
  const missing = new Set<string>();
  const visit = (doc: CadDocument) => {
    for (const part of doc.parts ?? []) {
      const hash = part.source.contentHash;
      if (reached.has(hash) || missing.has(hash)) continue;
      const content = kept.get(hash);
      if (!content) missing.add(hash);
      else {
        reached.set(hash, content);
        visit(content);
      }
    }
  };
  roots(record).forEach(visit);
  return { reached, missing };
}

/**
 * Native import and stored-record check: each retained version is valid CAD content whose hash
 * is the one it is kept under, once; the closure is exact (every placed version is kept, nothing
 * else is), and every saved content expands within the instance, depth and closure-version
 * limits.
 */
export function validateCadParts(record: StoredArtifact) {
  const parts = record.cadParts ?? [];
  if (!Array.isArray(parts)) throw new Error('CAD parts');
  const seen = new Set<string>();
  for (const p of parts) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join() !== 'content,contentHash' ||
      typeof p.contentHash !== 'string'
    )
      throw new Error('CAD part');
    if (seen.has(p.contentHash)) throw new Error('CAD part duplicated');
    seen.add(p.contentHash);
    if (!isCadDocument(p.content)) throw new Error('CAD part content');
    if (cadContentHash(p.content) !== p.contentHash) throw new Error('CAD part hash mismatch');
  }
  const { reached, missing } = cadPartClosure(record);
  if (missing.size) throw new Error('CAD part missing');
  if (reached.size !== parts.length) throw new Error('CAD part not referenced');
  // Each document's own counts are checked by its validation; the expansion (instances, depth
  // and the versions one content reaches, as an edit is admitted) only with the closure. The
  // record may keep more versions in all: each saved content is within the limit by itself.
  for (const doc of roots(record))
    if (expandAssembly(doc, (h) => reached.get(h)).limit) throw new Error('CAD parts limit');
}

/** The retained versions of a record written from `saved` while `latest` may have staged more. */
export function mergeCadParts(
  saved: { cadParts?: CadPartRecord[] },
  latest: { cadParts?: CadPartRecord[] },
): { cadParts?: CadPartRecord[] } {
  if (!saved.cadParts && !latest.cadParts) return {};
  const merged = [...(latest.cadParts ?? [])];
  for (const p of saved.cadParts ?? [])
    if (!merged.some((m) => m.contentHash === p.contentHash)) merged.push(p);
  return { cadParts: merged };
}

/**
 * The Surface's closure store over one stored record: versions are stored (with their asset
 * bytes, through the asset store) and saved before an edit names them.
 */
export function createCadPartStore(options: {
  record(): StoredArtifact | undefined;
  persist(record: StoredArtifact): Promise<boolean>;
  stageAssets(assets: Parameters<CadPartStore['stage']>[1]): Promise<void>;
}): CadPartStore {
  return {
    get(contentHash) {
      return options.record()?.cadParts?.find((p) => p.contentHash === contentHash)?.content;
    },
    async stage(versions, assets) {
      if (assets.length) await options.stageAssets(assets);
      const record = options.record();
      if (!record) throw new Error('（保存先の文書がありません）');
      const parts = [...(record.cadParts ?? [])];
      for (const content of versions) {
        const contentHash = cadContentHash(content);
        if (!parts.some((p) => p.contentHash === contentHash)) parts.push({ contentHash, content });
      }
      if (!(await options.persist({ ...record, cadParts: parts })))
        throw new Error('（ブラウザへの保存に失敗しました）');
    },
  };
}

/**
 * The Playground's part source: the saved versions of its other `cad` Artifacts. Every local
 * record is readable here, so access is always granted; a version's closure and asset bytes
 * come from that Artifact's own record.
 */
export function createCadPartSource(options: {
  records(): StoredArtifact[];
  currentId: string;
  open(artifactId: string): void;
}): CadPartSourceHost {
  const find = (id: string) => options.records().find((r) => r.id === id && r.kind === 'cad');
  return {
    async list() {
      return options
        .records()
        .filter((r) => r.kind === 'cad' && r.id !== options.currentId && r.versions.length)
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
    async readVersion(artifactId, versionId) {
      const record = find(artifactId);
      const version = record?.versions.find((v) => v.versionId === versionId);
      if (!record || !version) throw new Error('part-source-missing');
      const content = version.content as unknown as CadDocument;
      const { reached } = cadPartClosure({
        draft: { ...record.draft, content: content as never },
        versions: [],
        cadParts: record.cadParts,
      });
      const assets = [content, ...reached.values()].flatMap((doc) =>
        doc.assets.map((ref) => {
          const r = record.cadResources?.find(
            (x) => x.kind === ref.kind && x.sha256 === ref.sha256,
          );
          if (!r) throw new Error('part-source-missing');
          return { ref, bytes: decodeBytes(r.bytes) };
        }),
      );
      return { content, contentHash: version.contentHash, closure: [...reached.values()], assets };
    },
    versionLabel(artifactId, versionId) {
      const versions = find(artifactId)?.versions ?? [];
      const i = versions.findIndex((v) => v.versionId === versionId);
      return i < 0 ? undefined : `v${i + 1}`;
    },
    // The newest saved version, only to show that one exists (R2b-2b); never taken in itself.
    latestVersion(artifactId) {
      const versions = find(artifactId)?.versions ?? [];
      const last = versions[versions.length - 1];
      return (
        last && {
          versionId: last.versionId,
          contentHash: last.contentHash,
          label: `v${versions.length}${last.reason ? ` — ${last.reason}` : ''}`,
        }
      );
    },
    // Local records have no permissions; deleting a part's Artifact does not revoke the
    // closure an assembly retains (R2b-U3).
    checkAccess: () => true,
    open: (artifactId) => options.open(artifactId),
  };
}
