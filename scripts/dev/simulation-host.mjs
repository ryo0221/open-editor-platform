import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';

// Reference compute Host for the simulation editor (R3f-2, docs/cad/r3-analysis.md A2). The dev
// server runs CalculiX (`ccx`, GPL-2.0, installed on the server on its own; never bundled or
// served) on jobs the Playground sends after the user pressed it. A job is JSON with numbers
// only; it is checked by the same `computeJobInp` the editor uses, and the `.inp` is always
// written from those numbers, so nothing the browser sends reaches CalculiX as text. A static
// build has no compute Host: `virtual:simulation-compute-host` is null there, and also when `ccx`
// is missing or SIMULATION_HOST=off.
const id = 'virtual:simulation-compute-host';
const endpoint = '/__simulation-host';
const computeModule = fileURLToPath(
  new URL('../../packages/simulation/src/compute.ts', import.meta.url),
);

/** `calculix-<version>` of the `ccx` on PATH (or `command`), or null. */
export function calculixBuild(command = 'ccx') {
  const r = spawnSync(command, ['-v'], { encoding: 'utf8', timeout: 10_000 });
  const v = /Version (\d+(?:\.\d+)*)/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return v ? `calculix-${v[1]}` : null;
}

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const readBody = (req, max) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/**
 * The job store and its routes under `/__simulation-host`: POST /jobs, GET /jobs/:id,
 * GET /jobs/:id/result, DELETE /jobs/:id. One job runs at a time; the others wait. A job's
 * folder is removed when its result is read, it is cancelled, or `keepMs` after it ended.
 *
 * `toInp(value)` checks a job and returns `{ inp }` or throws (`compute-job-invalid`).
 */
