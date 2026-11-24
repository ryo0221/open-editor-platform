// Loopback reference Host. The operator supplies the approved package and codec hashes.
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import console from 'node:console';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createServer as createVite } from 'vite';
const [packagePath, pinPath, seedPath, dbPath, port = '4191'] = process.argv.slice(2);
if (!dbPath)
  throw Error('Expected package.json, approved pins.json, initial content JSON and database path');
let origin = 'http://127.0.0.1:' + Number(port);
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const transported = json(packagePath);
const lookup = (field) => (id, version) => {
  const pin = json(pinPath);
  return pin.id === id && pin.version === version ? pin[field] : undefined;
};
const vite = await createVite({
  configFile: false,
  server: { middlewareMode: true, hmr: false, watch: null },
  ssr: { noExternal: [/^@editor-platform\//] },
});
const { verifyExtensionPackage } = await vite.ssrLoadModule(
  '@editor-platform/extension-runtime/package',
);
const { SharedDraft } = await vite.ssrLoadModule('@editor-platform/extension-runtime/shared-draft');
const pkg = await verifyExtensionPackage(
  {
    ...transported,
    files: transported.files.map((f) => ({
      path: f.path,
      bytes: Uint8Array.from(Buffer.from(f.base64, 'base64')),
    })),
  },
  lookup('packageHash'),
);
const host = await SharedDraft.open(dbPath, pkg, lookup('codecHash'), 'reference', json(seedPath));
const sessions = new DatabaseSync(dbPath);
sessions.exec(
  'CREATE TABLE IF NOT EXISTS reference_sessions(token TEXT PRIMARY KEY, actor TEXT, session TEXT UNIQUE, resume TEXT UNIQUE, expires INTEGER)',
);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./client.js', import.meta.url))],
  platform: 'browser',
  format: 'esm',
  bundle: true,
  external: ['/extension.js'],
  write: false,
});
const html =
  '<!doctype html><html lang="ja"><meta charset="utf-8"><title>共同編集</title><main><h1>共同編集</h1><nav><button id="undo">元に戻す</button><button id="redo">やり直す</button><button id="save">この版を保存</button></nav><p id="status" role="status"></p><section id="recovery" hidden><p>本人が入力した内容</p><textarea readonly></textarea><button id="clear">控えを閉じる</button></section><section id="editor"></section></main><script type="module" src="/client.js"></script></html>';
