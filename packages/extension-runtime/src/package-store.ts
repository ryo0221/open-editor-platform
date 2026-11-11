/**
 * Retention of verified Extension packages across restarts (#500 E2, first step).
 *
 * The Host owns storage: it provides a `PackageStorageAdapter` (IndexedDB, a directory, …). This
 * module owns the shared protocol on top of it: only bytes that passed `verifyExtensionPackage`
 * are retained; a new package is staged, read back and re-verified before an explicit activation;
 * a failed, corrupt or interrupted install never becomes the active record; and on restart the
 * retained bytes are verified again against the Host pin before anything is loaded.
 *
 * Trust still comes only from the Host pin lookup. A retained record is data: its stored
 * `packageHash` is never used as a trust decision.
 *
 * A damaged record is never replaced implicitly; `repairRetainedPackage` replaces it explicitly
 * with bytes the Host pin admits.
 *
 * Removing retained bytes is a separate, explicit Host operation (`removeRetainedPackage`), not
 * part of uninstalling an Editor from the registry. It is refused while the Host reports any
 * holder (saved version, draft, reachable Undo/Redo, running job), and it leaves a removal record
 * so that the same id@version can never later be retained as a different package.
 */
import {
  describeExtensionPackage,
  verifyExtensionPackage,
  type ExtensionPackage,
  type PackageManifest,
  type PackagePinLookup,
  type VerifiedPackage,
} from './package';

/** Exact admitted bytes of one package version, as the Host stores them. */
export interface RetainedPackage {
  manifest: PackageManifest;
  entry: string;
  files: { path: string; bytes: Uint8Array }[];
  /** The hash these bytes had when retained. Informational: never trusted on its own. */
  packageHash: string;
}

/**
 * Host-owned storage. Every method either completes or leaves storage as it was (throw on
 * quota, I/O or interruption). Staged records are invisible to `read`.
 */
export interface PackageStorageAdapter {
  /** Stores a complete copy as a new staged record and returns its token. */
  stage(record: RetainedPackage): Promise<string>;
  readStaged(token: string): Promise<RetainedPackage | undefined>;
  /**
   * Atomically makes the staged record the active record for its id@version and consumes the
   * token. Must refuse (and change nothing) when an active record with another packageHash exists,
   * except with `replacing`: then an active record must exist and its stored packageHash must be
   * exactly `replacing` (compare-and-swap used only by repair), or nothing changes.
   */
  activate(token: string, options?: { replacing: string }): Promise<void>;
  discard(token: string): Promise<void>;
  /** Tokens of staged records, including ones left by an interrupted install. */
  staged(): Promise<string[]>;
  read(id: string, version: string): Promise<RetainedPackage | undefined>;
  /**
   * Atomically deletes the active record for id@version, only if its packageHash equals
   * `packageHash`, and keeps that hash as the id@version's removal record (bytes are not kept).
   * Must refuse (and change nothing) otherwise. `activate` must then refuse another packageHash
   * for this id@version, as it does for an active record.
   */
  remove(id: string, version: string, packageHash: string): Promise<void>;
  /** The packageHash of a removed id@version, if it was ever removed. */
  removed(id: string, version: string): Promise<string | undefined>;
}

/**
 * Host-owned answer to "who still needs these bytes": saved document versions, drafts,
 * reachable Undo/Redo entries, running jobs. Each entry is a human-readable holder description.
 * The Host keeps the lease bookkeeping in its own history and storage; this module only asks.
 */
export type PackageReferences = (
  id: string,
  version: string,
) => readonly string[] | Promise<readonly string[]>;

export type PackageRetentionFailure =
  /** The Host does not trust this id@version (unknown, revoked or withdrawn pin). */
  | 'untrusted'
  /** Nothing is retained for this id@version. */
  | 'missing'
  /** The retained or staged bytes are damaged or incomplete. */
  | 'corrupt'
  /** Intact bytes of a different package than the one the Host now pins. */
  | 'pin-mismatch'
  /** A different package is already retained for this id@version; it is never overwritten. */
  | 'conflict'
  /** The Host still needs this id@version (saved versions, drafts, history, jobs). */
  | 'referenced'
  /** The storage adapter failed (quota, I/O, interruption). */
  | 'storage';

export class PackageRetentionError extends Error {
  /** For `referenced`: what still needs the package, as the Host reported it. */
  readonly holders: readonly string[];
  constructor(
    readonly code: PackageRetentionFailure,
    message: string,
    options?: { cause?: unknown; holders?: readonly string[] },
  ) {
    super(message, options);
    this.name = 'PackageRetentionError';
    this.holders = Object.freeze([...(options?.holders ?? [])]);
  }
}

const asPackage = (record: RetainedPackage): ExtensionPackage => ({
  manifest: record.manifest,
  entry: record.entry,
  files: record.files,
});

