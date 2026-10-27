import { X } from 'lucide-react';
import { serializeArtifact } from '@editor-platform/artifact-core';
import { IconButton } from '@editor-platform/editor-ui';
import type { PrivateVideoEntry } from '../private-video/catalog';
import { graphTemplates, type GraphTemplateId } from './graph-templates';
import {
  cadKernel,
  creatableKinds,
  downloadText,
  kinds,
  type Kind,
  type StoredArtifact,
} from '../model';

const reusableLibraryKinds = ['design', 'document', 'slide', 'whiteboard', 'data'];

export interface PrivateVideoLaunchers {
  openEditor(id?: string, m2?: boolean): void;
  entries: PrivateVideoEntry[];
  m2Entries: PrivateVideoEntry[];
  /** Each launcher appears only outside shared sessions when the Host registered it. */
  showEditor: boolean;
  showM2: boolean;
}

function PrivateVideoSection({
  label,
  launchLabel,
  entries,
  dataAttribute,
  disabled,
  open,
}: {
  label: string;
  launchLabel: string;
  entries: PrivateVideoEntry[];
  dataAttribute: 'data-private-project' | 'data-private-m2-project';
  disabled: boolean;
  open(id?: string): void;
}) {
  return (
    <section aria-label={label}>
      <button
        disabled={disabled}
        aria-label={dataAttribute === 'data-private-m2-project' ? launchLabel : undefined}
        onClick={() => open()}
      >
        {launchLabel}
      </button>
      {entries.map((entry) => (
        <button
          key={entry.id}
          {...{ [dataAttribute]: entry.id }}
          disabled={disabled}
          onClick={() => open(entry.id)}
        >
          {entry.name}
        </button>
      ))}
    </section>
  );
}

export function LibraryPanel({
  open,
  records,
  activeId,
  activeKind,
  kind,
  loaded,
  busy,
  shared,
  readOnly,
  nativeReuseSupported,
  privateVideo,
  onClose,
  onKindChange,
  graphTemplate,
  onGraphTemplateChange,
  onCreate,
  onCreateFromTemplate,
  onOpenReusableLibrary,
  onOfficeImport,
  onActivate,
  onImportFiles,
}: {
  open: boolean;
  records: StoredArtifact[];
  activeId: string;
  activeKind: string | undefined;
  kind: Kind;
  loaded: boolean;
  busy: boolean;
  shared: boolean;
  readOnly: boolean;
  nativeReuseSupported: boolean;
  privateVideo: PrivateVideoLaunchers;
  onClose(): void;
  onKindChange(kind: Kind): void;
  graphTemplate: GraphTemplateId;
  onGraphTemplateChange(template: GraphTemplateId): void;
  onCreate(kind: Kind): void;
  onCreateFromTemplate(): void;
  onOpenReusableLibrary(): void;
  onOfficeImport(): void;
  onActivate(id: string): void;
  onImportFiles(files: File[]): void;
}) {
  const openPrivate = privateVideo.openEditor;
  const privateDisabled = !loaded || busy;
  return (
    <aside className={`library ${open ? 'open' : ''}`} aria-label="Artifact library">
      <div className="library-heading">
        <h1>Library</h1>
        <IconButton icon={X} label="Close library panel" onClick={onClose} />
        <span>{records.length}</span>
      </div>
      <label className="create-type">
        Artifact type
        <select
          aria-label="Artifact type"
          value={kind}
          onChange={(e) => onKindChange(e.target.value as Kind)}
        >
          {creatableKinds.map((k) => (
            <option key={k} value={k}>
              {kinds[k].label}
            </option>
          ))}
        </select>
      </label>
      <details className="playground-setup">
        <summary>{cadKernel ? 'Playground setup' : '3D CAD / BIM unavailable — setup'}</summary>
        {!cadKernel && (
          <p>
            3D CAD and BIM creation require a development kernel. Set <code>CAD_OCCT_DIST</code> to
            a prepared kernel directory before starting the server. If already set, check that its
            JavaScript and Wasm files are present. See <code>scripts/cad-kernel/README.md</code> in
            the repository, then restart the server.
          </p>
        )}
        <p>
          Before <code>npm run dev</code>, run <code>npm run fonts:fetch</code> once to prepare the
          required fonts (network required). See <code>docs/developer-guide.md</code> in the
          repository.
        </p>
      </details>
      {kind === 'structured-graph' && (
        <label className="create-type">
          Graph template
          <select
            aria-label="Graph template"
            value={graphTemplate}
            onChange={(e) => onGraphTemplateChange(e.target.value as GraphTemplateId)}
          >
            {graphTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="primary new-artifact" onClick={() => onCreate(kind)} disabled={!loaded}>
        ＋ New artifact
      </button>
      <button disabled={!loaded || shared} onClick={onCreateFromTemplate}>
        テンプレートから作成
      </button>
      {activeKind && nativeReuseSupported && reusableLibraryKinds.includes(activeKind) && (
        <button onClick={onOpenReusableLibrary}>部品ライブラリ</button>
      )}
      <button disabled={!loaded || shared || readOnly} onClick={onOfficeImport}>
        Officeから新規作成
      </button>
      {privateVideo.showEditor && (
        <PrivateVideoSection
          label="Private Video projects"
          launchLabel="New Video project (private)"
          entries={privateVideo.entries}
          dataAttribute="data-private-project"
          disabled={privateDisabled}
          open={(id) => openPrivate(id)}
        />
      )}
      {privateVideo.showM2 && (
        <PrivateVideoSection
          label="Private Video M2 projects"
          launchLabel="Video"
          entries={privateVideo.m2Entries}
          dataAttribute="data-private-m2-project"
          disabled={privateDisabled}
          open={(id) => openPrivate(id, true)}
        />
      )}
      <nav aria-label="Artifacts">
        {records.map((a) => (
          <button
            key={a.id}
            aria-current={a.id === activeId ? 'page' : undefined}
            onClick={() => onActivate(a.id)}
          >
            <span className="artifact-icon">{kinds[a.kind as Kind]?.icon}</span>
            <span>
              {a.name}
              <small>
                {kinds[a.kind as Kind]?.label} · {a.versions.length} versions
              </small>
            </span>
          </button>
        ))}
      </nav>
      <label className="import-control">
        ↑ Import artifact
        <input
          type="file"
          aria-label="Import artifact"
          accept=".md,.csv,.json,.ifc"
          multiple
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length) onImportFiles(files);
            e.target.value = '';
          }}
        />
      </label>
      <p className="library-note">
        Local-first workspace
        <br />
        Your artifacts stay in this browser.
      </p>
    </aside>
  );
}