export function createSimulationJobs({
  toInp,
  command = 'ccx',
  limits,
  timeoutMs = 10 * 60_000,
  maxJobs = 8,
  keepMs = 10 * 60_000,
  // CR5f-8: F29's torsion result is 278 MB; under V8's longest string (2^29 characters).
  resultBytes = 480 * 1024 * 1024,
}) {
  const jobs = new Map();
  let running = null;
  /** POSTs still being read and checked: they hold their place in `maxJobs`. */
  let reserved = 0;
  const now = () => Date.now();
  const publicState = (job) =>
    job.state === 'queued' || job.state === 'running'
      ? { state: job.state, phase: job.phase, elapsedMs: now() - job.created }
      : job.state === 'done'
        ? { state: 'done', elapsedMs: job.ended - job.created }
        : job.state === 'failed'
          ? { state: 'failed', message: job.message }
          : { state: 'cancelled' };
  const cleanup = async (job) => {
    if (job.dir) await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
    job.dir = null;
  };
  /** Forgets a job and removes its folder `keepMs` after it ended, read or not. */
  const expire = (job) => {
    job.timer = setTimeout(() => {
      void cleanup(job);
      jobs.delete(job.key);
    }, keepMs);
    job.timer.unref?.();
  };
  const finish = (job, state, message) => {
    if (job.state === 'cancelled') return;
    job.state = state;
    job.message = message;
    job.ended = now();
    if (state !== 'done') void cleanup(job);
    expire(job);
  };
  const next = () => {
    if (running) return;
    const job = [...jobs.values()].find((j) => j.state === 'queued');
    if (!job) return;
    running = job;
    void run(job).finally(() => {
      running = null;
      next();
    });
  };
  const run = async (job) => {
    job.state = 'running';
    job.phase = 'writing';
    try {
      job.dir = await mkdtemp(path.join(tmpdir(), 'simulation-job-'));
      // Cancelled while the folder was made or written: nothing is started, the folder goes.
      if (job.state === 'cancelled') return await cleanup(job);
      await writeFile(path.join(job.dir, 'job.inp'), job.inp);
      job.inp = null;
      if (job.state === 'cancelled') return await cleanup(job);
      job.phase = 'solving';
      const out = await new Promise((resolve) => {
        const child = spawn(command, ['-i', 'job'], {
          cwd: job.dir,
          env: { PATH: process.env.PATH, OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        job.child = child;
        let tail = '';
        const keep = (c) => (tail = (tail + c.toString('utf8')).slice(-4000));
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const timer = setTimeout(() => {
          tail += '\n*ERROR timeout';
          child.kill('SIGKILL');
        }, timeoutMs);
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve({ code: -1, tail: String(e) });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, tail });
        });
      });
      job.child = null;
      if (job.state === 'cancelled') return await cleanup(job);
      const frd = path.join(job.dir, 'job.frd');
      const errors = out.tail.split('\n').filter((l) => /\*ERROR/.test(l));
      const size = await stat(frd).then(
        (s) => s.size,
        () => -1,
      );
      if (out.code !== 0 || errors.length || size < 0)
        return finish(
          job,
          'failed',
          (errors.join(' ').trim() || `CalculiX exited ${out.code}`).slice(0, 500),
        );
      if (size > resultBytes) return finish(job, 'failed', 'the result is too large');
      job.phase = 'done';
      finish(job, 'done');
    } catch (e) {
      finish(job, 'failed', String(e?.message ?? e).slice(0, 500));
    }
  };

  const handle = async (req, res, nextMiddleware) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      // Not a URL this Host serves (e.g. "//"): left to the rest of the server.
      return nextMiddleware();
    }
    if (!url.pathname.startsWith(`${endpoint}/`)) return nextMiddleware();
    // Same origin only: a page elsewhere cannot start a job here.
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `http://${req.headers.host}` &&
      origin !== `https://${req.headers.host}`
    )
      return json(res, 403, { error: 'origin' });
    const parts = url.pathname.slice(endpoint.length + 1).split('/');
    try {
      if (parts.length === 1 && parts[0] === 'jobs' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? ''))
          return json(res, 415, { error: 'application/json only' });
        // The place is taken before the body is read, so concurrent POSTs cannot pass together.
        if ([...jobs.values()].filter((j) => !j.ended).length + reserved >= maxJobs)
          return json(res, 429, { error: 'too many jobs' });
        reserved++;
        // A client that went away while its job was read or checked never gets the id, so it could
        // not cancel it: such a job is not started.
        let gone = false;
        res.on('close', () => {
          if (!res.writableFinished) gone = true;
        });
        let inp;
        try {
          let value;
          try {
            value = JSON.parse(await readBody(req, limits.bytes));
          } catch (e) {
            return json(res, e.status ?? 400, { error: e.status ? 'too large' : 'not JSON' });
          }
          try {
            ({ inp } = await toInp(value));
          } catch (e) {
            return json(res, 400, { error: String(e?.message ?? e).slice(0, 500) });
          }
        } finally {
          reserved--;
        }
        if (gone || res.destroyed) return;
        const key = randomUUID();
        jobs.set(key, { key, state: 'queued', phase: 'queued', created: now(), inp, dir: null });
        next();
        return json(res, 201, { id: key });
      }
      const job = parts[0] === 'jobs' ? jobs.get(parts[1] ?? '') : undefined;
      if (!job) return json(res, 404, { error: 'no such job' });
      if (parts.length === 2 && req.method === 'GET') return json(res, 200, publicState(job));
      if (parts.length === 2 && req.method === 'DELETE') {
        if (!job.ended) {
          job.state = 'cancelled';
          job.ended = now();
          job.child?.kill('SIGKILL');
        }
        clearTimeout(job.timer);
        await cleanup(job);
        jobs.delete(parts[1]);
        return json(res, 200, { state: 'cancelled' });
      }
      if (parts.length === 3 && parts[2] === 'result' && req.method === 'GET') {
        if (job.state !== 'done' || !job.dir) return json(res, 409, { error: job.state });
        const text = await readFile(path.join(job.dir, 'job.frd'), 'utf8');
        clearTimeout(job.timer);
        await cleanup(job);
        jobs.delete(parts[1]);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(text);
      }
      return json(res, 405, { error: 'method' });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e).slice(0, 500) });
    }
  };
  const close = async () => {
    for (const job of jobs.values()) {
      clearTimeout(job.timer);
      if (!job.ended) job.state = 'cancelled';
      job.child?.kill('SIGKILL');
      await cleanup(job);
    }
    jobs.clear();
  };
  return { handle, close };
}

export function simulationReferenceHost({
  command = 'ccx',
  enabled = process.env.SIMULATION_HOST !== 'off',
} = {}) {
  let serving = false;
  let descriptor = null;
  return {
    name: 'simulation-reference-host',
    configResolved(config) {
      serving = config.command === 'serve';
      const solverBuild = serving && enabled ? calculixBuild(command) : null;
      descriptor = solverBuild
        ? {
            label: 'Reference Host (CalculiX)',
            destination: 'this development server',
            solverBuild,
            // referenceComputeLimits (packages/simulation/src/compute.ts, CR5f-8).
            limits: { nodes: 1_500_000, elements: 1_000_000, bytes: 256 * 1024 * 1024 },
            endpoint,
          }
        : null;
    },
    resolveId: (source) => (source === id ? '\0' + id : undefined),
    load: (resolved) =>
      resolved === '\0' + id ? `export default ${JSON.stringify(descriptor)};` : undefined,
    configureServer(server) {
      if (!descriptor) return;
      const jobs = createSimulationJobs({
        command,
        limits: descriptor.limits,
        toInp: async (value) =>
          (await server.ssrLoadModule(computeModule)).computeJobInp(value, descriptor.limits),
      });
      server.middlewares.use((req, res, next) => void jobs.handle(req, res, next));
      server.httpServer?.on('close', () => void jobs.close());
    },
  };
}
