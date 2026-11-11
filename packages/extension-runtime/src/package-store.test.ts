import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@editor-platform/extension-contract';
import { ExtensionRegistry } from './index';
import {
  describeExtensionPackage,
  installVerifiedExtension,
  loadVerifiedExtension,
  verifyExtensionPackage,
  type ExtensionPackage,
  type PackageManifest,
} from './package';
import {
  createMemoryPackageStorage,
  discardInterruptedInstalls,
  PackageRetentionError,
  removeRetainedPackage,
  repairRetainedPackage,
  restoreRetainedPackage,
  retainVerifiedPackage,
  type PackageStorageAdapter,
} from './package-store';

const encode = (text: string) => new TextEncoder().encode(text);
const importData = (bytes: Uint8Array) =>
  import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`);

function manifest(version = '1.0.0'): PackageManifest {
  return {
    contractVersion: CONTRACT_VERSION,
    id: 'example.notes-editor',
    version,
    artifactKind: 'example.notes',
    schemaVersion: 1,
    capabilities: ['local-edit'],
    permissions: ['artifact:read', 'artifact:write'],
    licenseNotices: ['Test fixture; no license grant.'],
  };
}
function pkg(version = '1.0.0', marker = 'a'): ExtensionPackage {
  const m = manifest(version);
  return {
    manifest: m,
    entry: 'entry.js',
    files: [
      {
        path: 'entry.js',
        bytes: encode(`const manifest = ${JSON.stringify(m)};