const presence = new Map();
let presenceRevision = 0;
const listeners = new Set();
function notify() {
  for (const send of listeners) send();
}
const server = createServer(async (req, res) => {
  try {
    const path = req.url;
    if (req.headers.host !== new URL(origin).host) throw Error('unauthorized');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      req.method === 'GET' &&
      ['/', '/client.js', '/extension.js', '/session-worker.js'].includes(path)
    ) {
      res.setHeader(
        'Content-Type',
        path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      );
      res.end(
        path === '/'
          ? html
          : path === '/client.js'
            ? bundle.outputFiles[0].contents
            : path === '/session-worker.js'
              ? readFileSync(new URL('./session-worker.js', import.meta.url))
              : pkg.readFile(pkg.entry),
      );
      return;
    }
    if (
      req.method !== 'POST' ||
      req.headers.origin !== origin ||
      req.headers['content-type'] !== 'application/json'
    )
      throw Error('unauthorized');
    let bytes = 0;
    const parts = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 4_000_000) throw Error('request too large');
      parts.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(parts).toString());
    const actor = /\bexternal_actor=([a-f0-9-]{36})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    let result;
    if (path === '/session') {
      const cookie = actor ?? randomUUID();
      const identity = hash(cookie);
      const existing =
        actor && typeof body.resume === 'string'
          ? sessions
              .prepare(
                'SELECT session FROM reference_sessions WHERE actor=? AND resume=? AND expires>?',
              )
              .get(identity, hash(body.resume), Date.now())
          : undefined;
      const session = existing?.session ?? randomUUID(),
        token = randomUUID(),
        ticket = randomUUID();
      sessions
        .prepare('INSERT OR REPLACE INTO reference_sessions VALUES(?,?,?,?,?)')
        .run(hash(token), identity, session, hash(ticket), Date.now() + 60_000);
      res.setHeader(
        'Set-Cookie',
        'external_actor=' + cookie + '; Path=/; HttpOnly; SameSite=Strict',
      );
      result = { token, ticket, namespace: session, domain: 'ext:' + pkg.manifest.id };
    } else {
      const token = req.headers.authorization?.slice(7) ?? '';
      const principal = () => {
        const record = sessions
          .prepare('SELECT actor,session FROM reference_sessions WHERE token=? AND actor=?')
          .get(hash(token), hash(actor ?? ''));
        if (!record) throw Error('unauthorized');
        return {
          actorId: record.actor,
          sessionId: record.session,
          clientId: record.session,
          writable: true,
          scopes: ['*'],
        };
      };
      const conn = { principal, readable: () => !!principal(), namespace: principal().sessionId };
      const snap = host.snapshot(conn);
      for (const [id, pointer] of presence) {
        try {
          pointer.owner();
          if (pointer.expires > Date.now() && pointer.generation === snap.generation) continue;
        } catch {
          /* Discard disconnected principals. */
        }
        presence.delete(id);
        presenceRevision++;
      }
      if (path === '/open')
        result = {
          snapshot: host.snapshot(conn),
          history: host.history(conn),
          parent: host.savedParent(conn),
          presenceRevision,
          presence: [...presence.entries()]
            .filter(([id]) => id !== conn.namespace)
            .map(([session, { target, x, y }]) => ({ session, target, x, y })),
        };
      else if (path === '/pointer') {
        if (body.generation !== snap.generation) throw Error('resync-required');
        const prior = presence.get(conn.namespace);
        if (body.target === null) presence.delete(conn.namespace);
        else {
          if (![body.x, body.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
            throw Error('invalid-operation');
          if (!prior || prior.target !== body.target || prior.revision !== snap.revision)
            if (!(await host.validatePresence(conn, body.target))) throw Error('target-deleted');
          presence.set(conn.namespace, {
            generation: snap.generation,
            revision: snap.revision,
            target: body.target,
            x: body.x,
            y: body.y,
            owner: principal,
            expires: Date.now() + 10000,
          });
        }
        presenceRevision++;
        notify();
        result = true;
      } else if (path === '/submit') result = await host.submit(conn, body);
      else if (path === '/preview') result = await host.previewProposal(conn, body);
      else if (path === '/adopt')
        result = await host.adoptProposal(conn, body.proposalId, body.operationId);
      else if (path === '/history') result = await host.undoRedo(conn, body);
      else if (path === '/receipt')
        result = host.receipt(conn, body.generation, body.operationId) ?? null;
      else if (path === '/save') result = host.save(conn, body);
      else if (path === '/changes') {
        const changed = () => {
          const snap = host.snapshot(conn);
          return (
            snap.generation !== body.generation ||
            snap.revision !== body.revision ||
            presenceRevision !== body.presenceRevision
          );
        };
        sessions
          .prepare('UPDATE reference_sessions SET expires=? WHERE token=?')
          .run(Date.now() + 60_000, hash(token));
        if (!changed())
          await new Promise((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              listeners.delete(finish);
              resolve();
            };
            const timer = setTimeout(finish, 15000);
            listeners.add(finish);
            res.once('close', finish);
          });
        result = true;
      } else throw Error('unknown request');
      if (result?.status === 'accepted' || path === '/save') notify();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = error.message === 'unauthorized' ? 403 : 409;
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(Number(port), '127.0.0.1', () => {
  origin = 'http://127.0.0.1:' + server.address().port;
  console.log(origin);
});
