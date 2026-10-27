import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import {
  createAnimation2,
  createPreparedAnimationEmbed2,
  prepareAnimation2,
} from '@editor-platform/animation-core/v2';
import { time, type VideoContentV3 } from '@editor-platform/video-core';
import { v0EmptyFixture } from './v2-fixture';
import { v3Profile } from './v3';
import { createPortableProjects } from './versioned';
import { createProfileProject, type Project } from './project';
import { scan, memory } from '../io';
import { createZip, type Entry } from './zip64';
const signal = () => new AbortController().signal;
async function wire(entries: Entry[]) {
  const parts: Uint8Array[] = [];
  await createZip(scan).writeZip(
    entries,
    {
      write: async (b) => {
        parts.push(Uint8Array.from(b));
      },
    },
    signal(),
  );
  return memory(Uint8Array.from(Buffer.concat(parts)));
}
async function fixture(conflict = false): Promise<Project<VideoContentV3, never>> {
  const old = await v0EmptyFixture();
  const contents = [0, 1].map((i) => {
    const native = createAnimation2();
    native.compositions[0].name = 'Source ' + i;
    const prepared = prepareAnimation2(native);
    const embed = createPreparedAnimationEmbed2(
      {
        artifactId: 'animation',
        versionId: conflict ? 'v1' : 'v' + i,
        contentHash: prepared.contentHash,
        compositionId: 'root',
      },
      prepared,
      'Source',
    );
    return {
      schema: 'video-core-prototype-v3' as const,
      sources: [],
      sequence: {
        id: 'sequence',
        duration: time(4),
        frameRate: time(25),
        tracks: [{ id: 'visual', kind: 'visual' as const, enabled: true, locked: false }],
        clips: [
          {
            id: 'clip',
            kind: 'animation' as const,
            trackId: 'visual',
            start: time(0),
            duration: time(4),
            sourceIn: time(0),
            sourceOut: time(4),
            rate: time(1),
            embed,
          },
        ],
      },
    };
  });
  const versions = await Promise.all(
    contents.map(async (content, i) => ({
      ...old.versions[0],
      versionId: 'video' + i,
      parentVersionId: i ? 'video0' : null,
      content,
      contentHash: await contentHash(content),
    })),
  );
  return {
    ...old,
    plans: [],
    versions,
    selectedVersionId: 'video1',
    capture: { ...old.capture, contentHash: versions[1].contentHash },
  };
}
it('retains exact source snapshots across native history and old readers refuse the new profile', async () => {
  const project = await fixture();
  const archive = await wire(
    await createPortableProjects(scan).v3.prepareProject(project, signal()),
  );
  const reopened = await createPortableProjects(scan).open(archive, signal());
  expect(reopened.kind).toBe('v3');
  expect(reopened.project.versions).toEqual(project.versions);
  await expect(createPortableProjects(scan).v2.openProject(archive, signal())).rejects.toThrow();
  await expect(
    createPortableProjects(scan).v3.openProject(memory(new Uint8Array()), signal()),
  ).rejects.toThrow();
});
it('refuses contradictory immutable versions on both write and read despite valid outer hashes', async () => {
  const project = await fixture(true);
  await expect(createPortableProjects(scan).v3.prepareProject(project, signal())).rejects.toThrow();
  const malicious = await wire(
    await createProfileProject(scan, { ...v3Profile, validateHistory: undefined }).prepareProject(
      project,
      signal(),
    ),
  );
  await expect(createPortableProjects(scan).v3.openProject(malicious, signal())).rejects.toThrow();
});

it('refuses a valid legacy v0 archive without changing its bytes', async () => {
  const formats = createPortableProjects(scan);
  const archive = await wire(await formats.v0.prepareProject(await v0EmptyFixture(), signal()));
  const before = await scan(archive, signal());
  await expect(formats.v3.openProject(archive, signal())).rejects.toThrow();
  expect(await scan(archive, signal())).toEqual(before);
  expect((await formats.open(archive, signal())).kind).toBe('v0');
});