async function hashOf(record: RetainedPackage) {
  try {
    return (await describeExtensionPackage(asPackage(record))).hash;
  } catch {
    return undefined;
  }
}

function assertTrusted(verified: VerifiedPackage) {
  try {
    verified.assertTrusted();
  } catch (cause) {
    const { id, version } = verified.manifest;
    throw new PackageRetentionError('untrusted', `${id}@${version} is not trusted`, { cause });
  }
}

async function storage<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof PackageRetentionError) throw cause;
    throw new PackageRetentionError('storage', `Package storage failed: ${what}`, { cause });
  }
}

async function stageAndActivate(
  store: PackageStorageAdapter,
  verified: VerifiedPackage,
  options?: { replacing: string },
) {
  const { id, version } = verified.manifest;
  const { packageHash, ...manifest } = verified.manifest;
  const record: RetainedPackage = {
    manifest: structuredClone(manifest),
    entry: verified.entry,
    files: verified.paths.map((path) => ({ path, bytes: verified.readFile(path) })),
    packageHash,
  };
  const token = await storage('stage', () => store.stage(record));
  try {
    const staged = await storage('read staged', () => store.readStaged(token));
    if (!staged || (await hashOf(staged)) !== packageHash)
      throw new PackageRetentionError('corrupt', `Staged copy of ${id}@${version} is not intact`);
    // The pin may have been revoked while staging; never activate an untrusted package.
    assertTrusted(verified);
    await storage('activate', () =>
      options ? store.activate(token, options) : store.activate(token),
    );
  } catch (error) {
    await store.discard(token).catch(() => undefined);
    throw error;
  }
}

/**
 * Retains the exact verified bytes. Idempotent for the same package; refuses a different package
 * under an id@version that is already retained. On any failure the active record is unchanged
 * and the staged copy is discarded (best effort; `discardInterruptedInstalls` covers the rest).
 */
export async function retainVerifiedPackage(
  store: PackageStorageAdapter,
  verified: VerifiedPackage,
): Promise<'retained' | 'already-retained'> {
  assertTrusted(verified);
  const { id, version, packageHash } = verified.manifest;
  const existing = await storage('read', () => store.read(id, version));
  if (existing) {
    const existingHash = await hashOf(existing);
    if (existingHash === packageHash) return 'already-retained';
    // A damaged record is reported, never silently replaced: its owner must repair it explicitly.
    if (existingHash === undefined || existingHash !== existing.packageHash)
      throw new PackageRetentionError('corrupt', `Retained ${id}@${version} is not intact`);
    throw new PackageRetentionError(
      'conflict',
      `Another package is already retained as ${id}@${version}`,
    );
  }
  // A removed id@version stays bound to the package it held (historical pins are not rewritten).
  const removedHash = await storage('read removed', () => store.removed(id, version));
  if (removedHash !== undefined && removedHash !== packageHash)
    throw new PackageRetentionError(
      'conflict',
      `${id}@${version} was retained before as another package`,
    );
  await stageAndActivate(store, verified);
  return 'retained';
}

/**
 * Explicit repair of a damaged retained record: replaces it with `verified` bytes, which the Host
 * pin admits for the same id@version. Only a record that no longer reproduces its own stored
 * hash is replaced; an intact one is `intact` (unchanged), an intact different build is
 * `conflict` (never overwritten), and nothing retained is `missing`. The replacement goes through
 * the same stage → read back → recheck pin path, and the swap is atomic against the exact damaged
 * record read here. Callers decide when to repair; nothing repairs on its own.
 */
export async function repairRetainedPackage(
  store: PackageStorageAdapter,
  verified: VerifiedPackage,
): Promise<'repaired' | 'intact'> {
  assertTrusted(verified);
  const { id, version, packageHash } = verified.manifest;
  const existing = await storage('read', () => store.read(id, version));
  if (!existing) throw new PackageRetentionError('missing', `${id}@${version} is not retained`);
  const existingHash = await hashOf(existing);
  if (existingHash !== undefined && existingHash === existing.packageHash) {
    if (existingHash === packageHash) return 'intact';
    throw new PackageRetentionError(
      'conflict',
      `Another package is already retained as ${id}@${version}`,
    );
  }
  const removedHash = await storage('read removed', () => store.removed(id, version));
  if (removedHash !== undefined && removedHash !== packageHash)
    throw new PackageRetentionError(
      'conflict',
      `${id}@${version} was retained before as another package`,
    );
  await stageAndActivate(store, verified, { replacing: String(existing.packageHash) });
  return 'repaired';
}

/**
 * Restart path: reads the retained bytes and verifies them against the Host pin. The result is an
 * ordinary VerifiedPackage for loadVerifiedExtension; refusals say why it cannot be loaded.
 */