export function WelcomePanel({
  loaded,
  busy,
  privateVideo,
  onFindTemplates,
  onCreate,
}: {
  loaded: boolean;
  busy: boolean;
  privateVideo: PrivateVideoLaunchers;
  onFindTemplates(): void;
  onCreate(kind: Kind): void;
}) {
  const openPrivate = privateVideo.openEditor;
  return (
    <div className="welcome">
      <span className="eyebrow">YOUR WORK, IN ITS OWN FORMAT</span>
      <h2>
        A space to make
        <br />
        and make sense.
      </h2>
      <p>
        Write a document, explore a dataset, or review a change.
        <br />
        Every artifact has a history. Every surface speaks the same language.
      </p>
      <button className="primary" onClick={onFindTemplates}>
        テンプレートを探す
      </button>
      <div className="welcome-tools">
        {privateVideo.showEditor && (
          <button
            aria-label="New Video project (private)"
            disabled={!loaded || busy}
            onClick={() => openPrivate()}
          >
            <strong>New Video project (private)</strong>
            <small>Local Video review integration</small>
          </button>
        )}
        {privateVideo.showM2 && (
          <button
            disabled={!loaded || busy}
            aria-label="Video"
            onClick={() => openPrivate(undefined, true)}
          >
            <strong>Video</strong>
            <small>Private local validation</small>
          </button>
        )}
        {creatableKinds.map((k) => (
          <button key={k} aria-label={`New ${kinds[k].label}`} onClick={() => onCreate(k)}>
            <span>{kinds[k].icon}</span>
            <strong>New {kinds[k].label}</strong>
            <small>{kinds[k].description}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

export function LoadErrorBanners({
  records,
  loadErrors,
}: {
  records: StoredArtifact[];
  loadErrors: Record<string, string>;
}) {
  return (
    <>
      {Object.entries(loadErrors).map(([id, message]) => {
        const retained = records.find((a) => a.id === id);
        return (
          retained && (
            <div role="alert" className="error-banner" key={id}>
              <span>
                {retained.name}: {message}. Stored record is retained; other artifacts remain
                available.
              </span>
              <button
                onClick={() =>
                  downloadText(
                    `${retained.name}.json`,
                    serializeArtifact(retained),
                    'application/json',
                  )
                }
              >
                Export retained {retained.name}
              </button>
            </div>
          )
        );
      })}
    </>
  );
}

export function ErrorBanner({
  message,
  canRetrySave,
  onRetrySave,
  onDismiss,
}: {
  message: string;
  canRetrySave: boolean;
  onRetrySave(): void;
  onDismiss(): void;
}) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {canRetrySave && <button onClick={onRetrySave}>Retry local save</button>}
      <button aria-label="Dismiss error" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
