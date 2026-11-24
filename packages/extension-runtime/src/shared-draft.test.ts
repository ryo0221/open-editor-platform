import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  COLLABORATION_ADDON,
  CONTRACT_VERSION,
  OPERATIONS_ADDON,
} from '@editor-platform/extension-contract';
import { fingerprint } from '@editor-platform/collaboration-core';
import { describeExtensionPackage, verifyExtensionPackage, type ExtensionPackage } from './package';
import { SharedDraft, type SharedConnection } from './shared-draft';
import type { SharedRequest } from './shared-edit';

const codec = `
export function validate(value){return typeof value.a==='number' && typeof value.b==='number'}
export function resource(content,key){return content[key]}
export function plan(id,version,input){return [{type:id,target:input.key,payload:input}]}
export function apply(content,{payload:{key,delta}}) {
 return {content:{...content,[key]:content[key]+delta},targets:[key],touched:[key],required:[key],inverse:[{type:'increment',target:key,payload:{key,delta:-delta}}]}
}`;
const ref = { id: 'increment', version: '1.0.0' };
async function fixture(source = codec) {
  const hash = 'sha256:' + createHash('sha256').update(source).digest('hex');
  const input: ExtensionPackage = {
    entry: 'ui.js',
    files: [
      { path: 'ui.js', bytes: new Uint8Array() },
      { path: 'codec.js', bytes: new TextEncoder().encode(source) },
    ],
    manifest: {
      id: 'test.counter',
      contractVersion: CONTRACT_VERSION,
      artifactKind: 'test.counter',
      version: '1.0.0',
      schemaVersion: 2,
      permissions: ['artifact:read', 'artifact:write'],
      capabilities: ['local-edit'],
      licenseNotices: ['test'],
      addons: {
        collaboration: {
          version: COLLABORATION_ADDON,
          entry: 'codec.js',
          sha256: hash,
          operations: [ref],
        },
        operations: {
          version: OPERATIONS_ADDON,
          declarations: [
            {
              ...ref,
              title: 'increment',
              inputSchema: {
                type: 'object',
                properties: {
                  key: { type: 'string', maxLength: 1, enum: ['a', 'b'] },
                  delta: { type: 'integer' },
                },
                required: ['key', 'delta'],
                additionalProperties: false,
              },
            },
          ],
        },
      },
    },
  };
  const pin = (await describeExtensionPackage(input)).hash;
  const pkg = await verifyExtensionPackage(input, () => pin);
  const dir = mkdtempSync(join(tmpdir(), 'ep-shared-'));
  const open = () => SharedDraft.open(join(dir, 'db'), pkg, () => hash, 'counter', { a: 0, b: 0 });
  let host = await open();
  cleanup.push(() => {
    host.close();
    rmSync(dir, { recursive: true });
  });
  const actor = (id: string): SharedConnection => ({
    namespace: id,
    readable: () => true,
    principal: () => ({ actorId: id, sessionId: id, clientId: id, writable: true, scopes: ['*'] }),
  });
  const a = actor('a'),
    b = actor('b');
  const request = (connection: SharedConnection, key: 'a' | 'b'): SharedRequest => {
    const snap = host.snapshot(connection);
    return {
      protocol: 2,
      schema: 1,
      domain: 'ext:test.counter',
      artifactId: 'counter',
      generation: snap.generation,
      baseRevision: snap.revision,
      operationId: connection.namespace + '/' + randomUUID(),
      declaration: ref,
      input: { key, delta: 1 },
      conditions: [
        { key, stamp: snap.stamps[key] ?? 0, fingerprint: fingerprint(snap.content[key]) },
      ],
    };
  };
  return {
    get host() {
      return host;
    },
    request,
    a,
    b,
    restart: async () => {
      host.close();
      host = await open();
    },
    input,
  };
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
it('commits independent fields, rejects stale input and retains receipts after restart', async () => {
  const f = await fixture(),
    { a, b } = f;
  const left = f.request(a, 'a'),
    right = f.request(b, 'b'),
    stale = f.request(b, 'a');
  const [r1, r2] = await Promise.all([f.host.submit(a, left), f.host.submit(b, right)]);
  expect([r1.status, r2.status], JSON.stringify([r1, r2])).toEqual(['accepted', 'accepted']);
  expect(await f.host.submit(b, stale)).toMatchObject({
    status: 'rejected',
    code: 'stale-precondition',
  });
  await f.restart();
  expect(await f.host.submit(a, left)).toEqual(r1);
  expect(f.host.snapshot(a).content).toEqual({ a: 1, b: 1 });
  const saved = {
    generation: left.generation,
    revision: 0,
    contentHash: fingerprint({ a: 0, b: 0 }),
    parentVersionId: null,
    requestId: randomUUID(),
  };
  const version = f.host.save(a, saved);
  expect(version.contentSchemaVersion).toBe(2);
  expect(version.version.schemaVersion).toBe(1);
  expect(version.version.content).toEqual({ a: 0, b: 0 });
  await f.restart();
  expect(f.host.save(a, saved)).toEqual(version);
  expect(() => f.host.save(b, { ...saved, requestId: randomUUID() })).toThrow('stale-precondition');
});
it('selectively undoes and redoes only an owned session edit', async () => {
  const { host, request, a, b } = await fixture();
  const first = request(a, 'a');
  await host.submit(a, first);
  await host.submit(b, request(b, 'b'));
  const undo = {
    target: first.operationId,
    generation: first.generation,
    direction: 'undo' as const,
    operationId: 'a/' + randomUUID(),
  };
  expect((await host.undoRedo(a, undo)).status).toBe('accepted');
  expect(host.snapshot(a).content).toEqual({ a: 0, b: 1 });
  expect(
    (
      await host.undoRedo(a, {
        ...undo,
        target: undo.operationId,
        direction: 'redo',
        operationId: 'a/' + randomUUID(),
      })
    ).status,
  ).toBe('accepted');
  expect(host.snapshot(a).content).toEqual({ a: 1, b: 1 });
});
it('refuses an undeclared reference, a changed codec file, missing conditions and injected actions', async () => {
  const { input, a, host, request } = await fixture();
  input.files[1].bytes = new Uint8Array();
  await expect(describeExtensionPackage(input)).rejects.toThrow('codec entry or hash');
  input.manifest.addons!.collaboration = {
    ...input.manifest.addons!.collaboration!,
    operations: [{ ...ref, version: '2.0.0' }],
  };
  await expect(describeExtensionPackage(input)).rejects.toThrow('operation reference');
  expect(await host.submit(a, { ...request(a, 'a'), conditions: [] })).toMatchObject({
    status: 'rejected',
  });
  expect(await host.submit(a, { ...request(a, 'a'), actions: [] } as SharedRequest)).toMatchObject({
    status: 'rejected',
  });
  expect(host.snapshot(a).revision).toBe(0);
});

it('recovers an old accepted increment after rotation and restart without applying it twice', async () => {
  const f = await fixture(),
    { a, b } = f;
  const op = f.request(a, 'a'),
    receipt = await f.host.submit(a, op);
  f.host.finishGeneration({ ...a, canMigrate: () => true });
  await f.restart();
  expect(f.host.receipt(a, op.generation, op.operationId)).toEqual(receipt);
  expect(f.host.receipt(b, op.generation, op.operationId)).toBeUndefined();
  expect(f.host.snapshot(a).content.a).toBe(1);
  await expect(f.host.submit(b, op)).rejects.toThrow('protocol-error');
  await expect(f.host.submit(a, { ...op, input: { key: 'a', delta: 2 } })).rejects.toThrow(
    'protocol-error',
  );
});
it('rejects adoption after another participant changed the previewed resource', async () => {
  const { a, b, host, request } = await fixture();
  const proposal = await host.previewProposal(a, request(a, 'a'));
  await host.submit(b, request(b, 'a'));
  expect(await host.adoptProposal(a, proposal.id, 'a/' + randomUUID())).toMatchObject({
    status: 'rejected',
    code: 'stale-precondition',
  });
  expect(host.snapshot(a).content.a).toBe(1);
});
it('rejects undeclared scope and stops handing out snapshots after read access is lost', async () => {
  const { a, host, request } = await fixture();
  const limited = { ...a, principal: () => ({ ...a.principal(), scopes: ['b'] }) };
  expect(await host.submit(limited, request(a, 'a'))).toMatchObject({
    status: 'rejected',
    code: 'unauthorized',
  });
  expect(() => host.snapshot({ ...a, readable: () => false })).toThrow('unauthorized');
});

it('bounds guest execution and preserves the last confirmed snapshot', async () => {
  const f = await fixture(codec.replace('return [{type:id', 'for(;;){};return [{type:id'));
  const receipt = await f.host.submit(f.a, f.request(f.a, 'a'));
  expect(receipt.status).toBe('rejected');
  expect(f.host.snapshot(f.a).revision).toBe(0);
});
it('stops editing during migration preview and releases a cancelled migration', async () => {
  const f = await fixture();
  const next = await fixture(codec + '\nexport const migrate=(_,content)=>content');
  const admin = { ...f.a, canMigrate: () => true };
  const pin = (await describeExtensionPackage(next.input)).hash;
  const pkg = await verifyExtensionPackage(next.input, () => pin);
  const lookup = () => next.input.manifest.addons!.collaboration!.sha256;
  await expect(f.host.previewMigration(f.a, pkg, lookup)).rejects.toThrow('unauthorized');
  const preview = await f.host.previewMigration(admin, pkg, lookup);
  const req = f.request(f.a, 'a');
  await expect(f.host.submit(f.a, req)).rejects.toThrow('migration-in-progress');
  preview.cancel();
  expect(await f.host.submit(f.a, req)).toMatchObject({ status: 'accepted' });
  const confirmed = await f.host.previewMigration(admin, pkg, lookup);
  confirmed.commit();
  expect(() => f.host.snapshot(f.a)).toThrow('schema-mismatch');
});

it('cancels only proven inverse pairs when undoing successive edits on one field', async () => {
  const { a, b, host, request } = await fixture();
  const submit = async (c: SharedConnection) => {
    const op = request(c, 'a');
    expect(await host.submit(c, op)).toMatchObject({ status: 'accepted' });
    return op;
  };
  const reverse = async (c: SharedConnection, target: string, direction: 'undo' | 'redo') => {
    const op = {
      generation: host.snapshot(c).generation,
      operationId: c.namespace + '/' + randomUUID(),
      target,
      direction,
    };
    return host.undoRedo(c, op);
  };
  const first = await submit(a),
    second = await submit(a);
  const rb = await reverse(a, second.operationId, 'undo'),
    ra = await reverse(a, first.operationId, 'undo');
  expect([rb.status, ra.status]).toEqual(['accepted', 'accepted']);
  expect(host.snapshot(a).content.a).toBe(0);
  expect((await reverse(a, ra.operationId, 'redo')).status).toBe('accepted');
  const redo = await reverse(a, rb.operationId, 'redo');
  expect(redo.status).toBe('accepted');
  const foreign = await submit(b);
  expect((await reverse(b, foreign.operationId, 'undo')).status).toBe('accepted');
  expect(await reverse(a, redo.operationId, 'undo')).toMatchObject({
    status: 'rejected',
    code: 'undo-conflict',
  });
});
