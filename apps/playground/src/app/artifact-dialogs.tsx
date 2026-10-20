import { lazy, Suspense, type ComponentProps, type MutableRefObject } from 'react';
import type { Artifact } from '@editor-platform/artifact-core';
import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import {
  command,
  type EditorSession,
  type ElementAddress,
  type Selection,
} from '@editor-platform/editor-core';
import { Dialog } from '@editor-platform/editor-ui';
import { localImportCreationAdapter } from '@editor-platform/office-import-core/lifecycle';
import type { ImportContent } from '@editor-platform/office-import-ui';
import {
  CsvExportDialog,
  defaultView,
  isStructuredData,
  type DataView,
} from '@editor-platform/structured-data';
import {
  TemplateGallery,
  TemplateStructurePanel,
  SaveTemplateDialog,
  ReusableLibrary,
  ReusableAnnotationDialog,
  TokenStyleLibrary,
  ReusableBatchDialog,
} from '@editor-platform/template-ui';
import {
  applyInstantiation,
  applyLocalTemplate,
  type Domain,
  type InputValue,
  type PreparedApplication,
  type PrivateViewSettings,
  type TemplateKind,
} from '@editor-platform/templates';
import { createLocalSession, type Content, type StoredArtifact } from '../model';
import {
  nativeContent,
  nativeRecord,
  nativeShared,
  personalTemplates,
  templateCatalog,
  type NativeContent,
} from './native';
import { editedDraft, storage } from './records';

const OfficeImportDialog = lazy(() =>
  import('@editor-platform/office-import-ui').then((m) => ({ default: m.OfficeImportDialog })),
);

/** Kinds without template/reuse adapters; see `nativeContent`. */
const nonNativeKinds = ['react-ui', 'structured-graph', 'geo', 'animation'];

export interface TemplateAuthoring {
  artifactId: string;
  domain: Domain;
  content: NativeContent;
  ids: string[];
  slideSelection?: { pageId: string; elementId: string }[];
  reuse: boolean;
  privateSettings?: PrivateViewSettings;
  session?: SharedEditorSession<Content>;
}

/** Which overlay dialogs are open; each closes through `onClose` with its own key. */
export interface OpenDialogs {
  csvExport: boolean;
  officeImport: boolean;
  templateKind?: TemplateKind;
  structure: boolean;
  authoring?: TemplateAuthoring;
  styleLibrary: boolean;
  reuseBatch: boolean;
  reusable?: 'library' | 'inspect';
  reusableAnnotation?: ElementAddress;
}

export interface DialogHost {
  active: StoredArtifact | undefined;
  records: StoredArtifact[];
  recordsRef: MutableRefObject<StoredArtifact[]>;
  sessions: MutableRefObject<Map<string, EditorSession<Content>>>;
  sharedSession: SharedEditorSession<Content> | undefined;
  shared: boolean;
  readOnly: boolean;
  nativeReuseSupported: boolean;
  selection: Selection;
  dataViews: Record<string, DataView>;
  dataViewsRef: MutableRefObject<Record<string, DataView>>;
  templateViewSettings: Record<string, Record<string, InputValue>>;
  officeCreationAllowed: MutableRefObject<boolean>;
  exportGuard: (() => void) | undefined;
  readCanonicalRecord(id: string): StoredArtifact;
  flushInputs(): boolean;
  persist(record: StoredArtifact): unknown;
  activate(id: string): void;
  select(ids: string | string[]): void;
  setRevealAddress(address: ElementAddress): void;
  setStatus(message: string): void;
  emitAnnotation(annotation: StoredArtifact['annotations'][number]): void;
  savePrivateSettings(id: string, settings: PrivateViewSettings, expected?: string): void;
  editPrivateSettings(id: string, patch: PrivateViewSettings): void;
  reuseBatchBasis: ComponentProps<typeof ReusableBatchDialog>['basis'];
  applyReuseBatch(prepared: PreparedApplication): Promise<void>;
}

function adoptCreated(host: DialogHost, record: StoredArtifact) {
  host.sessions.current.set(record.id, createLocalSession(record.draft.content));
  host.persist(record);
  host.activate(record.id);
}