export const marker = ${JSON.stringify(marker)};
export function definition(packageHash) {
  return { manifest: { ...manifest, packageHash }, validate: (v) => typeof v?.text === 'string' };
}`),
      },
      { path: 'NOTICE.txt', bytes: encode(`Notice ${marker}`) },
    ],
  };
}
/** Host-owned allowlist (reviewed config); mutable to model revocation. */
function pins() {
  const map = new Map<string, string>();
  return {
    map,
    async pin(input: ExtensionPackage) {
      const hash = (await describeExtensionPackage(input)).hash;
      map.set(`${input.manifest.id}@${input.manifest.version}`, hash);
      return hash;
    },
    lookup: (id: string, version: string) => map.get(`${id}@${version}`),
  };
}
const code = (error: unknown) => (error instanceof PackageRetentionError ? error.code : error);
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return code(error);
  }
  throw Error('Expected a refusal');
}

describe('retainVerifiedPackage / restoreRetainedPackage', () => {
  it('retains exact verified bytes and reopens them after a restart', async () => {
    const trust = pins();
    await trust.pin(pkg());
    // Session 1: verify supplied bytes, retain them.
    const store = createMemoryPackageStorage();
    const verified = await verifyExtensionPackage(pkg(), trust.lookup);
    expect(await retainVerifiedPackage(store, verified)).toBe('retained');
    expect(await retainVerifiedPackage(store, verified)).toBe('already-retained');
    expect(store.pending.size).toBe(0);
    // Session 2: the original source is gone; only the Host store and the Host pin remain.
    const restored = await restoreRetainedPackage(
      store,
      'example.notes-editor',
      '1.0.0',
      trust.lookup,
    );
    expect(restored.manifest).toEqual(verified.manifest);
    expect(restored.paths).toEqual(['NOTICE.txt', 'entry.js']);
    const loaded = await loadVerifiedExtension(restored, { importModule: importData });
    const registration = installVerifiedExtension(new ExtensionRegistry(), loaded);
    expect(registration.manifest.packageHash).toBe(verified.manifest.packageHash);
  });

  it('keeps stored records independent of caller and returned copies', async () => {
    const trust = pins();
    await trust.pin(pkg());
    const store = createMemoryPackageStorage();
    await retainVerifiedPackage(store, await verifyExtensionPackage(pkg(), trust.lookup));
    const read = await store.read('example.notes-editor', '1.0.0');
    read!.files[0].bytes.fill(0);
    const restored = await restoreRetainedPackage(
      store,
      'example.notes-editor',
      '1.0.0',
      trust.lookup,
    );
    expect(new TextDecoder().decode(restored.readFile('NOTICE.txt'))).toBe('Notice a');
  });

  it('distinguishes untrusted, missing, corrupt and pin-mismatch on restart', async () => {
    const trust = pins();
    const original = await trust.pin(pkg());
    const store = createMemoryPackageStorage();
    await retainVerifiedPackage(store, await verifyExtensionPackage(pkg(), trust.lookup));
    const restore = (version = '1.0.0') =>
      restoreRetainedPackage(store, 'example.notes-editor', version, trust.lookup);

    trust.map.delete('example.notes-editor@1.0.0');
    expect(await failure(restore())).toBe('untrusted');
    trust.map.set('example.notes-editor@1.0.0', original);
    await trust.pin(pkg('2.0.0'));
    expect(await failure(restore('2.0.0'))).toBe('missing');

    // Host pin now names a different build of the same id@version: retained bytes are intact.
    trust.map.set(
      'example.notes-editor@1.0.0',
      (await describeExtensionPackage(pkg('1.0.0', 'b'))).hash,
    );
    expect(await failure(restore())).toBe('pin-mismatch');
    trust.map.set('example.notes-editor@1.0.0', original);

    // Damaged bytes under the original pin, and a damaged record claiming the new hash.
    const record = store.active.get('example.notes-editor@1.0.0')!;
    record.files[0].bytes[0] ^= 1;
    expect(await failure(restore())).toBe('corrupt');
    record.packageHash = 'sha256:' + '0'.repeat(64);
    expect(await failure(restore())).toBe('corrupt');
    record.files.pop();
    expect(await failure(restore())).toBe('corrupt');
  });

  it('never overwrites a retained package and reports a damaged one instead', async () => {
    const trust = pins();
    await trust.pin(pkg());
    const store = createMemoryPackageStorage();
    await retainVerifiedPackage(store, await verifyExtensionPackage(pkg(), trust.lookup));
    const before = structuredClone(store.active.get('example.notes-editor@1.0.0'));

    await trust.pin(pkg('1.0.0', 'b'));
    const other = await verifyExtensionPackage(pkg('1.0.0', 'b'), trust.lookup);
    expect(await failure(retainVerifiedPackage(store, other))).toBe('conflict');
    expect(store.active.get('example.notes-editor@1.0.0')).toEqual(before);

    store.active.get('example.notes-editor@1.0.0')!.files[1].bytes[0] ^= 1;
    expect(await failure(retainVerifiedPackage(store, other))).toBe('corrupt');
    expect(store.pending.size).toBe(0);
  });
});

describe('install failures leave the active record unchanged', () => {
  function faulty(overrides: Partial<PackageStorageAdapter>) {
    const store = createMemoryPackageStorage();
    return Object.assign(store, overrides, { active: store.active, pending: store.pending });
  }
  async function retainInto(store: PackageStorageAdapter, trust = pins()) {
    await trust.pin(pkg());
    return retainVerifiedPackage(store, await verifyExtensionPackage(pkg(), trust.lookup));
  }

  it('reports quota/I-O failure while staging and keeps nothing', async () => {
    const store = faulty({
      stage: async () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    });
    expect(await failure(retainInto(store))).toBe('storage');
    expect(store.active.size).toBe(0);
  });

  it('refuses a staged copy that does not read back intact, and discards it', async () => {
    const store = faulty({});
    store.readStaged = async (token) => {
      const record = structuredClone(store.pending.get(token));
      record?.files.pop();
      return record;
    };
    expect(await failure(retainInto(store))).toBe('corrupt');
    expect(store.active.size).toBe(0);
    expect(store.pending.size).toBe(0);
  });

  it('does not activate when the pin is revoked while staging', async () => {
    const trust = pins();
    await trust.pin(pkg());
    const verified = await verifyExtensionPackage(pkg(), trust.lookup);
    const store = faulty({});
    store.readStaged = async (token) => {
      trust.map.clear();
      return structuredClone(store.pending.get(token));
    };
    expect(await failure(retainVerifiedPackage(store, verified))).toBe('untrusted');
    expect(store.active.size).toBe(0);
    expect(store.pending.size).toBe(0);
  });

  it('keeps the previous record when activation fails, then recovers after an interruption', async () => {
    const trust = pins();
    const store = createMemoryPackageStorage();
    await retainInto(store, trust);
    const v1 = structuredClone(store.active.get('example.notes-editor@1.0.0'));
    // Interrupted install of 2.0.0: staged, then the process stops before activate.
    await trust.pin(pkg('2.0.0'));
    const v2 = await verifyExtensionPackage(pkg('2.0.0'), trust.lookup);
    const crashing: PackageStorageAdapter = {
      ...store,
      activate: async () => {
        throw Error('Process stopped');
      },
      discard: async () => {
        /* the process stopped: no cleanup runs */
      },
    };
    expect(await failure(retainVerifiedPackage(crashing, v2))).toBe('storage');
    expect(store.pending.size).toBe(1);
    expect(store.active.get('example.notes-editor@1.0.0')).toEqual(v1);
    expect(await store.read('example.notes-editor', '2.0.0')).toBeUndefined();
    // Restart: the staged leftover is never visible as active and is discarded at start-up.
    expect(
      await failure(restoreRetainedPackage(store, 'example.notes-editor', '2.0.0', trust.lookup)),
    ).toBe('missing');
    expect(await discardInterruptedInstalls(store)).toBe(1);
    expect(store.pending.size).toBe(0);
    expect(await retainVerifiedPackage(store, v2)).toBe('retained');
    await restoreRetainedPackage(store, 'example.notes-editor', '1.0.0', trust.lookup);
    await restoreRetainedPackage(store, 'example.notes-editor', '2.0.0', trust.lookup);
  });
});

describe('removeRetainedPackage', () => {
  const ID = 'example.notes-editor';
  async function retained(trust = pins()) {
    await trust.pin(pkg());
    const store = createMemoryPackageStorage();
    const verified = await verifyExtensionPackage(pkg(), trust.lookup);
    await retainVerifiedPackage(store, verified);
    return { store, trust, verified };
  }

  it('keeps retained bytes when the Editor is uninstalled from the registry', async () => {
    const { store, trust, verified } = await retained();
    const registry = new ExtensionRegistry();
    const registration = installVerifiedExtension(
      registry,
      await loadVerifiedExtension(verified, { importModule: importData }),
    );
    registration.uninstall();
    expect(store.active.size).toBe(1);
    await restoreRetainedPackage(store, ID, '1.0.0', trust.lookup);
  });

  it('refuses while the Host reports holders and changes nothing', async () => {
    const { store } = await retained();
    const before = structuredClone(store.active.get(`${ID}@1.0.0`));
    const error = await removeRetainedPackage(store, ID, '1.0.0', () => [
      'saved version v3',
      'Undo entry',
    ]).catch((e: unknown) => e);
    expect(code(error)).toBe('referenced');
    expect((error as PackageRetentionError).holders).toEqual(['saved version v3', 'Undo entry']);
    expect(store.active.get(`${ID}@1.0.0`)).toEqual(before);
    expect(store.removals.size).toBe(0);
  });

  it('asks the Host again just before removing', async () => {
    const { store } = await retained();
    let calls = 0;
    const references = () => (++calls === 1 ? [] : ['draft opened meanwhile']);
    expect(await failure(removeRetainedPackage(store, ID, '1.0.0', references))).toBe('referenced');
    expect(store.active.size).toBe(1);
  });

  it('removes an unreferenced package, also when its pin was revoked', async () => {
    const { store, trust, verified } = await retained();
    trust.map.clear();
    expect(await removeRetainedPackage(store, ID, '1.0.0', () => [])).toBe('removed');
    expect(await store.read(ID, '1.0.0')).toBeUndefined();
    expect(await store.removed(ID, '1.0.0')).toBe(verified.manifest.packageHash);
    expect(await failure(removeRetainedPackage(store, ID, '1.0.0', () => []))).toBe('missing');
    // Removal grants nothing: restoring needs the Host pin and retained bytes again.
    expect(await failure(restoreRetainedPackage(store, ID, '1.0.0', trust.lookup))).toBe(
      'untrusted',
    );
  });

  it('never lets a removed id@version be retained as another package', async () => {
    const { store, trust, verified } = await retained();
    await removeRetainedPackage(store, ID, '1.0.0', () => []);
    await trust.pin(pkg('1.0.0', 'b'));
    const other = await verifyExtensionPackage(pkg('1.0.0', 'b'), trust.lookup);
    expect(await failure(retainVerifiedPackage(store, other))).toBe('conflict');
    expect(store.active.size).toBe(0);
    expect(store.pending.size).toBe(0);
    // The adapter refuses it too, without the protocol's pre-check.
    const { packageHash, ...manifest } = other.manifest;
    const token = await store.stage({
      manifest,
      entry: other.entry,
      files: other.paths.map((path) => ({ path, bytes: other.readFile(path) })),
      packageHash,
    });
    await expect(store.activate(token)).rejects.toThrow('was removed');
    // The same package may be retained again.
    await trust.pin(pkg());
    expect(await retainVerifiedPackage(store, verified)).toBe('retained');
  });

  it('leaves a damaged record in place', async () => {
    const { store } = await retained();
    store.active.get(`${ID}@1.0.0`)!.files[0].bytes[0] ^= 1;
    expect(await failure(removeRetainedPackage(store, ID, '1.0.0', () => []))).toBe('corrupt');
    expect(store.active.size).toBe(1);
    expect(store.removals.size).toBe(0);
  });

  it('reports a storage failure during removal and keeps the record', async () => {
    const { store } = await retained();
    const failing: PackageStorageAdapter = {
      ...store,
      remove: async () => {
        throw new DOMException('Transaction aborted', 'AbortError');
      },
    };
    expect(await failure(removeRetainedPackage(failing, ID, '1.0.0', async () => []))).toBe(
      'storage',
    );
    expect(store.active.size).toBe(1);
  });
});

describe('repairRetainedPackage', () => {
  const ID = 'example.notes-editor';
  async function damaged(
    damage: (record: { files: { bytes: Uint8Array }[]; packageHash: string }) => void,
  ) {
    const trust = pins();
    await trust.pin(pkg());
    const store = createMemoryPackageStorage();
    const verified = await verifyExtensionPackage(pkg(), trust.lookup);
    await retainVerifiedPackage(store, verified);
    damage(store.active.get(`${ID}@1.0.0`)!);
    return { store, trust, verified };
  }

  it('replaces a damaged record with bytes the Host pin admits, then restores', async () => {
    for (const [damage, restorable] of [
      [(r: { files: { bytes: Uint8Array }[] }) => (r.files[0].bytes[0] ^= 1), false],
      // Bytes intact but the stored hash rewritten: restore still verifies against the pin.
      [(r: { packageHash: string }) => (r.packageHash = 'sha256:' + '0'.repeat(64)), true],
      [(r: { files: unknown[] }) => r.files.pop(), false],
    ] as const) {
      const { store, trust, verified } = await damaged(damage as never);
      const restore = restoreRetainedPackage(store, ID, '1.0.0', trust.lookup);
      if (restorable) await restore;
      else expect(await failure(restore)).toBe('corrupt');
      expect(await repairRetainedPackage(store, verified)).toBe('repaired');
      expect(store.pending.size).toBe(0);
      const restored = await restoreRetainedPackage(store, ID, '1.0.0', trust.lookup);
      expect(restored.manifest.packageHash).toBe(verified.manifest.packageHash);
      expect(await repairRetainedPackage(store, verified)).toBe('intact');
    }
  });

  it('never overwrites an intact record, and needs something retained', async () => {
    const { store, trust, verified } = await damaged(() => undefined);
    expect(await repairRetainedPackage(store, verified)).toBe('intact');
    await trust.pin(pkg('1.0.0', 'b'));
    const other = await verifyExtensionPackage(pkg('1.0.0', 'b'), trust.lookup);
    const before = structuredClone(store.active.get(`${ID}@1.0.0`));
    expect(await failure(repairRetainedPackage(store, other))).toBe('conflict');
    expect(store.active.get(`${ID}@1.0.0`)).toEqual(before);
    await trust.pin(pkg('2.0.0'));
    const v2 = await verifyExtensionPackage(pkg('2.0.0'), trust.lookup);
    expect(await failure(repairRetainedPackage(store, v2))).toBe('missing');
  });

  it('refuses an untrusted replacement and one revoked while staging', async () => {
    const { store, trust, verified } = await damaged((r) => (r.files[0].bytes[0] ^= 1));
    const before = structuredClone(store.active.get(`${ID}@1.0.0`));
    trust.map.clear();
    expect(await failure(repairRetainedPackage(store, verified))).toBe('untrusted');
    await trust.pin(pkg());
    const revoking: PackageStorageAdapter = {
      ...store,
      readStaged: async (token) => {
        trust.map.clear();
        return store.readStaged(token);
      },
    };
    expect(await failure(repairRetainedPackage(revoking, verified))).toBe('untrusted');
    expect(store.active.get(`${ID}@1.0.0`)).toEqual(before);
    expect(store.pending.size).toBe(0);
  });

  it('does not replace a record that changed after it was read', async () => {
    const { store, verified } = await damaged((r) => (r.files[0].bytes[0] ^= 1));
    const racing: PackageStorageAdapter = {
      ...store,
      readStaged: async (token) => {
        // Another writer changes the damaged record while the repair is staging.
        store.active.get(`${ID}@1.0.0`)!.packageHash = 'sha256:' + '1'.repeat(64);
        return store.readStaged(token);
      },
    };
    expect(await failure(repairRetainedPackage(racing, verified))).toBe('storage');
    expect(store.active.get(`${ID}@1.0.0`)!.packageHash).toBe('sha256:' + '1'.repeat(64));
    expect(store.pending.size).toBe(0);
  });

  it('plain retention still refuses to replace a damaged record', async () => {
    const { store, verified } = await damaged((r) => (r.files[0].bytes[0] ^= 1));
    const token = await store.stage({
      ...structuredClone(store.active.get(`${ID}@1.0.0`)!),
      packageHash: 'sha256:' + '2'.repeat(64),
    });
    await expect(store.activate(token)).rejects.toThrow('Another package');
    expect(await failure(retainVerifiedPackage(store, verified))).toBe('corrupt');
  });
});
