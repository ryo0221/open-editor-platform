import { contentHash, deserializeArtifact, type Artifact } from '@editor-platform/artifact-core';
import { assertGraphDocument, type GraphDocument } from './model';
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
  const check = (value: unknown) => {
    assertGraphDocument(value);
    const profile = resolve(value.profile.id, value.profile.version);
    if (!profile) throw new Error('Unknown or missing Graph Profile');
    assertGraph(value, profile);
  };
  check(artifact.draft.content);
  for (const version of artifact.versions) {
    check(version.content);
    if ((await contentHash(version.content)) !== version.contentHash)
      throw new Error('Graph version content hash mismatch');
  }
  return artifact as Artifact<GraphDocument>;
}
