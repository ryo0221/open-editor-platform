import { expect, it } from 'vitest';
import { canonicalJson, clone, contentHash } from '@editor-platform/artifact-core';
import {
  ReferenceError,
  ReferenceResolver,
  type EmbeddedReference,
  type ReferenceHost,
  type ReferenceSnapshot,
  type ReferenceSource,
} from '@editor-platform/artifact-references';
import { createData } from '@editor-platform/structured-data';
import { createRelationGraph, relationProfile } from '@editor-platform/structured-graph/model';
import { nativeReferenceAdapters } from './index';

async function dataSnapshot(revision: number, value = revision): Promise<ReferenceSnapshot> {
  const content = createData();
  content.columns = [{ id: 'value', name: 'Value', type: 'number' }];
  content.rows = [{ id: 'row', values: { value } }];
  return {
    artifactId: 'data',
    domain: 'data',
    versionId: `v${revision}`,
    revision,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
}
function fixture(initial: ReferenceSnapshot) {
  let current = initial;
  const source: ReferenceSource = {
    artifactId: initial.artifactId,
    domain: initial.domain,
    target: {
      kind: initial.domain === 'data' ? 'table' : 'graph',
      viewId: initial.domain === 'data' ? 'default' : (initial.content as { id: string }).id,
    },
  };
  const host: ReferenceHost = {
    list: async () => [],
    read: async () => current,
    subscribe: () => () => {},
  };
  const resolver = new ReferenceResolver(host, nativeReferenceAdapters, 'destination');
  const retained = (snapshot: ReferenceSnapshot, mode: 'fixed' | 'follow' = 'fixed') =>
    ({ schemaVersion: 1, source, mode, fit: 'contain', snapshot }) satisfies EmbeddedReference;
  return {
    host,
    resolver,
    source,
    retained,
    set: (snapshot: ReferenceSnapshot) => (current = snapshot),
  };
}

for (const path of ['refresh', 'capture', 'create'] as const) {
  it(`keeps rejected rollback identities out of historical rendering and export (${path})`, async () => {
    const old = await dataSnapshot(1);
    const h = fixture(await dataSnapshot(2));
    const follow = await h.resolver.create(h.source, 'follow');
    h.set(await dataSnapshot(1, 999));
    if (path === 'refresh') expect((await h.resolver.refresh(follow)).status).toBe('stale');
    else
      await expect(
        path === 'create'
          ? h.resolver.create(h.source, 'follow')
          : h.resolver.capture([{ id: 'image', reference: follow }]),
      ).rejects.toMatchObject({ status: 'stale' });
    const fixed = h.retained(old);
    expect((await h.resolver.refresh(fixed)).status).toBe('ready');
    expect(
      canonicalJson(
        (await h.resolver.capture([{ id: 'old', reference: fixed }], false))[0].reference,
      ),
    ).toBe(canonicalJson(fixed));
    h.set(await dataSnapshot(3));
    expect((await h.resolver.refresh(follow)).snapshot?.revision).toBe(3);
  });
  it(`does not retain a response rejected by the post-read access check (${path})`, async () => {
    const original = await dataSnapshot(1);
    const h = fixture(await dataSnapshot(1, 999));
    let checks = 0;
    h.host.checkAccess = () => {
      if (++checks === 2) throw new ReferenceError('forbidden', 'Access changed after read');
    };
    if (path === 'refresh')
      expect((await h.resolver.refresh(h.retained(original, 'follow'))).status).toBe('forbidden');
    else
      await expect(
        path === 'create'
          ? h.resolver.create(h.source, 'follow')
          : h.resolver.capture([{ id: 'image', reference: h.retained(original, 'follow') }]),
      ).rejects.toMatchObject({ status: 'forbidden' });
    h.host.checkAccess = () => {};
    h.set(original);
    expect((await h.resolver.create(h.source, 'fixed')).snapshot).toEqual(original);
  });
}

it('does not retain the identity of a superseded refresh response', async () => {
  const h = fixture(await dataSnapshot(1));
  const follow = await h.resolver.create(h.source, 'follow');
  let release!: (snapshot: ReferenceSnapshot) => void;
  let reads = 0;
  h.host.read = () => {
    reads++;
    return new Promise((resolve) => (release = resolve));
  };
  const pending = h.resolver.refresh(follow);
  await expect.poll(() => reads).toBe(1);
  h.host.read = async () => dataSnapshot(3);
  expect((await h.resolver.refresh(follow)).snapshot?.revision).toBe(3);
  release(await dataSnapshot(2, 999));
  expect((await pending).snapshot?.revision).toBe(3);
  expect((await h.resolver.refresh(h.retained(await dataSnapshot(2)))).status).toBe('ready');
});

async function graphSnapshot(
  revision = 1,
  profile = clone(relationProfile),
): Promise<ReferenceSnapshot> {
  const content = createRelationGraph();
  content.id = 'graph-view';
  content.profile.version = profile.version;
  return {
    artifactId: 'graph',
    domain: 'structured-graph',
    revision,
    versionId: `v${revision}`,
    content,
    contentHash: await contentHash(content),
    dependencies: [
      {
        id: `profile:${profile.id}:${profile.version}`,
        content: profile,
        contentHash: await contentHash(profile),
      },
    ],
  };
}
for (const path of ['refresh', 'capture', 'create', 'validate', 'history'] as const) {
  it(`rejects changed Profile bytes under one dependency ID across source versions (${path})`, async () => {
    const original = await graphSnapshot();
    const h = fixture(original);
    const follow = await h.resolver.create(h.source, 'follow');
    const changedProfile = clone(relationProfile);
    changedProfile.nodes.entity.ui = { label: 'Changed', labelField: 'category' };
    const changed = await graphSnapshot(2, changedProfile);
    expect(changed.contentHash).toBe(original.contentHash);
    expect(changed.dependencies[0].contentHash).not.toBe(original.dependencies[0].contentHash);
    nativeReferenceAdapters.find((a) => a.domain === changed.domain)!.validate(changed);
    h.set(changed);
    if (path === 'refresh') expect((await h.resolver.refresh(follow)).status).toBe('stale');
    else {
      const operation =
        path === 'create'
          ? h.resolver.create(h.source, 'follow')
          : path === 'validate'
            ? h.resolver.validate(changed, h.source)
            : path === 'history'
              ? h.resolver.forDestination('imported').capture(
                  [
                    { id: 'original', reference: h.retained(original) },
                    { id: 'changed', reference: h.retained(changed) },
                  ],
                  false,
                )
              : h.resolver.capture([{ id: 'image', reference: follow }]);
      await expect(operation).rejects.toMatchObject({ status: 'stale' });
    }
    // Rejection must not consume revision/version 2; the exact old Profile remains valid.
    h.set({ ...original, revision: 2, versionId: 'v2' });
    expect((await h.resolver.create(h.source, 'follow')).snapshot.revision).toBe(2);
    expect((await h.resolver.refresh(h.retained(original))).snapshot).toEqual(original);
    // A newly published Profile version has a new immutable dependency identity.
    changedProfile.version++;
    const next = await graphSnapshot(3, changedProfile);
    h.set(next);
    expect((await h.resolver.refresh(follow)).snapshot).toEqual(next);
  });
}
it('shares an immutable Profile identity across Graph artifacts in the same resolver', async () => {
  const original = await graphSnapshot();
  const h = fixture(original);
  await h.resolver.validate(original, h.source);
  const other = { ...original, artifactId: 'other-graph' };
  const otherSource = { ...h.source, artifactId: other.artifactId };
  await expect(h.resolver.validate(other, otherSource)).resolves.toEqual(other);
  const changedProfile = clone(relationProfile);
  changedProfile.nodes.entity.ui = { labelField: 'category' };
  const changed = { ...(await graphSnapshot(2, changedProfile)), artifactId: other.artifactId };
  await expect(h.resolver.validate(changed, otherSource)).rejects.toMatchObject({
    status: 'stale',
  });
});

for (const path of ['refresh', 'capture'] as const) {
  for (const conflict of ['revision', 'version', 'dependency'] as const) {
    it(`compares a fresh resolver's retained identity before live ${path} (${conflict})`, async () => {
      const original = await graphSnapshot();
      const h = fixture(original);
      const follow = h.retained(original, 'follow');
      const before = canonicalJson(follow);
      const profile = clone(relationProfile);
      profile.nodes.entity.ui = { label: 'Changed', labelField: 'category' };
      const changed = await graphSnapshot(conflict === 'revision' ? 1 : 2, profile);
      if (conflict === 'revision') changed.versionId = 'other-v1';
      if (conflict === 'version') changed.versionId = original.versionId;
      h.set(changed);
      if (path === 'refresh') {
        const result = await h.resolver.refresh(follow);
        expect(result.status).toBe('stale');
        expect(result.projection).toBeUndefined();
      } else
        await expect(
          h.resolver.capture([{ id: 'image', reference: follow }]),
        ).rejects.toMatchObject({
          status: 'stale',
        });
      expect(canonicalJson(follow)).toBe(before);
      // The rejected live identity must not consume a version or dependency identity.
      expect((await h.resolver.refresh(h.retained(original))).snapshot).toEqual(original);
      h.set({ ...original, revision: 2, versionId: 'v2' });
      expect((await h.resolver.refresh(follow)).snapshot?.revision).toBe(2);
      profile.version++;
      h.set(await graphSnapshot(3, profile));
      expect((await h.resolver.refresh(follow)).snapshot?.revision).toBe(3);
    });
  }
  it(`accepts a valid newer version from a fresh resolver during ${path}`, async () => {
    const original = await dataSnapshot(1, 95);
    const latest = await dataSnapshot(2, 80);
    const h = fixture(latest);
    const follow = h.retained(original, 'follow');
    if (path === 'refresh') expect((await h.resolver.refresh(follow)).snapshot).toEqual(latest);
    else
      expect(
        (await h.resolver.capture([{ id: 'image', reference: follow }]))[0].reference?.snapshot,
      ).toEqual(latest);
    expect((await h.resolver.refresh(h.retained(original))).snapshot).toEqual(original);
  });
}