/** Applies a prepared template/reuse change to the local draft as one proposal command. */
function applyLocalPrepared(
  host: DialogHost,
  active: StoredArtifact,
  type: 'template.apply' | 'template.structure' | 'reuse.apply',
  prepared: PreparedApplication,
) {
  const next = host.sessions.current
    .get(active.id)!
    .execute(
      command(
        type,
        prepared.proposal.summary,
        (value) => applyLocalTemplate(prepared, nativeContent(value)),
        { origin: 'proposal', transactionId: prepared.id, proposalId: prepared.id },
      ),
    );
  host.persist({ ...editedDraft(active, next), annotations: active.annotations });
}

function nativeTarget(host: DialogHost, active: StoredArtifact) {
  return {
    artifactId: active.id,
    domain: active.kind as Domain,
    content: nativeContent(active.draft.content),
    ids: host.selection.addresses.map((a) => a.elementId),
    shared: nativeShared(host.sharedSession),
  };
}

/** The first selected slide or block, after which a fragment template is inserted. */
function insertionPoint(active: StoredArtifact, selection: Selection) {
  const content = active.draft.content;
  return selection.addresses.find(
    (a) =>
      ('slides' in content && content.slides.some((p) => p.id === a.elementId)) ||
      ('blocks' in content && content.blocks.some((b) => b.id === a.elementId)),
  )?.elementId;
}

async function createFromTemplate(
  host: DialogHost,
  prepared: Parameters<typeof applyInstantiation>[0],
) {
  if (!host.flushInputs()) throw new Error('入力を確定してから作成してください。');
  if (host.shared) throw new Error('Leave the shared session before creating another artifact');
  const artifact = await applyInstantiation(prepared, {
    list: async () =>
      (await storage.list())
        .filter(
          (r) =>
            r.kind !== 'react-ui' &&
            r.kind !== 'structured-graph' &&
            r.kind !== 'geo' &&
            r.kind !== 'animation',
        )
        .map(nativeRecord),
    get: async (id) => {
      const record = await storage.get(id);
      return record &&
        record.kind !== 'react-ui' &&
        record.kind !== 'structured-graph' &&
        record.kind !== 'geo'
        ? nativeRecord(record)
        : undefined;
    },
    put: async (value) => storage.put({ ...value, annotations: [] }),
    putIfAbsent: async (value) =>
      nativeRecord(await storage.putIfAbsent({ ...value, annotations: [] })),
    remove: (id) => storage.remove(id),
  });
  adoptCreated(host, { ...artifact, annotations: [] } as StoredArtifact);
}

function TemplateGalleryHost({
  host,
  kind,
  onClose,
}: {
  host: DialogHost;
  kind: TemplateKind;
  onClose(): void;
}) {
  const { active, readOnly } = host;
  return (
    <TemplateGallery
      catalog={templateCatalog}
      local={personalTemplates}
      kind={kind}
      readOnly={kind === 'whole' ? host.shared : readOnly}
      target={
        kind !== 'whole' && active
          ? {
              ...nativeTarget(host, active),
              afterId: insertionPoint(active, host.selection),
            }
          : undefined
      }
      onClose={onClose}
      agentInputs={async (definition) => structuredClone(definition.sample)}
      onCreate={(prepared) => createFromTemplate(host, prepared)}
      onApply={async (prepared) => {
        if (!active || prepared.proposal.artifactId !== active.id || readOnly)
          throw new Error('Target changed or is read only');
        if (!host.sharedSession) applyLocalPrepared(host, active, 'template.apply', prepared);
        if (prepared.insertedIds[0]) {
          host.select(prepared.insertedIds[0]);
          host.setRevealAddress({ artifactId: active.id, elementId: prepared.insertedIds[0] });
        }
      }}
      onViewSettings={(_domain, settings) => {
        if (!active) return;
        host.editPrivateSettings(active.id, settings);
      }}
    />
  );
}

function CsvExportHost({ host, onClose }: { host: DialogHost; onClose(): void }) {
  const active = host.active!;
  const data = active.draft.content;
  if (!isStructuredData(data)) return null;
  return (
    <CsvExportDialog
      name={active.name}
      data={data}
      view={host.dataViews[active.id] ?? data.views?.[0] ?? defaultView(data)}
      onClose={onClose}
      capture={() => {
        if (!host.flushInputs()) throw new Error('入力を確定してから出力してください。');
        host.exportGuard?.();
        const latest = host.readCanonicalRecord(active.id).draft.content;
        if (!latest || !isStructuredData(latest)) throw new Error('Data source changed');
        return {
          data: latest,
          view: host.dataViewsRef.current[active.id] ?? latest.views?.[0] ?? defaultView(latest),
        };
      }}
    />
  );
}

