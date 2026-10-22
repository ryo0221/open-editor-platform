/** Native JSON import for Schedule artifacts: the envelope, the draft and every retained
 * version are validated and hash-checked before anything is stored. */
import { contentHash, deserializeArtifact, type Artifact } from '@editor-platform/artifact-core';
import { assertSchedule, ScheduleError, type ScheduleDocument } from './model';

export async function readScheduleArtifact(text: string): Promise<Artifact<ScheduleDocument>> {
  const artifact = deserializeArtifact(text);
  if (artifact.kind !== 'schedule')
    throw new ScheduleError('invalid', `Unsupported artifact kind ${artifact.kind}`);
  assertSchedule(artifact.draft.content);
  await assertLaneHashes(artifact.draft.content);
  for (const version of artifact.versions) {
    assertSchedule(version.content);
    if ((await contentHash(version.content)) !== version.contentHash)
      throw new ScheduleError('invalid', 'A saved version does not match its hash');
    await assertLaneHashes(version.content);
  }
  return artifact as Artifact<ScheduleDocument>;
}

/** The outer hash covers the lane envelopes, not whether each embedded snapshot matches its own
 * declared hash: check those too, so a broken lane is refused before anything is stored. */
async function assertLaneHashes(content: ScheduleDocument) {
  for (const lane of content.lanes) {
    const { snapshot } = lane.reference;
    if ((await contentHash(snapshot.content)) !== snapshot.contentHash)
      throw new ScheduleError('invalid', `Lane ${lane.id} does not match its snapshot hash`);
    for (const dependency of snapshot.dependencies)
      if ((await contentHash(dependency.content)) !== dependency.contentHash)
        throw new ScheduleError(
          'invalid',
          `Lane ${lane.id} has a dependency that does not match its hash`,
        );
  }
}
