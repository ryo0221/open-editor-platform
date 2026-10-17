/** Private opt-in logical OPFS accounting. No physical-disk, memory or GC contract. */
import { canonicalJson } from '@editor-platform/artifact-core';
import { need } from '../portable/io';
export interface TotalCapacityPolicy {
  totalBytes: number;
  /** Host allowance for IDB/ledger and other unmeasured management storage. */
  managementBytes: number;
  maxEntries: number;
  maxDepth: number;
  maxReservations: number;
}
interface Reservation {
  id: string;
  scratchPath: string;
  candidatePath: string | null;
  archiveBytes: number;
}
interface Root {
  format: 'video-total-capacity-v1';
  policy: TotalCapacityPolicy;
  reservations: Reservation[];
}
export interface CapacityUsage {
  kind: 'logical-opfs';
  policy: TotalCapacityPolicy;
  /** All origin OPFS files, including closed/legacy/unrecognized namespaces. */
  observedBytes: number;
  reservedAdditionalBytes: number;
  accountedBytes: number;
  availableBytes: number;
  overBudget: boolean;
  namespaces: { name: string; bytes: number; files: number }[];
  reservations: { id: string; archiveBytes: number; reservedAdditionalBytes: number }[];
  physicalDiskGuaranteed: false;
}
const database = 'video-total-capacity-v1';
const lock = 'video-total-capacity-v1';
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
function policyValid(p: TotalCapacityPolicy) {
  need(
    p &&
      Object.keys(p).sort().join(',') ===
        'managementBytes,maxDepth,maxEntries,maxReservations,totalBytes',
    'Capacity policy fields',
  );
  need(
    positive(p.totalBytes) &&
      Number.isSafeInteger(p.managementBytes) &&
      p.managementBytes >= 0 &&
      p.managementBytes < p.totalBytes &&
      positive(p.maxEntries) &&
      positive(p.maxDepth) &&
      positive(p.maxReservations),
    'Capacity policy',
  );
}
function safeSum(a: number, b: number) {
  const n = a + b;
  need(Number.isSafeInteger(n) && n >= 0, 'Capacity accounting overflow');
  return n;
}
function ownedPath(path: string, kind: 'preparation' | 'candidate') {
  return new RegExp('^[a-z0-9-]{1,64}/' + kind + '-[a-f0-9-]{36}$').test(path);
}
function validate(root: Root, policy: TotalCapacityPolicy) {
  need(
    root &&
      Object.keys(root).sort().join(',') === 'format,policy,reservations' &&
      root.format === 'video-total-capacity-v1' &&
      canonicalJson(root.policy) === canonicalJson(policy) &&
      Array.isArray(root.reservations) &&
      root.reservations.length <= policy.maxReservations,
    'Capacity ledger/policy mismatch',
  );
  const ids = new Set<string>(),
    paths = new Set<string>();
  for (const r of root.reservations) {
    need(
      r &&
        Object.keys(r).sort().join(',') === 'archiveBytes,candidatePath,id,scratchPath' &&
        typeof r.id === 'string' &&
        /^[a-z0-9-]{1,64}:[a-zA-Z0-9_-]{1,128}$/.test(r.id) &&
        !ids.has(r.id) &&
        positive(r.archiveBytes) &&
        r.archiveBytes <= policy.totalBytes &&
        ownedPath(r.scratchPath, 'preparation') &&
        !paths.has(r.scratchPath) &&
        (r.candidatePath === null ||
          (ownedPath(r.candidatePath, 'candidate') &&
            r.candidatePath.startsWith(r.id.split(':')[0] + '/') &&
            !paths.has(r.candidatePath))),
      'Capacity reservation',
    );
    ids.add(r.id);
    paths.add(r.scratchPath);
    if (r.candidatePath) paths.add(r.candidatePath);
  }
}
type Directory = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
};
async function inventory(policy: TotalCapacityPolicy) {
  const files = new Map<string, number>();
  let entries = 0;
  async function walk(dir: FileSystemDirectoryHandle, prefix: string, depth: number) {
    need(depth <= policy.maxDepth, 'Capacity scan depth');
    for await (const [name, handle] of (dir as Directory).entries()) {
      need(++entries <= policy.maxEntries, 'Capacity scan entries');
      const path = prefix + name;
      if (handle.kind === 'directory')
        await walk(handle as FileSystemDirectoryHandle, path + '/', depth + 1);
      else {
        const size = (await (handle as FileSystemFileHandle).getFile()).size;
        need(Number.isSafeInteger(size) && size >= 0, 'Capacity file size');
        files.set(path, size);
      }
    }
  }
  await walk(await navigator.storage.getDirectory(), '', 0);
  return files;
}
function usage(root: Root, files: Map<string, number>): CapacityUsage {
  let observedBytes = 0,
    reservedAdditionalBytes = 0;
  const groups = new Map<string, { name: string; bytes: number; files: number }>();
  for (const [path, size] of files) {
    observedBytes = safeSum(observedBytes, size);
    const name = path.includes('/') ? path.split('/')[0] : '(root)';
    const group = groups.get(name) ?? { name, bytes: 0, files: 0 };
    group.bytes = safeSum(group.bytes, size);
    group.files++;
    groups.set(name, group);
  }
  const reservations = root.reservations.map((r) => {
    // A writable's invisible temporary bytes remain covered by the full reservation.
    const scratch = files.get(r.scratchPath) ?? 0;
    const candidate = r.candidatePath ? (files.get(r.candidatePath) ?? 0) : 0;
    need(scratch <= r.archiveBytes && candidate <= r.archiveBytes, 'Reserved file exceeded bound');
    const additional = safeSum(r.archiveBytes - scratch, r.archiveBytes - candidate);
    reservedAdditionalBytes = safeSum(reservedAdditionalBytes, additional);
    return { id: r.id, archiveBytes: r.archiveBytes, reservedAdditionalBytes: additional };
  });
  const accountedBytes = safeSum(
    safeSum(observedBytes, reservedAdditionalBytes),
    root.policy.managementBytes,
  );
  return {
    kind: 'logical-opfs',
    policy: structuredClone(root.policy),
    observedBytes,
    reservedAdditionalBytes,
    accountedBytes,
    availableBytes: Math.max(0, root.policy.totalBytes - accountedBytes),
    overBudget: accountedBytes > root.policy.totalBytes,
    namespaces: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
    reservations,
    physicalDiskGuaranteed: false,
  };
}
/** One fixed origin-wide DB/lock. All participating writers must use the same explicit policy. */
export class TotalCapacity {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly policy: TotalCapacityPolicy,
  ) {}
  static async open(policy: TotalCapacityPolicy) {
    policyValid(policy);
    const captured = structuredClone(policy);
    return navigator.locks.request(lock, async () => {
      let created = false;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(database, 1);
        r.onupgradeneeded = () => {
          created = true;
          r.result.createObjectStore('capacity');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(Error('Capacity database blocked'));
      });
      db.onversionchange = () => db.close();
      const capacity = new TotalCapacity(db, captured);
      try {
        if (created)
          await capacity.put({
            format: 'video-total-capacity-v1',
            policy: captured,
            reservations: [],
          });
        await capacity.read();
        return capacity;
      } catch (error) {
        db.close();
        throw error;
      }
    });
  }
  close() {
    this.db.close();
  } // Does not release durable reservations or remove any files.
  private read(): Promise<Root> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('capacity', 'readonly');
      const request = tx.objectStore('capacity').get('root');
      request.onsuccess = () => {
        try {
          validate(request.result, this.policy);
          resolve(structuredClone(request.result));
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  private put(root: Root): Promise<void> {
    validate(root, this.policy);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('capacity', 'readwrite', { durability: 'strict' });
      tx.objectStore('capacity').put(root, 'root');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? Error('Capacity commit unknown'));
    });
  }
  async inspect(): Promise<CapacityUsage> {
    return navigator.locks.request(lock, async () =>
      usage(await this.read(), await inventory(this.policy)),
    );
  }
  async reserve(id: string, scratchPath: string, archiveBytes: number) {
    return navigator.locks.request(lock, async () => {
      const root = await this.read(),
        files = await inventory(this.policy);
      need(
        !root.reservations.some((r) => r.id === id) && !files.has(scratchPath),
        'Capacity identity reused',
      );
      root.reservations.push({ id, scratchPath, candidatePath: null, archiveBytes });
      validate(root, this.policy);
      const next = usage(root, files);
      need(!next.overBudget, 'Total capacity before scratch');
      await this.put(root);
      return next;
    });
  }
  /** After journal intent, before file creation; exact preparation path proves reservation ownership. */
  async candidate(id: string, scratchPath: string, path: string) {
    return navigator.locks.request(lock, async () => {
      const root = await this.read(),
        files = await inventory(this.policy);
      const r = root.reservations.find((r) => r.id === id);
      need(r && r.scratchPath === scratchPath, 'Capacity reservation owner');
      need(r.candidatePath === null && !files.has(path), 'Capacity candidate identity');
      need(path.startsWith(r.id.split(':')[0] + '/'), 'Capacity candidate namespace');
      r.candidatePath = path;
      validate(root, this.policy);
      need(!usage(root, files).overBudget, 'Total capacity before candidate');
      await this.put(root);
    });
  }
  /** Requires the original preparation path, final correlated evidence and completed scratch cleanup. */
  async settle(id: string, scratchPath: string, outcome: 'committed' | 'no-write') {
    return navigator.locks.request(lock, async () => {
      const root = await this.read(),
        files = await inventory(this.policy);
      const r = root.reservations.find((r) => r.id === id);
      if (!r) return; // Admission may have refused before committing a reservation.
      need(r.scratchPath === scratchPath, 'Capacity reservation owner');
      need(!files.has(r.scratchPath), 'Scratch still owns capacity');
      need(
        outcome === 'committed'
          ? r.candidatePath !== null && files.get(r.candidatePath) === r.archiveBytes
          : r.candidatePath === null || !files.has(r.candidatePath),
        'Capacity settlement files',
      );
      root.reservations = root.reservations.filter((entry) => entry.id !== id);
      await this.put(root);
    });
  }
}