function OfficeImportHost({ host, onClose }: { host: DialogHost; onClose(): void }) {
  const allowed = host.officeCreationAllowed;
  return (
    <Suspense fallback={<p role="status">Office importを読み込んでいます…</p>}>
      <OfficeImportDialog
        onClose={onClose}
        creation={localImportCreationAdapter<ImportContent>(
          {
            putIfAbsent: async (value) => {
              if (!allowed.current || !host.flushInputs())
                throw new Error('Host does not permit creation while inputs are pending');
              return (await storage.putIfAbsent({
                ...value,
                annotations: [],
              } as StoredArtifact)) as Artifact<ImportContent>;
            },
          },
          () => allowed.current,
        )}
        onCreated={async (artifact) => {
          adoptCreated(host, { ...artifact, annotations: [] } as StoredArtifact);
        }}
      />
    </Suspense>
  );
}

function ReuseBatchHost({ host, onClose }: { host: DialogHost; onClose(): void }) {
  const { active } = host;
  const others = host.records.filter(
    (r) => r.id !== active?.id && !nonNativeKinds.includes(r.kind),
  );
  const current =
    active &&
    active.kind !== 'react-ui' &&
    active.kind !== 'structured-graph' &&
    active.kind !== 'geo'
      ? [active]
      : [];
  return (
    <ReusableBatchDialog
      catalog={templateCatalog}
      readOnly={host.readOnly}
      artifacts={[...others, ...current].map((r) => ({
        id: r.id,
        name: r.name,
        domain: r.kind as Domain,
        content: nativeContent(r.draft.content),
      }))}
      basis={host.reuseBatchBasis}
      onApply={host.applyReuseBatch}
      onClose={onClose}
    />
  );
}

function ReusableAnnotationHost({
  host,
  active,
  address,
  onClose,
}: {
  host: DialogHost;
  active: StoredArtifact;
  address: ElementAddress;
  onClose(): void;
}) {
  const { readOnly } = host;
  return (
    <ReusableAnnotationDialog
      target={{ ...nativeTarget(host, active), ids: [address.elementId] }}
      settings={host.templateViewSettings[active.id] ?? {}}
      address={address}
      readOnly={readOnly}
      onClose={onClose}
      onApply={(prepared) => {
        if (prepared.source.artifactId !== active.id || readOnly)
          throw new Error('Target changed or is read only');
        if (!host.sharedSession) {
          const current = host.recordsRef.current.find((a) => a.id === active.id);
          if (!current) throw new Error('Artifact no longer exists');
          applyLocalTemplate(prepared.application, nativeContent(current.draft.content));
          if (!current.annotations.some((a) => a.id === prepared.annotation.id)) {
            host.persist({
              ...current,
              annotations: [...current.annotations, prepared.annotation],
            });
            host.emitAnnotation(prepared.annotation);
          }
        }
        host.setStatus('Annotation created from display settings');
      }}
    />
  );
}

