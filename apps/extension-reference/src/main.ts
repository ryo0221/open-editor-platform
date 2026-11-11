import { EditorSession } from '@editor-platform/editor-core';
import { ExtensionRegistry } from '@editor-platform/extension-runtime';
import {
  installVerifiedExtension,
  loadVerifiedExtension,
  verifyExtensionPackage,
  type LoadedExtension,
} from '@editor-platform/extension-runtime/package';
import { createCounter, isCounter, type Counter } from '@editor-platform/extension-sample';
import {
  discardInterruptedInstalls,
  PackageRetentionError,
  removeRetainedPackage,
  repairRetainedPackage,
  restoreRetainedPackage,
  retainVerifiedPackage,
} from '@editor-platform/extension-runtime/package-store';
import { openIndexedDbPackageStorage } from './package-storage';
import { packageStoreLock } from './package-lock';
import {
  commitVersion,
  createArtifact,
  serializeArtifact,
  updateDraft,
} from '@editor-platform/artifact-core';
import { readCounterVersions } from './versions';
import { packages, pins } from 'virtual:bundled-counter';

/** Set once start-up can offer an explicit repair of damaged retained packages. */
let repairDamaged: (() => Promise<string[]>) | undefined;

async function start() {
  const verified = new Map<string, LoadedExtension<Counter>>();
  // This Host's allowlist admits only its own build's Counter pins; the loader is generic.
  const lookup = (id: string, version: string) =>
    id === 'example.counter' ? pins[version] : undefined;
  // Retained exact bytes are reopened on restart; the build's copy is used only when nothing is
  // retained yet. A damaged or mismatching retained package is refused, never silently replaced.
  const store = await openIndexedDbPackageStorage('extension-reference.packages');
  const retention: string[] = [];
  // Versions whose exact bytes are durably stored, separate from what is loaded in this page.
  const retained = new Set<string>(),
    removed = new Set<string>();
  const lock = packageStoreLock();
  const verifyBuildCopy = (bundle: (typeof packages)[number]) =>
    verifyExtensionPackage(
      {
        ...bundle,
        files: bundle.files.map((file) => ({
          path: file.path,
          bytes: new TextEncoder().encode(file.text),
        })),
      },
      lookup,
    );
  // Explicit only: replaces damaged records with this build's copy, verified against the same pin.
  repairDamaged = () =>
    lock.change(async () => {
      const repaired: string[] = [];
      for (const bundle of packages) {
        try {
          const result = await repairRetainedPackage(store, await verifyBuildCopy(bundle));
          if (result === 'repaired') repaired.push(bundle.manifest.version);
        } catch (error) {
          if (!(error instanceof PackageRetentionError) || error.code !== 'missing') throw error;
        }
      }
      return repaired;
    });
  await lock.change(async () => {
    // Under the change lock a staged record is never another tab's install in progress.
    if (lock.coordinated) {
      const interrupted = await discardInterruptedInstalls(store);
      if (interrupted) retention.push(`discarded ${interrupted} interrupted install`);
    }
    for (const bundle of packages) {
      const { id, version } = bundle.manifest;
      let admitted;
      try {
        admitted = await restoreRetainedPackage(store, id, version, lookup);
        retained.add(version);
        retention.push(`${version} restored`);
      } catch (error) {
        if (!(error instanceof PackageRetentionError) || error.code !== 'missing') throw error;
        // A package the user removed stays removed: its build copy is not admitted again silently.
        if ((await store.removed(id, version)) !== undefined) {
          removed.add(version);
          retention.push(`${version} removed`);
          continue;
        }
        admitted = await verifyBuildCopy(bundle);
        try {
          await retainVerifiedPackage(store, admitted);
          retained.add(version);
          retention.push(`${version} retained`);
        } catch (failure) {
          // Quota or I/O: keep running from the verified build copy; do not report retention.
          if (!(failure instanceof PackageRetentionError) || failure.code !== 'storage')
            throw failure;
          retention.push(`${version} not retained (storage)`);
        }
      }
      verified.set(version, await loadVerifiedExtension<Counter>(admitted));
    }
  });
  const retentionText = document.querySelector<HTMLElement>('#retention')!;
  retentionText.textContent = `Packages: ${retention.join(', ')}`;
  type FixtureVersion = '0.0.1' | '0.0.2';
  const registry = new ExtensionRegistry();
  // Package changes (switch, remove, retain again) run one at a time: this is the Host's
  // exclusive section, so no holder appears while a removal is deciding.
  let packageBusy = false;
  function installFixture(version: FixtureVersion, replace: boolean) {
    if (packageBusy) throw Error('Package change in progress; try again');
    const loaded = verified.get(version);
    if (!loaded) throw Error(`Fixture ${version} is not available`);
    return installVerifiedExtension(registry, loaded, { replace });
  }
  let registration = installFixture('0.0.1', false);
  let installed = true;
  const readOnly = document.querySelector<HTMLInputElement>('#readonly')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const surface = document.querySelector<HTMLElement>('#surface')!;
  let session = new EditorSession(createCounter());
  let handle = open();
  const pin = document.querySelector<HTMLElement>('#pin')!;
  function showPin() {
    pin.textContent = installed
      ? `Fixture ${registration.manifest.version} · ${registration.manifest.packageHash}`
      : 'No fixture installed';
  }
  showPin();
  function switchFixture(version: FixtureVersion) {
    try {
      registration = installFixture(version, installed);
      installed = true;
      handle = open();
      showPin();
      status.textContent = `Opened fixture ${version}; draft and history retained`;
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : 'Fixture switch failed';
    }
  }
  document.querySelector<HTMLButtonElement>('#install-v2')!.onclick = () => switchFixture('0.0.2');

  // Explicit removal of retained bytes, separate from Uninstall. This Host's holders are the open
  // Editor, its start-up Editor (0.0.1) and any other open page of this Host, which shares the
  // store and may have the package open or loaded. Saved drafts and document versions hold
  // Counter data of the shared native format, readable by either package, so they do not hold a
  // package.
  const packageSelect = document.querySelector<HTMLSelectElement>('#package-version')!;
  const holders = (_id: string, version: string) => [
    ...(version === '0.0.1' ? ['start-up Editor'] : []),
    ...(installed && registration.manifest.version === version ? [`open Editor ${version}`] : []),
  ];
  async function changePackage(action: 'remove' | 'retain') {
    if (packageBusy) return;
    const version = packageSelect.value as FixtureVersion;
    const bundle = packages.find((p) => p.manifest.version === version)!;
    const { id } = bundle.manifest;
    packageBusy = true;
    try {
      if (action === 'remove') {
        await lock.change((alone) =>
          removeRetainedPackage(store, id, version, (i, v) => [
            ...holders(i, v),
            ...(alone ? [] : ['another open tab of this Host']),
          ]),
        );
        verified.delete(version);
        retained.delete(version);
        removed.add(version);
        status.textContent = `Removed package ${version}; saved drafts and versions unchanged`;
      } else {
        if (retained.has(version)) throw Error(`Package ${version} is already retained`);
        // Also retries a package loaded from the build copy whose first retention failed.
        await lock.change(async () => {
          const admitted = await verifyBuildCopy(bundle);
          await retainVerifiedPackage(store, admitted);
          if (!verified.has(version))
            verified.set(version, await loadVerifiedExtension<Counter>(admitted));
        });
        retained.add(version);
        removed.delete(version);
        status.textContent = `Retained package ${version}`;
      }
      retentionText.textContent = `Packages: ${packages
        .map(({ manifest: { version: v } }) => {
          if (retained.has(v)) return `${v} kept`;
          if (removed.has(v)) return `${v} removed`;
          return `${v} ${verified.has(v) ? 'not retained' : 'unavailable'}`;
        })
        .join(', ')}`;
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : 'Package change failed';
    } finally {
      packageBusy = false;
    }
  }
  document.querySelector<HTMLButtonElement>('#remove-package')!.onclick = () =>
    void changePackage('remove');
  document.querySelector<HTMLButtonElement>('#retain-package')!.onclick = () =>
    void changePackage('retain');
  document.querySelector<HTMLButtonElement>('#restore-v1')!.onclick = () => switchFixture('0.0.1');
  function open() {
    const h = registration.open({
      artifactKind: 'example.counter',
      schemaVersion: 1,
      allowed: () => true,
      readOnly: () => readOnly.checked,
      read: () => session.content,
      execute: (c) => {
        session.execute(c);
      },
      undo: () => {
        session.undo();
      },
      redo: () => {
        session.redo();
      },
      save: async () => {
        localStorage.setItem('extension.counter.draft', JSON.stringify(session.content));
      },
      select: () => {
        throw new Error('Selection unsupported');
      },
    });
    h.mount(surface);
    return h;
  }
  document.querySelector<HTMLButtonElement>('#reload')!.onclick = () => {
    try {
      if (readOnly.checked) throw new Error('Permission denied');
      const raw: unknown = JSON.parse(localStorage.getItem('extension.counter.draft') ?? 'null');
      if (!isCounter(raw)) throw new Error('Invalid saved draft');
      // Check registration liveness before replacing the local session.
      handle.api.read();
      handle.close();
      session = new EditorSession(raw);
      restoredBase = null;
      handle = open();
      status.textContent = 'Reloaded saved draft';
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : 'Reload failed';
    }
  };
  document.querySelector<HTMLButtonElement>('#uninstall')!.onclick = () => {
    registration.uninstall();
    installed = false;
    showPin();
    status.textContent = 'Uninstalled; saved draft retained';
  };

  // Document versions are Host-owned Artifact records, separate from fixture package pins.
  const versionsKey = 'extension.counter.versions';
  const versionSelect = document.querySelector<HTMLSelectElement>('#document-version')!;
  let restoredBase: { artifactId: string; versionId: string } | null = null;
  let versionBusy = false;
  function showVersions(versions: Awaited<ReturnType<typeof readCounterVersions>>['versions']) {
    versionSelect.replaceChildren(
      ...versions.map((v, i) => {
        const option = document.createElement('option');
        option.value = v.versionId;
        option.textContent = `Version ${i + 1}: value ${v.content.value}`;
        return option;
      }),
    );
  }
  async function documentVersion(action: 'load' | 'save' | 'restore') {
    if (versionBusy) return;
    versionBusy = true;
    try {
      const originalHandle = handle,
        originalSession = session;
      const sequence = session.revision.sequence;
      const selected = versionSelect.value;
      const assertCurrent = () => {
        originalHandle.api.read();
        if (
          handle !== originalHandle ||
          session !== originalSession ||
          session.revision.sequence !== sequence
        )
          throw new Error('Draft changed; try again');
        if (action !== 'load' && readOnly.checked) throw new Error('Permission denied');
      };
      assertCurrent();
      const raw = localStorage.getItem(versionsKey);
      let artifact =
        raw === null
          ? createArtifact('example.counter', 'Counter document', session.content)
          : await readCounterVersions(raw);
      if (action === 'save') {
        artifact = updateDraft(artifact, originalSession.content);
        if (restoredBase) {
          if (
            restoredBase.artifactId !== artifact.id ||
            !artifact.versions.some((v) => v.versionId === restoredBase!.versionId)
          )
            throw new Error('Restored base is unavailable');
          artifact.draft.baseVersionId = restoredBase.versionId;
        }
        artifact = await commitVersion(artifact, null, 'Counter document version');
      }
      assertCurrent();
      if (localStorage.getItem(versionsKey) !== raw)
        throw new Error('Saved versions changed; try again');
      if (action === 'save') {
        // A synchronous storage failure leaves the session and prior record unchanged.
        localStorage.setItem(versionsKey, serializeArtifact(artifact));
        restoredBase = { artifactId: artifact.id, versionId: artifact.draft.baseVersionId! };
        showVersions(artifact.versions);
        status.textContent = 'Saved document version';
      } else if (action === 'load') {
        showVersions(artifact.versions);
        status.textContent = 'Loaded document versions; draft unchanged';
      } else {
        if (versionSelect.value !== selected)
          throw new Error('Version selection changed; try again');
        const version = artifact.versions.find((v) => v.versionId === selected);
        if (!version) throw new Error('Document version unavailable');
        handle.close();
        session = new EditorSession(version.content);
        handle = open();
        restoredBase = { artifactId: artifact.id, versionId: version.versionId };
        status.textContent = 'Restored version as a new unsaved draft; saved versions unchanged';
      }
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : 'Document version operation failed';
    } finally {
      versionBusy = false;
    }
  }
  document.querySelector<HTMLButtonElement>('#save-document-version')!.onclick = () =>
    void documentVersion('save');
  document.querySelector<HTMLButtonElement>('#load-document-versions')!.onclick = () =>
    void documentVersion('load');
  document.querySelector<HTMLButtonElement>('#restore-document-version')!.onclick = () =>
    void documentVersion('restore');
}
void start().catch((error) => {
  const status = document.querySelector<HTMLElement>('#status')!;
  status.textContent = `Bundle verification failed: ${String(error)}`;
  const repair = repairDamaged;
  if (!(error instanceof PackageRetentionError) || error.code !== 'corrupt' || !repair) return;
  // A damaged retained package is never replaced silently; the user may ask for a repair.
  const button = document.querySelector<HTMLButtonElement>('#repair-packages')!;
  button.hidden = false;
  button.onclick = async () => {
    button.disabled = true;
    try {
      const repaired = await repair();
      status.textContent = `Repaired package ${repaired.join(', ')}; restarting`;
      location.reload();
    } catch (failure) {
      status.textContent = `Repair failed: ${String(failure)}`;
      button.disabled = false;
    }
  };
});
