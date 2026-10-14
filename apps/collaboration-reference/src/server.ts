import { createServer } from 'node:http';
import { contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import {
  Authority,
  saveConfirmedVersion,
  initial,
  uid,
  fail,
  type DomainCodec,
  type Domain,
  type Principal,
  type Proposal,
  type Presence,
  type ConfirmedVersion,
} from '@editor-platform/collaboration-core';
import {
  slideCodec,
  dataCodec,
  documentCodec,
  designCodec,
  whiteboardCodec,
  reviewCodec,
  fileCodec,
  slideEditorCodec,
  designEditorCodec,
  whiteboardEditorCodec,
  dataEditorCodec,
  documentEditorCodec,
  editorAssetCodec,
  EditorAssetCache,
  reactUiEditorCodec,
} from '@editor-platform/collaboration-adapters';
import {
  slideFixture,
  dataFixture,
  documentFixture,
  designFixture,
  boardFixture,
} from '@editor-platform/collaboration-adapters/fixtures';
const codecs = {
  slide: slideCodec,
  data: dataCodec,
  document: documentCodec,
  design: designCodec,
  whiteboard: whiteboardCodec,
  review: reviewCodec,
  file: fileCodec,
};
const rooms = new Map<string, Map<Domain, Authority<unknown>>>();
const versions = new Map<string, ConfirmedVersion<unknown>[]>();
const editorCodecs = {
  ...codecs,
  'react-ui': reactUiEditorCodec,
  document: documentEditorCodec,
  slide: slideEditorCodec,
  design: designEditorCodec,
  whiteboard: whiteboardEditorCodec,
  data: dataEditorCodec,
};
const artifacts = new Map<string, { name: string; authority: Authority<unknown> }>();
const assetCaches = new Map<string, EditorAssetCache>();
const connections = new Map<string, { room?: string; artifactId?: string; principal: Principal }>();
function room(name: string) {
  let value = rooms.get(name);
  if (value) return value;
  const fixtures = {
    slide: slideFixture(),
    data: dataFixture(),
    document: documentFixture(),
    design: designFixture(),
    whiteboard: boardFixture(),
    review: {
      schemaVersion: 2,
      files: [
        {
          id: 'source',
          name: 'example.ts',
          oldText: 'before',
          newText: 'after',
          oldRevision: 'old-v1',
          newRevision: 'new-v1',
        },
      ],
    },
    file: {
      schemaVersion: 2,
      id: 'file-v1',
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      data: 'notes',
    },
  };
  value = new Map();
  for (const domain of Object.keys(codecs) as (keyof typeof codecs)[]) {
    const codec = codecs[domain] as DomainCodec<unknown>;
    value.set(domain, new Authority(codec, initial(`${name}:${domain}`, codec, fixtures[domain])));
  }
  rooms.set(name, value);
  return value;
}
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'),
      path = url.pathname.replace(/^\/collaboration-api/, '');
    if (path === '/health') {
      response.end(JSON.stringify({ ready: true, durable: false }));
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > (path === '/editor/asset' || path === '/editor/session' ? 20_000_000 : 1_100_000))
        fail('schema-mismatch', 'Request exceeds limit');
      chunks.push(chunk);
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (path === '/editor/session' && request.method === 'POST') {
      if (
        !['A', 'B', 'C'].includes(body.actor) ||
        typeof body.artifactId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,150}$/.test(body.artifactId) ||
        !Object.hasOwn(editorCodecs, body.domain)
      )
        fail('unauthorized', 'Invalid reference editor identity/artifact');
      let artifact = artifacts.get(body.artifactId);
      if (!artifact) {
        if (!body.initial)
          fail('target-deleted', 'Shared artifact is unavailable; initialize from its local draft');
        const assets = new EditorAssetCache();
        assets.encode(body.initial.content);
        const codec = editorAssetCodec(
          editorCodecs[body.domain as Domain] as DomainCodec<unknown>,
          assets,
          true,
        );
        const candidate = {
          name: String(body.initial.name ?? 'Shared artifact'),
          authority: new Authority(
            codec,
            initial(body.artifactId, codec, body.initial.content, body.initial.threads ?? []),
          ),
        };
        const seeded: ConfirmedVersion<unknown>[] = [];
        if (!Array.isArray(body.initial.versions ?? []))
          fail('schema-mismatch', 'Invalid version archive');
        for (const version of (body.initial.versions ?? []) as ArtifactVersion<unknown>[]) {
          if (
            version.artifactId !== body.artifactId ||
            version.schemaVersion !== 1 ||
            typeof version.versionId !== 'string' ||
            seeded.some((v) => v.version.versionId === version.versionId) ||
            (await contentHash(version.content)) !== version.contentHash
          )
            fail('schema-mismatch', 'Invalid immutable version or content hash');
          seeded.push({ schema: 1, confirmedRevision: 0, engineVersion: 0, version });
        }
        // Hashing yields: another initializer may have won. Never overwrite that authority.
        artifact = artifacts.get(body.artifactId);
        if (!artifact) {
          artifact = candidate;
          artifacts.set(body.artifactId, artifact);
          assetCaches.set(body.artifactId, assets);
          versions.set(body.artifactId, seeded);
        }
      }
      if (artifact.authority.snapshot().domain !== body.domain)
        fail('schema-mismatch', 'Existing artifact has a different domain');
      // An existing authority is always retained; a stale local seed never overwrites it.
      const principal: Principal = {
          actorId: body.actor,
          clientId: uid(),
          sessionId: uid(),
          writable: true,
          scopes: ['*'],
        },
        token = uid();
      connections.set(token, { artifactId: body.artifactId, principal });
      response.end(
        JSON.stringify({
          token,
          identity: {
            actorId: principal.actorId,
            clientId: principal.clientId,
            sessionId: principal.sessionId,
          },
          name: artifact.name,
        }),
      );
      return;
    }
    if (path === '/session' && request.method === 'POST') {
      if (
        !['A', 'B', 'C'].includes(body.actor) ||
        typeof body.room !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(body.room)
      )
        fail('unauthorized', 'Reference identity/room is invalid');
      const principal: Principal = {
          actorId: body.actor,
          clientId: uid(),
          sessionId: uid(),
          writable: true,
          scopes: ['*'],
        },
        token = uid();
      connections.set(token, { room: body.room, principal });
      room(body.room);
      response.end(
        JSON.stringify({
          token,
          identity: {
            actorId: principal.actorId,
            clientId: principal.clientId,
            sessionId: principal.sessionId,
          },
        }),
      );
      return;
    }
    const connection = connections.get(
      String(request.headers.authorization ?? '').replace(/^Bearer /, ''),
    );
    if (!connection) fail('unauthorized', 'Missing authenticated reference session');
    const domain = url.searchParams.get('domain') as Domain,
      authority = connection.artifactId
        ? artifacts.get(connection.artifactId)?.authority
        : room(connection.room!).get(domain);
    if (!authority) fail('schema-mismatch', 'Unknown domain');
    if (authority.snapshot().domain !== domain)
      fail('unauthorized', 'Session is bound to another domain');
    const principal = connection.principal;
    let result: unknown;
    if (request.method === 'GET') {
      if (path === '/versions') result = versions.get(authority.snapshot().artifactId) ?? [];
      else if (path === '/snapshot') result = authority.snapshot();
      else if (path === '/changes') {
        const after = Number(url.searchParams.get('after'));
        if (!Number.isSafeInteger(after) || after < 0) fail('schema-mismatch', 'Invalid revision');
        result = authority.changes(after);
      } else if (path === '/receipt')
        result = authority.receipt(url.searchParams.get('id') ?? '') ?? null;
      else if (path === '/permissions') result = principal;
      else if (path === '/presence') result = authority.presenceList();
      else if (path === '/proposal')
        result = authority.proposal(url.searchParams.get('id') ?? '') ?? null;
      else fail('unsupported-operation', 'Unknown endpoint');
    } else if (request.method === 'POST') {
      if (path === '/editor/reference-permissions') {
        // Fault injection for this loopback reference Host only; never an Editor policy API.
        if (!connection.artifactId || typeof body.writable !== 'boolean')
          fail('invalid-operation', 'Invalid reference permission change');
        principal.writable = body.writable;
        if (body.expiresAt !== undefined) {
          if (!Number.isFinite(body.expiresAt))
            fail('invalid-operation', 'Invalid reference expiry');
          principal.expiresAt = body.expiresAt;
        }
        result = principal;
      } else if (path === '/editor/asset') {
        if (
          !connection.artifactId ||
          !principal.writable ||
          (principal.expiresAt !== undefined && principal.expiresAt <= Date.now())
        )
          fail('unauthorized', 'Session cannot upload an asset');
        assetCaches.get(connection.artifactId)!.register(body.reference, body.data);
        result = { registered: true };
      } else if (path === '/version') {
        if (
          !principal.writable ||
          (principal.expiresAt !== undefined && principal.expiresAt <= Date.now())
        )
          fail('unauthorized', 'Session cannot save');
        const artifactId = authority.snapshot().artifactId,
          records = versions.get(artifactId) ?? [];
        const saved = await saveConfirmedVersion(
          authority,
          principal.actorId,
          typeof body.reason === 'string' ? body.reason : 'Reference shared version',
          records.at(-1)?.version.versionId ?? null,
        );
        const current = versions.get(artifactId) ?? [];
        versions.set(artifactId, [...current, saved]);
        result = saved;
      } else if (path === '/restore-version') {
        const record = (versions.get(authority.snapshot().artifactId) ?? []).find(
          (v) => v.version.versionId === body.versionId,
        );
        if (!record) fail('target-deleted', 'Saved version missing');
        result = authority.restore(principal, record.version.content, body.expectedRevision);
      } else if (path === '/submit') result = authority.commit(principal, body);
      else if (path === '/undo') result = authority.undo(principal, body.id, body.redo === true);
      else if (path === '/presence')
        result = authority.presence(
          principal,
          body.value as Omit<Presence, 'actorId' | 'clientId' | 'sessionId' | 'expiresAt'> | null,
        );
      else if (path === '/proposal/register') {
        if (body.sourceActorId !== principal.actorId)
          fail('unauthorized', 'Proposal source is not authenticated actor');
        result = authority.register(body as Proposal);
      } else if (path === '/proposal/preview') result = authority.preview(principal, body.id);
      else if (path === '/proposal/apply')
        result = authority.applyProposal(principal, body.id, body.token);
      else if (path === '/proposal/cancel')
        result = authority.cancelProposal(body.id, body.reject === true);
      else if (path === '/close') {
        authority.presence(principal, null);
        result = { closed: true };
      } else fail('unsupported-operation', 'Unknown endpoint');
    } else fail('unsupported-operation', 'Unsupported method');
    response.end(JSON.stringify(result));
  } catch (error) {
    response.statusCode = 400;
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Invalid request',
        code:
          error && typeof error === 'object' && 'code' in error ? error.code : 'invalid-operation',
      }),
    );
  }
});
const port = Number(process.env.COLLABORATION_PORT ?? 4180);
server.listen(port, '127.0.0.1', () =>
  process.stdout.write(
    `Reference collaboration authority ready on ${port} (in-memory; demo authentication)\n`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