function TemplateDialogs({
  host,
  open,
  onClose,
}: {
  host: DialogHost;
  open: OpenDialogs;
  onClose(dialog: keyof OpenDialogs): void;
}) {
  const { active, readOnly } = host;
  const nativeActive = active && !nonNativeKinds.includes(active.kind) ? active : undefined;
  return (
    <>
      {open.csvExport && active && isStructuredData(active.draft.content) && (
        <CsvExportHost host={host} onClose={() => onClose('csvExport')} />
      )}
      {open.officeImport && (
        <OfficeImportHost host={host} onClose={() => onClose('officeImport')} />
      )}
      {open.templateKind && (
        <TemplateGalleryHost
          host={host}
          kind={open.templateKind}
          onClose={() => onClose('templateKind')}
        />
      )}
      {open.structure && nativeActive && (
        <TemplateStructurePanel
          catalog={templateCatalog}
          local={personalTemplates}
          readOnly={readOnly}
          onClose={() => onClose('structure')}
          target={nativeTarget(host, nativeActive)}
          onApply={(prepared) => {
            if (prepared.proposal.artifactId !== nativeActive.id || readOnly)
              throw new Error('Target changed or is read only');
            if (!host.sharedSession)
              applyLocalPrepared(host, nativeActive, 'template.structure', prepared);
          }}
        />
      )}
      {open.authoring && active?.id === open.authoring.artifactId && (
        <SaveTemplateDialog
          reuse={open.authoring.reuse}
          privateSettings={open.authoring.privateSettings}
          domain={open.authoring.domain}
          content={open.authoring.content}
          ids={open.authoring.ids}
          slideSelection={open.authoring.slideSelection}
          catalog={personalTemplates}
          onClose={() => onClose('authoring')}
          onSaved={() => host.setStatus('Template saved locally')}
          onComponentSaved={() => host.setStatus('Reusable component published locally')}
        />
      )}
    </>
  );
}

function ReuseDialogs({
  host,
  open,
  onClose,
}: {
  host: DialogHost;
  open: OpenDialogs;
  onClose(dialog: keyof OpenDialogs): void;
}) {
  const { active, readOnly } = host;
  const reuseActive =
    active &&
    active.kind !== 'structured-graph' &&
    active.kind !== 'geo' &&
    active.kind !== 'animation'
      ? active
      : undefined;
  return (
    <>
      {open.styleLibrary && reuseActive && (
        <TokenStyleLibrary
          domain={reuseActive.kind as Domain}
          catalog={templateCatalog}
          writeCatalog={personalTemplates}
          readOnly={readOnly}
          onClose={() => onClose('styleLibrary')}
        />
      )}
      {open.reuseBatch && <ReuseBatchHost host={host} onClose={() => onClose('reuseBatch')} />}
      {open.reusable && host.nativeReuseSupported && reuseActive && (
        <ReusableLibrary
          catalog={templateCatalog}
          writeCatalog={personalTemplates}
          readOnly={readOnly}
          inspect={open.reusable === 'inspect'}
          privateSettings={host.templateViewSettings[reuseActive.id]}
          onPrivateSettings={(settings, expected) =>
            host.savePrivateSettings(reuseActive.id, settings, expected)
          }
          onClose={() => onClose('reusable')}
          target={nativeTarget(host, reuseActive)}
          onApply={(prepared) => {
            if (prepared.proposal.artifactId !== reuseActive.id || readOnly)
              throw new Error('Target changed or is read only');
            if (!host.sharedSession) applyLocalPrepared(host, reuseActive, 'reuse.apply', prepared);
            if (prepared.insertedIds[0]) host.select(prepared.insertedIds[0]);
          }}
        />
      )}
      {open.reusableAnnotation && active && open.reusableAnnotation.artifactId === active.id && (
        <ReusableAnnotationHost
          host={host}
          active={active}
          address={open.reusableAnnotation}
          onClose={() => onClose('reusableAnnotation')}
        />
      )}
    </>
  );
}

/** Template, reuse, import and export dialogs layered over the workspace. */
export function ArtifactDialogs(props: {
  host: DialogHost;
  open: OpenDialogs;
  onClose(dialog: keyof OpenDialogs): void;
}) {
  return (
    <>
      <TemplateDialogs {...props} />
      <ReuseDialogs {...props} />
    </>
  );
}

export function SaveVersionDialog({
  shared,
  busy,
  reason,
  onReasonChange,
  onSave,
  onClose,
}: {
  shared: boolean;
  busy: boolean;
  reason: string;
  onReasonChange(reason: string): void;
  onSave(): void;
  onClose(): void;
}) {
  return (
    <Dialog title="Save immutable version" onClose={onClose}>
      <p>
        {shared
          ? 'Save an immutable version of confirmed shared content. Pending input must be confirmed first.'
          : 'Draft changes save automatically on this browser. A version keeps an immutable snapshot.'}
      </p>
      <label>
        Version note
        <input
          aria-label="Version reason"
          placeholder="Optional description"
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
        />
      </label>
      <button
        disabled={busy}
        onClick={() => {
          onSave();
          onClose();
        }}
      >
        この版を保存
      </button>
    </Dialog>
  );
}
