import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import {
  operation,
  proposal,
  type ConfirmedVersion,
  type Identity,
  type Receipt,
  type Snapshot,
} from '@editor-platform/collaboration-core';
import { setField, slideCodec } from '@editor-platform/collaboration-adapters';
import { slideFixture } from '@editor-platform/collaboration-adapters/fixtures';
import { createReferenceServer } from './server';

type Slide = ReturnType<typeof slideFixture>;
const server = createReferenceServer();
let base = '';
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/collaboration-api`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call<T = unknown>(
  path: string,
  options: { token?: string; body?: unknown; method?: string; raw?: string } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined && !options.raw ? 'GET' : 'POST'),
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}
async function join(actor: string, room: string) {
  const { status, body } = await call<{ token: string; identity: Identity }>('/session', {
    body: { actor, room },
  });
  expect(status).toBe(200);
  return { ...body, principal: { ...body.identity, writable: true, scopes: ['*'] } };
}
const slide = (path: string) => `${path}${path.includes('?') ? '&' : '?'}domain=slide`;
async function snapshot(token: string) {
  return (await call<Snapshot<Slide>>(slide('/snapshot'), { token })).body;
}
async function submitFill(who: Awaited<ReturnType<typeof join>>, target: string, value: string) {
  const op = operation(slideCodec, await snapshot(who.token), who.identity, [
    setField(target, 'fill', value),
  ]);
  return (await call<Receipt>(slide('/submit'), { token: who.token, body: op })).body;
}
const fill = (state: Snapshot<Slide>, id: string) =>
  state.content.slides[0].objects.find((o) => o.id === id)?.fill;

describe('reference sessions and request boundary', () => {
  it('reports health and refuses invalid identities, rooms and missing sessions', async () => {
    expect(await call('/health')).toEqual({ status: 200, body: { ready: true, durable: false } });
    for (const body of [
      { actor: 'Z', room: 'ok' },
      { actor: 'A', room: 'bad room' },
      { actor: 'A', room: 1 },
    ])
      expect(await call('/session', { body })).toMatchObject({
        status: 400,
        body: { code: 'unauthorized' },
      });
    expect(await call(slide('/snapshot'))).toMatchObject({
      status: 400,
      body: { code: 'unauthorized' },
    });
    expect(await call(slide('/snapshot'), { token: 'forged' })).toMatchObject({ status: 400 });
  });
  it('binds requests to the session room domain and supported endpoints', async () => {
    const a = await join('A', 'boundary');
    expect(await call('/snapshot?domain=missing', { token: a.token })).toMatchObject({
      status: 400,
      body: { code: 'schema-mismatch' },
    });
    expect((await snapshot(a.token)).artifactId).toBe('boundary:slide');
    expect(await call(slide('/changes?after=-1'), { token: a.token })).toMatchObject({
      status: 400,
      body: { code: 'schema-mismatch' },
    });
    expect((await call(slide('/changes?after=0'), { token: a.token })).body).toEqual({
      events: [],
    });
    expect((await call(slide('/permissions'), { token: a.token })).body).toEqual(a.principal);
    expect((await call(slide('/receipt?id=none'), { token: a.token })).body).toBeNull();
    expect((await call(slide('/proposal?id=none'), { token: a.token })).body).toBeNull();
    for (const [path, method] of [
      ['/unknown', 'GET'],
      ['/unknown', 'POST'],
      ['/snapshot', 'PUT'],
    ])
      expect(
        await call(slide(path), {
          token: a.token,
          method,
          raw: method === 'GET' ? undefined : '{}',
        }),
      ).toMatchObject({ status: 400, body: { code: 'unsupported-operation' } });
    expect(await call(slide('/submit'), { token: a.token, raw: '{' })).toMatchObject({
      status: 400,
      body: { code: 'invalid-operation' },
    });
    expect(
      await call(slide('/submit'), { token: a.token, raw: 'x'.repeat(1_100_001) }),
    ).toMatchObject({ status: 400, body: { code: 'schema-mismatch' } });
  });
});

describe('shared edits through the reference Host', () => {
  it('commits, broadcasts changes, keeps actor/session Undo and maps presence', async () => {
    const a = await join('A', 'edits'),
      b = await join('B', 'edits');
    const receipt = await submitFill(a, 'shape1', '#123456');
    expect(receipt).toMatchObject({ status: 'accepted', revision: 1 });
    const changes = (
      await call<{ events: { revision: number }[] }>(slide('/changes?after=0'), { token: b.token })
    ).body;
    expect(changes.events.map((e) => e.revision)).toEqual([1]);
    expect(
      (await call(slide(`/receipt?id=${receipt.operationId}`), { token: b.token })).body,
    ).toMatchObject({ status: 'accepted' });
    expect(
      (await call<Receipt>(slide('/undo'), { token: b.token, body: { id: receipt.operationId } }))
        .body,
    ).toMatchObject({ status: 'rejected', code: 'unauthorized' });
    expect(
      (await call<Receipt>(slide('/undo'), { token: a.token, body: { id: receipt.operationId } }))
        .body,
    ).toMatchObject({ status: 'accepted', revision: 2 });
    expect(fill(await snapshot(b.token), 'shape1')).not.toBe('#123456');
    const presence = await call<{ actorId: string }[]>(slide('/presence'), {
      token: a.token,
      body: { value: { name: 'A', color: '#112233' } },
    });
    expect(presence.body.map((p) => p.actorId)).toEqual(['A']);
    expect((await call<unknown[]>(slide('/presence'), { token: b.token })).body).toHaveLength(1);
    expect((await call(slide('/close'), { token: a.token, body: {} })).body).toEqual({
      closed: true,
    });
    expect((await call<unknown[]>(slide('/presence'), { token: b.token })).body).toHaveLength(0);
  });
  it('rejects a whole-content restore smuggled through submit', async () => {
    const a = await join('A', 'smuggle'),
      b = await join('B', 'smuggle');
    const original = await snapshot(a.token);
    await submitFill(a, 'shape1', '#abcdef');
    const forged = operation(
      slideCodec,
      await snapshot(b.token),
      b.identity,
      [{ type: 'domain.restore', target: '*', payload: { content: original.content } }],
      'restore',
    );
    expect(
      (await call<Receipt>(slide('/submit'), { token: b.token, body: forged })).body,
    ).toMatchObject({ status: 'rejected' });
    const agent = operation(
      slideCodec,
      await snapshot(b.token),
      b.identity,
      [setField('shape2', 'fill', '#000000')],
      'agent',
    );
    expect(
      (await call<Receipt>(slide('/submit'), { token: b.token, body: agent })).body,
    ).toMatchObject({ status: 'rejected', code: 'unauthorized' });
    expect(fill(await snapshot(a.token), 'shape1')).toBe('#abcdef');
  });
});

describe('proposals through the reference Host', () => {
  async function registered(room: string) {
    const a = await join('A', room),
      c = await join('C', room);
    const state = await snapshot(c.token);
    const p = proposal(
      { snapshot: () => state, codec: slideCodec } as never,
      'C',
      [setField('shape2', 'fill', '#aabbcc')],
      null,
      'Agent fill',
    );
    expect(await call(slide('/proposal/register'), { token: a.token, body: p })).toMatchObject({
      status: 400,
      body: { code: 'unauthorized' },
    });
    expect(
      (await call<{ state: string }>(slide('/proposal/register'), { token: c.token, body: p })).body
        .state,
    ).toBe('ready');
    return { a, c, p };
  }
  it('previews and applies with source attribution, and keeps the reserved ID', async () => {
    const { a, c, p } = await registered('proposal-apply');
    const squat = {
      ...operation(slideCodec, await snapshot(a.token), a.identity, [
        setField('shape1', 'fill', '#999999'),
      ]),
      operationId: `proposal:${p.id}`,
    };
    expect(
      (await call<Receipt>(slide('/submit'), { token: a.token, body: squat })).body,
    ).toMatchObject({ status: 'rejected', code: 'protocol-error' });
    const preview = (
      await call<{ token: string }>(slide('/proposal/preview'), {
        token: a.token,
        body: { id: p.id },
      })
    ).body;
    const applied = (
      await call<Receipt>(slide('/proposal/apply'), {
        token: a.token,
        body: { id: p.id, token: preview.token },
      })
    ).body;
    expect(applied).toMatchObject({ status: 'accepted', operationId: `proposal:${p.id}` });
    expect(fill(await snapshot(c.token), 'shape2')).toBe('#aabbcc');
    expect(
      (await call<{ state: string }>(slide(`/proposal?id=${p.id}`), { token: c.token })).body.state,
    ).toBe('applied');
  });
  it('lets the source withdraw and a writer reject, but not a read-only editor session', async () => {
    const { a, c, p } = await registered('proposal-cancel');
    expect(
      (
        await call<{ state: string }>(slide('/proposal/cancel'), {
          token: a.token,
          body: { id: p.id, reject: true },
        })
      ).body.state,
    ).toBe('rejected');
    const again = await registered('proposal-withdraw');
    expect(
      (
        await call<{ state: string }>(slide('/proposal/cancel'), {
          token: again.c.token,
          body: { id: again.p.id },
        })
      ).body.state,
    ).toBe('cancelled');
    expect(c.identity.actorId).toBe('C');
  });
});

describe('reference editor artifacts', () => {
  const file = (data: string) => ({
    schemaVersion: 2,
    id: `file-${data}`,
    name: 'notes.txt',
    mime: 'text/plain',
    size: data.length,
    data,
  });
  async function open(actor: string, artifactId: string, initial?: unknown, domain = 'file') {
    return call<{ token: string; identity: Identity; name: string }>('/editor/session', {
      body: { actor, artifactId, domain, ...(initial ? { initial } : {}) },
    });
  }
  const fileApi = (path: string) => `${path}?domain=file`;
  it('creates once from a verified seed and never overwrites an existing authority', async () => {
    expect(await open('Z', 'doc-1')).toMatchObject({ status: 400, body: { code: 'unauthorized' } });
    expect(await open('A', 'bad id')).toMatchObject({ status: 400 });
    expect(await open('A', 'doc-1', undefined, 'missing')).toMatchObject({ status: 400 });
    expect(await open('A', 'doc-1')).toMatchObject({
      status: 400,
      body: { code: 'target-deleted' },
    });
    const artifact = createArtifact('file', 'Seed', file('seed'));
    artifact.id = 'doc-1';
    const seeded = (await commitVersion(artifact, 'A', 'seed')).versions[0];
    expect(
      await open('A', 'doc-1', {
        content: file('seed'),
        versions: [{ ...seeded, contentHash: 'x' }],
      }),
    ).toMatchObject({ status: 400, body: { code: 'schema-mismatch' } });
    expect(await open('A', 'doc-1', { content: file('seed'), versions: {} })).toMatchObject({
      status: 400,
    });
    const first = await open('A', 'doc-1', {
      name: 'Notes',
      content: file('seed'),
      versions: [seeded],
    });
    expect(first).toMatchObject({ status: 200, body: { name: 'Notes' } });
    const second = await open('B', 'doc-1', { name: 'Stale', content: file('stale') });
    expect(second.body.name).toBe('Notes');
    expect(await open('B', 'doc-1', undefined, 'slide')).toMatchObject({
      status: 400,
      body: { code: 'schema-mismatch' },
    });
    const versions = await call<ConfirmedVersion<unknown>[]>(fileApi('/versions'), {
      token: second.body.token,
    });
    expect(versions.body.map((v) => v.version.versionId)).toEqual([seeded.versionId]);
    expect(await call(slide('/snapshot'), { token: first.body.token })).toMatchObject({
      status: 400,
      body: { code: 'unauthorized' },
    });
  });
  it('saves concurrent versions as one linear chain and restores after review', async () => {
    const { body: a } = await open('A', 'doc-2', { content: file('one') });
    const saved = await Promise.all(
      Array.from(
        { length: 6 },
        async (_, index) =>
          (
            await call<ConfirmedVersion<unknown>>(fileApi('/version'), {
              token: a.token,
              body: { reason: `save ${index}` },
            })
          ).body,
      ),
    );
    const listed = (
      await call<ConfirmedVersion<unknown>[]>(fileApi('/versions'), { token: a.token })
    ).body;
    expect(listed).toHaveLength(6);
    expect(listed.map((v) => v.version.parentVersionId)).toEqual([
      null,
      ...listed.slice(0, -1).map((v) => v.version.versionId),
    ]);
    const first = listed[0];
    expect(saved.map((v) => v.version.versionId).sort()).toEqual(
      listed.map((v) => v.version.versionId).sort(),
    );
    expect(
      await call(fileApi('/restore-version'), {
        token: a.token,
        body: { versionId: 'missing', expectedRevision: 0 },
      }),
    ).toMatchObject({ status: 400, body: { code: 'target-deleted' } });
    expect(
      (
        await call<Receipt>(fileApi('/restore-version'), {
          token: a.token,
          body: { versionId: first.version.versionId, expectedRevision: 3 },
        })
      ).body,
    ).toMatchObject({ status: 'rejected', code: 'stale-precondition' });
    expect(
      (
        await call<Receipt>(fileApi('/restore-version'), {
          token: a.token,
          body: { versionId: first.version.versionId, expectedRevision: 0 },
        })
      ).body,
    ).toMatchObject({ code: 'unsupported-operation' });
  });
  it('captures each queued version at its request, not after earlier saves finish', async () => {
    const a = await join('A', 'queued-save');
    const saves = Array.from({ length: 4 }, () =>
      call<ConfirmedVersion<Slide>>(slide('/version'), { token: a.token, body: {} }),
    );
    const edit = await submitFill(a, 'shape1', '#0f0f0f');
    expect(edit.status).toBe('accepted');
    const saved = (await Promise.all(saves)).map((r) => r.body);
    expect(saved.map((v) => v.confirmedRevision)).toEqual([0, 0, 0, 0]);
    expect(saved.every((v) => v.version.content.slides[0].objects[0].fill !== '#0f0f0f')).toBe(
      true,
    );
  });
  it('restores a saved room version only against the reviewed revision', async () => {
    const a = await join('A', 'restore');
    await submitFill(a, 'shape1', '#010101');
    const saved = (
      await call<ConfirmedVersion<Slide>>(slide('/version'), { token: a.token, body: {} })
    ).body;
    expect(saved.version.reason).toBe('Reference shared version');
    await submitFill(a, 'shape1', '#020202');
    expect(
      (
        await call<Receipt>(slide('/restore-version'), {
          token: a.token,
          body: { versionId: saved.version.versionId, expectedRevision: 2 },
        })
      ).body,
    ).toMatchObject({ status: 'accepted', revision: 3 });
    expect(fill(await snapshot(a.token), 'shape1')).toBe('#010101');
  });
  it('applies reference permission faults to saving, uploads and proposal review', async () => {
    const { body: a } = await open('A', 'doc-3', { content: file('three') });
    const room = await join('A', 'faults');
    expect(
      await call(slide('/editor/reference-permissions'), {
        token: room.token,
        body: { writable: false },
      }),
    ).toMatchObject({ status: 400, body: { code: 'invalid-operation' } });
    for (const body of [{ writable: 'no' }, { writable: false, expiresAt: 'later' }])
      expect(
        await call(fileApi('/editor/reference-permissions'), { token: a.token, body }),
      ).toMatchObject({ status: 400, body: { code: 'invalid-operation' } });
    expect(
      (
        await call<{ writable: boolean }>(fileApi('/editor/reference-permissions'), {
          token: a.token,
          body: { writable: false, expiresAt: Date.now() + 60_000 },
        })
      ).body.writable,
    ).toBe(false);
    for (const path of ['/version', '/editor/asset'])
      expect(await call(fileApi(path), { token: a.token, body: {} })).toMatchObject({
        status: 400,
        body: { code: 'unauthorized' },
      });
    const { body: b } = await open('B', 'doc-3');
    const state = (await call<Snapshot<unknown>>(fileApi('/snapshot'), { token: b.token })).body;
    const p = {
      schema: 1,
      id: 'rename',
      artifactId: 'doc-3',
      sourceActorId: 'B',
      baseRevision: state.revision,
      summary: 'Rename',
      actions: [],
      reads: null,
      writes: [],
      external: [],
    };
    expect((await call(fileApi('/proposal/register'), { token: b.token, body: p })).status).toBe(
      200,
    );
    expect(
      await call(fileApi('/proposal/cancel'), {
        token: a.token,
        body: { id: 'rename', reject: true },
      }),
    ).toMatchObject({ status: 400, body: { code: 'unauthorized' } });
    expect(
      (
        await call<{ state: string }>(fileApi('/proposal/cancel'), {
          token: b.token,
          body: { id: 'rename', reject: true },
        })
      ).body.state,
    ).toBe('rejected');
  });
});
