/**
 * Builds the F0 Story Timeline sample for the reading pages (T1b). The artifacts and links
 * equal docs/story-timeline/fixtures/f0.json; hashes are recomputed and checked so a
 * mismatch is refused instead of stored.
 */
import {
  canonicalJson,
  contentHash,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import { readWorkspaceLinks, type CreativeWorkspaceLinksV2 } from '../workspace/model';
import { F0_SAMPLE } from './sample-f0';

type SampleArtifact = (typeof F0_SAMPLE.artifacts)[number];

export async function buildF0Sample(): Promise<{
  artifacts: Artifact<unknown>[];
  links: CreativeWorkspaceLinksV2;
}> {
  const artifacts: Artifact<unknown>[] = [];
  for (const s of F0_SAMPLE.artifacts as SampleArtifact[]) {
    const content = structuredClone(s.content) as unknown;
    if ((await contentHash(content)) !== s.contentHash)
      throw Error(`見本 ${s.id} のhashが一致しません。`);
    const { version, draft, content: _c, contentHash: hash, ...meta } = s;
    void _c;
    artifacts.push({
      ...structuredClone(meta),
      draft: { ...structuredClone(draft), content: structuredClone(content) },
      versions: [{ ...structuredClone(version), content, contentHash: hash }],
    } as unknown as Artifact<unknown>);
  }
  const links = readWorkspaceLinks(structuredClone(F0_SAMPLE.links)) as CreativeWorkspaceLinksV2;
  return { artifacts, links };
}

/**
 * Writes the sample. Refuses when links already exist, and never overwrites an existing
 * artifact with the same ID: each artifact is created with the storage's atomic
 * `putIfAbsent`, so another tab creating the same ID meanwhile is kept, never replaced. An
 * existing artifact equal to the sample's (left by an earlier attempt whose links write
 * failed) is kept as it is, so a retry finishes the sample instead of being refused forever.
 * The links are written only when every artifact is the sample's.
 */
export async function createF0Sample(io: {
  artifacts: StorageAdapter<Artifact<unknown>>;
  readLinks(): CreativeWorkspaceLinksV2 | undefined;
  writeLinks(links: CreativeWorkspaceLinksV2): Promise<void>;
}) {
  if (io.readLinks()) throw Error('対応表は既にあります。見本で上書きしません。');
  const putIfAbsent = io.artifacts.putIfAbsent?.bind(io.artifacts);
  if (!putIfAbsent) throw Error('保存先が「無ければ作る」に対応していないため、見本を作れません。');
  const { artifacts, links } = await buildF0Sample();
  for (const a of artifacts) {
    const stored = await putIfAbsent(a);
    if (canonicalJson(stored) !== canonicalJson(a))
      throw Error(`${a.id} は既にあります。見本で上書きしません。`);
  }
  await io.writeLinks(links);
  return links;
}
