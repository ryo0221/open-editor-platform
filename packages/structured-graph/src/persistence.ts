import { contentHash, deserializeArtifact, type Artifact } from '@editor-platform/artifact-core';
import { readGraphDocument, type GraphDocument } from './model';
import { assertGraph, type GraphProfile } from './profile';
export type ProfileResolver = (id: string, version: number) => GraphProfile | undefined;
export const graphArtifactByteLimit = 16_000_000;
/** Inspect metadata before materializing file text; direct text callers remain bounded too. */
export async function readGraphArtifactFile(
  file: { readonly size: number; text(): Promise<string> },
  resolve: ProfileResolver,
): Promise<Artifact<GraphDocument>> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > graphArtifactByteLimit)
    throw new Error('Graph import exceeds 16 MB or has invalid file size');
  return readGraphArtifact(await file.text(), resolve);
}
/** Validate every retained native version before the Host stores anything. */
export async function readGraphArtifact(
  text: string,
  resolve: ProfileResolver,
): Promise<Artifact<GraphDocument>> {
  if (
    text.length > graphArtifactByteLimit ||
    new TextEncoder().encode(text).length > graphArtifactByteLimit
  )
    throw new Error('Graph import exceeds 16 MB');
  const artifact = deserializeArtifact(text);
  if (artifact.kind !== 'structured-graph') throw new Error('Expected a Structured Graph artifact');
  // Older schemas are read as the current one. Versions keep their stored bytes (and hashes);
  // read their content with `readGraphDocument`. The draft is returned as the current schema.
  const check = (value: unknown) => {
    const graph = readGraphDocument(value);
    const profile = resolve(graph.profile.id, graph.profile.version);
    if (!profile) throw new Error('Unknown or missing Graph Profile');
    assertGraph(graph, profile);
    return graph;
  };
  const draft = check(artifact.draft.content);
  for (const version of artifact.versions) {
    check(version.content);
    if ((await contentHash(version.content)) !== version.contentHash)
      throw new Error('Graph version content hash mismatch');
  }
  return {
    ...artifact,
    draft: { ...artifact.draft, content: draft },
  } as Artifact<GraphDocument>;
}
