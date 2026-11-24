import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  canonical,
  fingerprint,
  serializable,
  type Action,
  type Condition,
  type Principal,
} from '@editor-platform/collaboration-core';
import { operationInputProblems } from './operations';
import { admittedCodec, type PackagePinLookup, type VerifiedPackage } from './package';

export interface SharedRequest {
  protocol: 2;
  schema: 1;
  domain: `ext:${string}`;
  artifactId: string;
  generation: string;
  operationId: string;
  baseRevision: number;
  declaration: { id: string; version: string };
  input: unknown;
  conditions: Condition[];
}
export interface SharedSnapshot<T> {
  artifactId: string;
  generation: string;
  revision: number;
  content: T;
  stamps: Record<string, number>;
}
interface Evaluation<T> {
  expected: string[];
  expectedTargets: string[];
  result: {
    content: T;
    required: string[];
    targets: string[];
    touched: string[];
    inverse: Action[];
  };
  before: unknown[];
  now: unknown[];
}
// Reference Host serializes work in one OS process. Isolated transactions have
// independent VM globals, memory limits and CPU meters. The host kills a wedged process.
let worker: ChildProcess | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let tail: Promise<void> = Promise.resolve();
let queued = 0;
export class CodecUnavailable extends Error {
  constructor() {
    super('codec-unavailable');
  }
}
function dispatch<T>(source: string, request: unknown): Promise<T> {
  clearTimeout(idle);
  if (!worker?.connected) {
    worker = fork(fileURLToPath(new URL('./shared-codec-worker.mjs', import.meta.url)), [], {
      execArgv: [
        '--v8-pool-size=1',
        '--wasm-num-compilation-tasks=1',
        '--no-wasm-async-compilation',
        '--no-wasm-lazy-compilation',
        '--no-wasm-tier-up',
      ],
      env: { UV_THREADPOOL_SIZE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  }
  const child = worker;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', reply);
      child.off('exit', failed);
      child.off('error', failed);
    };
    const failed = () => {
      cleanup();
      if (worker === child) worker = undefined;
      child.kill('SIGKILL');
      reject(new CodecUnavailable());
    };
    const reply = (msg: unknown) => {
      cleanup();
      idle = setTimeout(() => {
        if (worker === child) {
          worker = undefined;
          child.disconnect();
        }
      }, 30_000);
      idle.unref();
      try {
        const value = msg as { output?: string; code?: string };
        if (value.code) throw Error(value.code);
        if (typeof value.output !== 'string' || value.output.length > 1_000_000)
          throw Error('Invalid codec result');
        const parsed = JSON.parse(value.output);
        if (!serializable(parsed)) throw Error('Invalid codec result');
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    };
    const timer = setTimeout(failed, 5000);
    child.once('message', reply);
    child.once('exit', failed);
    child.once('error', failed);
    child.send({ source, request }, (err) => {
      if (err && worker === child) failed();
    });
  });
}
function runCodec<T>(bytes: Uint8Array, request: unknown): Promise<T> {
  if (queued >= 64) return Promise.reject(new CodecUnavailable());
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  queued++;
  const next = tail
    .then(() => dispatch<T>(source, request))
    .finally(() => {
      queued--;
    });
  tail = next.then(
    () => {},
    () => {},
  );
  return next;
}
export async function validateSharedContent<T>(
  verified: VerifiedPackage,
  lookup: PackagePinLookup,
  content: T,
  from?: string,
): Promise<T> {
  if (!serializable(content)) throw Error('Invalid document');
  const codec = admittedCodec(verified, lookup);
  const checked = await runCodec<{ content: T }>(codec.read(), {
    mode: from ? 'migrate' : 'validate',
    content,
    from,
  });
  codec.assertTrusted();
  return checked.content;
}
export async function sharedAnchorExists(
  verified: VerifiedPackage,
  lookup: PackagePinLookup,
  content: unknown,
  target: string,
) {
  const codec = admittedCodec(verified, lookup);
  const value = await runCodec<{ exists: boolean }>(codec.read(), {
    mode: 'anchor',
    content,
    target,
  });
  codec.assertTrusted();
  return value.exists === true;
}
function stamp(stamps: Record<string, number>, key: string) {
  let latest = Object.hasOwn(stamps, key) ? stamps[key] : 0;
  for (const [child, value] of Object.entries(stamps))
    if (child.startsWith(key + '/')) latest = Math.max(value, latest);
  return latest;
}
/** Pure preparation against Host-owned snapshots. The caller must CAS the current revision at commit. */
export async function prepareSharedEdit<T>(
  verified: VerifiedPackage,
  codecPin: PackagePinLookup,
  principal: () => Principal,
  request: SharedRequest,
  base: SharedSnapshot<T>,
  current: SharedSnapshot<T>,
) {
  const codec = admittedCodec(verified, codecPin);
  const checkWrite = () => {
    const user = principal();
    if (
      !user.writable ||
      (user.expiresAt !== undefined && user.expiresAt <= Date.now()) ||
      !verified.manifest.permissions.includes('artifact:write') ||
      !verified.manifest.permissions.includes('artifact:read')
    )
      throw Error('unauthorized');
    return user;
  };
  checkWrite();
  if (
    !Array.isArray(request.conditions) ||
    !serializable(request) ||
    canonical(request).length > 1_000_000 ||
    request.protocol !== 2 ||
    request.schema !== 1 ||
    request.domain !== codec.domain ||
    request.baseRevision !== base.revision ||
    base.revision > current.revision ||
    ![base, current].every(
      (s) => s.generation === request.generation && s.artifactId === request.artifactId,
    ) ||
    Object.keys(request).some(
      (k) =>
        ![
          'protocol',
          'schema',
          'domain',
          'artifactId',
          'generation',
          'operationId',
          'baseRevision',
          'declaration',
          'input',
          'conditions',
        ].includes(k),
    )
  )
    throw Error('protocol-error');
  if (
    !codec.declaration.operations.some(
      (d) => d.id === request.declaration?.id && d.version === request.declaration.version,
    )
  )
    throw Error('unsupported-operation');
  const problems = operationInputProblems(
    verified.manifest.addons!.operations!.declarations,
    request.declaration,
    request.input,
  );
  if (problems.length) throw Error(problems[0]);
  return evaluateShared(
    codec,
    checkWrite,
    { declaration: request.declaration, input: request.input },
    base,
    current,
    request.conditions,
  );
}

/** Authority-only path for replaying the recorded inverse of an owned edit. */
export async function evaluateShared<T>(
  codec: ReturnType<typeof admittedCodec>,
  checkWrite: () => Principal,
  intent: { declaration: SharedRequest['declaration']; input: unknown } | { inverse: unknown[] },
  base: SharedSnapshot<T>,
  current: SharedSnapshot<T>,
  conditions?: Condition[],
  restoredByOwner?: (key: string) => boolean,
) {
  const evaluated = await runCodec<Evaluation<T>>(codec.read(), {
    ...intent,
    base: base.content,
    current: current.content,
  });
  codec.assertTrusted();
  const user = checkWrite();
  const { expected, expectedTargets, result, before, now } = evaluated;
  if (!user.scopes.includes('*') && !result.targets.every((t) => user.scopes.includes(t)))
    throw Error('unauthorized');
  if (
    canonical(expected) !== canonical(result.required) ||
    canonical(expectedTargets) !== canonical(result.targets) ||
    (conditions !== undefined &&
      (!Array.isArray(conditions) || conditions.length !== expected.length))
  )
    throw Error('stale-precondition');
  const byKey = new Map(conditions?.map((c) => [c.key, c]));
  for (const [i, key] of expected.entries()) {
    const condition = byKey.get(key);
    if (
      (conditions !== undefined &&
        (!condition ||
          condition.stamp !== stamp(base.stamps, key) ||
          condition.fingerprint !== fingerprint(before[i]))) ||
      (stamp(base.stamps, key) !== stamp(current.stamps, key) && !restoredByOwner?.(key)) ||
      fingerprint(before[i]) !== fingerprint(now[i])
    )
      throw Error('stale-precondition');
  }
  const revision = current.revision + 1;
  return {
    touched: result.touched,
    targets: result.targets,
    expectedRevision: current.revision,
    snapshot: {
      ...current,
      revision,
      content: result.content,
      stamps: {
        ...current.stamps,
        ...Object.fromEntries(result.touched.map((key) => [key, revision])),
      },
    },
    inverse: result.inverse,
  };
}
