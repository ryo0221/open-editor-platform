import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { sameLocalRevision } from '@editor-platform/editor-core';
import { validateFictionMap, type FictionMapBase, type FictionMapSession } from './model';
/** Admit a public Session read once when adopting a revision. A clone alone is no proof. */
export function adoptFictionMapBase(
  session: Pick<FictionMapSession, 'content' | 'revision'>,
): FictionMapBase {
  const revision = session.revision,
    read = session.content,
    result = validateFictionMap(read);
  if (!result.ok)
    throw new Error(`Invalid Fiction Map: ${result.diagnostic.code} ${result.diagnostic.path}`);
  if (
    !sameLocalRevision(revision, session.revision) ||
    canonicalJson(session.content) !== canonicalJson(result.value)
  )
    throw new Error('Fiction Map changed while adopting its owned snapshot');
  return { content: result.value, revision };
}

import type { Artifact } from '@editor-platform/artifact-core';
import { loadHostArtifact, type EditorHostAdapter } from '@editor-platform/editor-host';
import type { FictionMapContent } from './model';
import { readJson } from './json';
/** Schema 1 envelope and every native v1 draft/version are independently admitted. */
export const fictionMapHostAdapter: EditorHostAdapter<FictionMapContent> = {
  kind: 'fiction-map',
  validate: (v): v is FictionMapContent => validateFictionMap(v).ok,
  async preflight(artifact) {
    for (const value of [artifact.draft.content, ...artifact.versions.map((v) => v.content)]) {
      const r = validateFictionMap(value);
      if (!r.ok) throw Error(`Invalid Fiction Map: ${r.diagnostic.code}`);
    }
    for (const version of artifact.versions)
      if ((await contentHash(version.content)) !== version.contentHash)
        throw Error('Fiction Map version hash mismatch');
  },
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
  },
};
export async function parseFictionMapArtifact(json: string): Promise<Artifact<FictionMapContent>> {
  readJson(json, { inputBytes: 16 * 1024 * 1024, values: 1_000_000, depth: 16 });
  return loadHostArtifact(json, fictionMapHostAdapter);
}
export async function verifyFictionMapArtifact(artifact: Artifact<unknown>): Promise<void> {
  for (const native of [artifact.draft.content, ...artifact.versions.map((v) => v.content)]) {
    const r = validateFictionMap(native);
    if (!r.ok) throw Error(`Invalid Fiction Map: ${r.diagnostic.code}`);
  }
  await parseFictionMapArtifact(JSON.stringify(artifact));
}
