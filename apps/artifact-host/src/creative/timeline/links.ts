/**
 * Story Timeline T2: the explicit move of a v1 Scene reference table to v2
 * (t0-contract.md §4.2, §4.3). The v2 writer is enabled only for a store whose reader is
 * declared to read v2; a store that cannot read what is written gets nothing written.
 */
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import {
  readWorkspaceLinks,
  type CreativeWorkspaceLinksV1,
  type CreativeWorkspaceLinksV2,
} from '../workspace/model';
import type { StoryBinding } from '../workspace/story-links';
import { TimelineEditError } from './commands';

export interface TimelineLinksStore {
  readLinks(): unknown | Promise<unknown>;
  /** The store compares `expected` and writes atomically (the existing workspace contract). */
  writeLinks(next: CreativeWorkspaceLinksV2, expected: unknown): Promise<void>;
  /** The schema versions this store's reader reads. v2 is written only when it is listed. */
  readonly readerVersions: readonly number[];
  /** Keeps the v1 document before it is replaced (the Host's existing retention). */
  retain(previous: CreativeWorkspaceLinksV1): Promise<void>;
}

/**
 * `migrateLinksToV2(expected)`: binds the Story and writes v2 once, by compare-and-set
 * against the v1 document the author saw. `scenes`, `world` and `returnTo` keep their v1
 * meaning; there are no occurrence links yet. Nothing is inferred: the binding is given, and
 * a stored document other than `expected` (another tab, an earlier migration) is refused.
 */
export async function migrateLinksToV2(
  store: TimelineLinksStore,
  expected: CreativeWorkspaceLinksV1,
  story: StoryBinding,
): Promise<CreativeWorkspaceLinksV2> {
  if (!store.readerVersions.includes(2))
    throw new TimelineEditError(
      'この保存先はScene参照表の版2を読めないため、移行しません。保存データは変えていません。',
    );
  const stored = await store.readLinks();
  if (canonicalJson(stored) !== canonicalJson(expected))
    throw new TimelineEditError(
      'Scene参照表が外部で変わりました。読み直してから移行してください。保存データは変えていません。',
    );
  const v1 = readWorkspaceLinks(stored);
  if (v1.schemaVersion !== 1)
    throw new TimelineEditError('Scene参照表は既に版2です。移行は一度だけ行います。');
  const next = readWorkspaceLinks({
    ...clone(v1),
    schemaVersion: 2,
    story: clone(story),
    occurrenceLinks: [],
  }) as CreativeWorkspaceLinksV2;
  await store.retain(clone(v1));
  await store.writeLinks(next, expected);
  return next;
}
