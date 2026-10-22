import { EditorSession } from '@editor-platform/editor-core';
import { ExtensionRegistry } from '@editor-platform/extension-runtime';
import { createCounter, isCounter } from '@editor-platform/extension-sample';
import {
  commitVersion,
  createArtifact,
  serializeArtifact,
  updateDraft,
} from '@editor-platform/artifact-core';
import { readCounterVersions } from './versions';
import { packages, pins } from 'virtual:bundled-counter';
import { loadBundledCounter } from './counter-loader';

async function start() {
  const verified = new Map<string, Awaited<ReturnType<typeof loadBundledCounter>>>();
  for (const bundle of packages) {
    verified.set(
      bundle.manifest.version,
      await loadBundledCounter(
        {
          ...bundle,
          files: bundle.files.map((file) => ({
            path: file.path,
            bytes: new TextEncoder().encode(file.text),
          })),
        },
        (id, version) => (id === 'example.counter' ? pins[version] : undefined),
      ),
    );
  }
  type FixtureVersion = '0.0.1' | '0.0.2';
  const registry = new ExtensionRegistry();
  function installFixture(version: FixtureVersion, replace: boolean) {
    const loaded = verified.get(version);
    if (!loaded) throw Error('Bundled Counter unavailable');
    loaded.assertTrusted();
    return registry.install(loaded.definition, {
      trust: 'trusted',
      verifiedPackageHash: pins[version],
      replace,
    });
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
  document.querySelector<HTMLElement>('#status')!.textContent =
    `Bundle verification failed: ${String(error)}`;
});
