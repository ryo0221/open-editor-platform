import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { videoTimelineFixture } from '@editor-platform/collaboration-adapters';
import { createReferenceServer } from './server';

it('binds the saved Video handoff, live session and version saves to the authenticated project generation', async () => {
  const artifactId = 'host-video-saved';
  const content = videoTimelineFixture();
  const hash = await contentHash(content);
  let generation = 'one';
  let writable = true;
  const server = createReferenceServer({
    projects: {
      access: async (req, id) =>
        req.headers.cookie === 'account=viewer' && id === artifactId
          ? { viewerId: 'viewer-id', generation, writable }
          : undefined,
      load: async () => ({ name: 'Saved movie', content }),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/collaboration-api';
  const request = async (path: string, body?: unknown, token = '', signedIn = true) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: signedIn ? 'account=viewer' : '', authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect(await request('/editor/video-link', { artifactId, contentHash: hash })).toEqual({
      status: 200,
      body: { artifactId, generation },
    });
    expect(
      (await request('/editor/video-link', { artifactId, contentHash: 'other' })).body.code,
    ).toBe('stale-precondition');
    const join = { artifactId, actor: 'A', domain: 'video', expectedSeedHash: hash, generation };
    expect((await request('/editor/session', join, '', false)).body.code).toBe('unauthorized');
    expect((await request('/editor/session', { ...join, domain: 'file' })).body.code).toBe(
      'unauthorized',
    );
    expect((await request('/editor/session', { ...join, initial: { content } })).body.code).toBe(
      'invalid-operation',
    );
    const opened = await request('/editor/session', join);
    expect(opened.body.identity.actorId).toBe('viewer-id');
    const token = opened.body.token;
    expect((await request('/snapshot?domain=video', undefined, token, false)).body.code).toBe(
      'unauthorized',
    );
    writable = false;
    expect((await request('/version?domain=video', {}, token)).body.code).toBe('unauthorized');
    expect((await request('/versions?domain=video', undefined, token)).body).toEqual([]);
    generation = 'two';
    expect((await request('/snapshot?domain=video', undefined, token)).body.code).toBe(
      'unauthorized',
    );
    expect((await request('/editor/session', join)).body.code).toBe('stale-precondition');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