export async function restoreRetainedPackage(
  store: PackageStorageAdapter,
  id: string,
  version: string,
  lookup: PackagePinLookup,
): Promise<VerifiedPackage> {
  const pin = lookup(id, version);
  if (!pin) throw new PackageRetentionError('untrusted', `${id}@${version} is not trusted`);
  const record = await storage('read', () => store.read(id, version));
  if (!record) throw new PackageRetentionError('missing', `${id}@${version} is not retained`);
  const hash = await hashOf(record);
  if (hash !== pin)
    // Intact means the bytes still reproduce the hash they were retained with.
    throw hash !== undefined && hash === record.packageHash
      ? new PackageRetentionError('pin-mismatch', `${id}@${version} differs from the Host pin`)
      : new PackageRetentionError('corrupt', `Retained ${id}@${version} is not intact`);
  try {
    return await verifyExtensionPackage(asPackage(record), lookup);
  } catch (cause) {
    // The pin changed between the check above and verification.
    throw new PackageRetentionError('untrusted', `${id}@${version} is not trusted`, { cause });
  }
}

async function holdersOf(references: PackageReferences, id: string, version: string) {
  const holders = await references(id, version);
  if (holders.length)
    throw new PackageRetentionError(
      'referenced',
      `${id}@${version} is still needed by: ${holders.join(', ')}`,
      { holders },
    );
}

/**
 * Explicitly removes the retained bytes of one id@version. Refused (`referenced`) while the Host
 * reports any holder, and for a damaged record (`corrupt`, left in place for an explicit repair).
 * Trust is not consulted: a revoked package may be removed, and removal never grants anything.
 *
 * The Host must not add a holder for this id@version while the call runs (it runs the call inside
 * its own exclusive section for package changes); holders are asked again just before removal.
 * Uninstalling an Editor from the registry does not call this.
 */
export async function removeRetainedPackage(
  store: PackageStorageAdapter,
  id: string,
  version: string,
  references: PackageReferences,
): Promise<'removed'> {
  await holdersOf(references, id, version);
  const record = await storage('read', () => store.read(id, version));
  if (!record) throw new PackageRetentionError('missing', `${id}@${version} is not retained`);
  const hash = await hashOf(record);
  if (hash === undefined || hash !== record.packageHash)
    throw new PackageRetentionError('corrupt', `Retained ${id}@${version} is not intact`);
  await holdersOf(references, id, version);
  await storage('remove', () => store.remove(id, version, hash));
  return 'removed';
}

/**
 * Discards staged records left by interrupted installs. Active records are never touched.
 * Call it at Host start-up, before any install runs: it also discards an install in progress.
 */
export async function discardInterruptedInstalls(store: PackageStorageAdapter): Promise<number> {
  const tokens = await storage('list staged', () => store.staged());
  for (const token of tokens) await storage('discard', () => store.discard(token));
  return tokens.length;
}

/**
 * Reference adapter kept in memory (tests and examples). Not durable. Records are copied in and
 * out so callers cannot change what is stored.
 */
export function createMemoryPackageStorage(): PackageStorageAdapter & {
  /** Direct access for fault-injection tests. */
  readonly active: Map<string, RetainedPackage>;
  readonly pending: Map<string, RetainedPackage>;
  readonly removals: Map<string, string>;
} {
  const active = new Map<string, RetainedPackage>();
  const pending = new Map<string, RetainedPackage>();
  const removals = new Map<string, string>();
  const key = (id: string, version: string) => `${id}@${version}`;
  const copy = (r: RetainedPackage): RetainedPackage => structuredClone(r);
  let next = 0;
  return {
    active,
    pending,
    removals,
    async stage(record) {
      const token = `staged-${++next}`;
      pending.set(token, copy(record));
      return token;
    },
    async readStaged(token) {
      const r = pending.get(token);
      return r && copy(r);
    },
    async activate(token, options) {
      const r = pending.get(token);
      if (!r) throw Error('Unknown staged package');
      const k = key(r.manifest.id, r.manifest.version);
      const current = active.get(k);
      if (options) {
        if (!current || String(current.packageHash) !== options.replacing)
          throw Error('Retained package changed');
      } else if (current && current.packageHash !== r.packageHash)
        throw Error('Another package is active for this id@version');
      const removed = removals.get(k);
      if (removed !== undefined && removed !== r.packageHash)
        throw Error('Another package was removed for this id@version');
      active.set(k, r);
      pending.delete(token);
    },
    async discard(token) {
      pending.delete(token);
    },
    async staged() {
      return [...pending.keys()];
    },
    async read(id, version) {
      const r = active.get(key(id, version));
      return r && copy(r);
    },
    async remove(id, version, packageHash) {
      const k = key(id, version);
      if (active.get(k)?.packageHash !== packageHash) throw Error('Retained package changed');
      removals.set(k, packageHash);
      active.delete(k);
    },
    async removed(id, version) {
      return removals.get(key(id, version));
    },
  };
}
