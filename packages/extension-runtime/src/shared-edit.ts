import { execFile } from 'node:child_process';
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
function runCodec<T>(bytes: Uint8Array, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      // Compile the VM before starting the guest CPU meter. Lazy Wasm compilation
      // otherwise charges cold native compiler work to the first editor operation.
      [
        '--no-wasm-async-compilation',
        '--no-wasm-lazy-compilation',
        '--no-wasm-tier-up',
        fileURLToPath(new URL('./shared-codec-worker.mjs', import.meta.url)),
      ],
      { env: {}, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4_000_000 },
      (error, stdout) => {
        if (error) return reject(new Error('Shared codec rejected the transaction'));
        try {
          const output = JSON.parse(stdout);
          if (!serializable(output)) throw Error('Invalid codec response');
          if (output?.code) throw Error(output.code);
          resolve(output);
        } catch (e) {
          reject(e);
        }
      },
    );
    child.stdin!.on('error', reject);
    child.stdin!.end(
      JSON.stringify({ source: new TextDecoder('utf-8', { fatal: true }).decode(bytes), request }),
    );
  });
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
      stamp(base.stamps, key) !== stamp(current.stamps, key) ||
      fingerprint(before[i]) !== fingerprint(now[i])
    )
      throw Error('stale-precondition');
  }
  const revision = current.revision + 1;
  return {
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
