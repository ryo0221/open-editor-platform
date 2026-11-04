import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CharacterSurface,
  frameBounds,
  type CharacterImportReport,
  type CharacterPropChoice,
  type CharacterPropView,
} from '@editor-platform/character';
import '@editor-platform/character/style.css';
import {
  applyCharacterOperation,
  characterContentHash,
  characterEditorCommand,
  characterIds,
  diffCharacterIds,
  freshCharacterId,
  GltfImportError,
  importGltf,
  type CharacterDocument,
  type CharacterIdDiff,
  type CharacterAssetRef,
  type CharacterOperation,
  type GltfImport,
} from '@editor-platform/character-core';
import type { EditorSession } from '@editor-platform/editor-core';
import type { CadAssetRef } from '@editor-platform/cad-core';
import type { StoredArtifact } from '../model';
import { createCadAssetStore, decodeBytes, portableCadRecord } from '../cad/resources';
import { assertCharacterHistoryFits, assertCharacterImportFits } from './import-fit';
import { characterMeshRecord } from './mesh-assets';
import { CharacterImportReview } from './import-review';
import { carryProps } from './carry-props';
import { characterPropChoices, retainCharacterProp } from './parts';
import { CharacterPropEvaluation } from './props';

/**
 * Development builds only, for the browser tests (CH30): each drawn part's bounds, and the
 * view's projection to pick cage elements by their known positions.
 */
const exposeProbe: NonNullable<Parameters<typeof CharacterSurface>[0]['onFrame']> = (
  frame,
  _playback,
  _props,
  view,
) =>
  Object.assign(window, {
    characterProbe: {
      parts: Object.fromEntries(
        frame.map((p) => [p.partId, { corners: p.positions.length / 3, bounds: frameBounds([p]) }]),
      ),
      project: view.project,
    },
  });

/**
 * Playground binding for the character Surface (C1d). The asset bytes live in the record's
 * `cadResources`, by hash, beside the content. An import is staged first (the bytes are saved),
 * then shown as an ID diff against the current document, and applied as one undoable edit only
 * when the author confirms it. Nothing that references the old IDs is rewritten.
 */
export default function CharacterHost({
  session,
  readOnly,
  persist,
  record,
  persistRecord,
  records,
  history,
}: {
  session: EditorSession<CharacterDocument>;
  readOnly: boolean;
  persist(content: CharacterDocument): void;
  record(): StoredArtifact | undefined;
  persistRecord(record: StoredArtifact): Promise<boolean>;
  /** Every local record: the saved versions of its CAD Artifacts are the props (C2b-3). */
  records(): StoredArtifact[];
  history(direction: 'undo' | 'redo'): void;
}) {
  const storage = useRef({ record, persistRecord, records });
  const readOnlyNow = useRef(readOnly);
  readOnlyNow.current = readOnly;
  storage.current = { record, persistRecord, records };
  const store = useMemo(
    () =>
      createCadAssetStore({
        record: () => storage.current.record(),
        persist: (r) => storage.current.persistRecord(r),
        portable: portableCadRecord,
      }),
    [],
  );
  const [stored, setStored] = useState(0);
  const sequence = session.revision.sequence;
  // The asset refs, read once per revision (the session's content is a fresh copy on every
  // read). An edit that keeps them (visibility, names) keeps the same map below, so the Surface
  // neither decodes again nor refits the camera the user moved.
  const refsKey = useMemo(() => JSON.stringify(session.content.assets), [session, sequence]);
  const assets = useMemo(() => {
    const out = new Map<string, Uint8Array>();
    const resources = storage.current.record()?.cadResources ?? [];
    for (const ref of JSON.parse(refsKey) as CharacterDocument['assets']) {
      const kept = resources.find((r) => r.kind === ref.kind && r.sha256 === ref.sha256);
      if (kept) out.set(ref.id, decodeBytes(kept.bytes));
    }
    return out;
  }, [refsKey, stored]);
  const [pending, setPending] = useState<{
    file: string;
    result: GltfImport;
    diff: CharacterIdDiff;
    /** The document the diff was shown against: Apply refuses if it changed since. */
    baseHash: string;
  }>();
  const [importError, setImportError] = useState<string>();
  const [report, setReport] = useState<CharacterImportReport>();
  const [busy, setBusy] = useState(false);

  // Props: one read-only CAD evaluation per version shown, shared by props that place it and
  // released when no prop does. Views change as evaluations finish.
  const evaluations = useRef(new Map<string, CharacterPropEvaluation>());
  const [viewsVersion, setViewsVersion] = useState(0);
  const propsKey = useMemo(() => JSON.stringify(session.content.props), [session, sequence]);
  const placed = useMemo(() => JSON.parse(propsKey) as CharacterDocument['props'], [propsKey]);
  useEffect(() => {
    const live = evaluations.current;
    const hashes = new Set(placed.map((p) => p.source.contentHash));
    for (const [hash, e] of live)
      if (!hashes.has(hash)) {
        e.dispose();
        live.delete(hash);
      }
    const kept = (hash: string) =>
      storage.current.record()?.cadParts?.find((p) => p.contentHash === hash)?.content;
    for (const hash of hashes) {
      if (live.has(hash)) continue;
      const content = kept(hash);
      if (content)
        live.set(
          hash,
          new CharacterPropEvaluation(content, kept, () => setViewsVersion((n) => n + 1)),
        );
    }
    setViewsVersion((n) => n + 1);
  }, [placed, stored]);
  useEffect(
    () => () => {
      for (const e of evaluations.current.values()) e.dispose();
      evaluations.current.clear();
    },
    [],
  );
  const views = useMemo(() => {
    const out = new Map<string, CharacterPropView>();
    for (const p of placed)
      out.set(
        p.id,
        evaluations.current.get(p.source.contentHash)?.view ?? {
          status: 'failed',
          message: 'prop-source-missing',
        },
      );
    return out;
  }, [placed, viewsVersion]);
  // Read on each render: a version saved in another Artifact is offered when this one shows.
  const propChoices = characterPropChoices(storage.current.records());
  const addProp = async (choice: CharacterPropChoice) => {
    if (readOnlyNow.current) return;
    setImportError(undefined);
    try {
      const base = session.content;
      const baseHash = characterContentHash(base);
      const operation: CharacterOperation = {
        type: 'addProp',
        prop: {
          id: freshCharacterId(base, `prop:${choice.artifactId}`, characterIds(base)),
          name: choice.label.replace(/ — v\d+.*$/, ''),
          source: {
            kind: 'cad',
            artifactId: choice.artifactId,
            versionId: choice.versionId,
            contentHash: choice.contentHash,
          },
          placement: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
          visible: true,
        },
      };
      await retainCharacterProp({
        choice,
        records: storage.current.records(),
        record: storage.current.record(),
        draft: applyCharacterOperation(base, operation),
        persist: (r) => storage.current.persistRecord(r),
      });
      setStored((n) => n + 1);
      // Read only may have been turned on while the versions were kept: checked when it runs.
      session.execute(
        characterEditorCommand(operation, {
          expectedHash: baseHash,
          canEdit: () => !readOnlyNow.current,
        }),
      );
      persist(session.content);
    } catch (e) {
      setImportError(`Prop not added: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const read = async (file: File) => {
    setImportError(undefined);
    try {
      const result = importGltf(new Uint8Array(await file.arrayBuffer()));
      // A file without a scene name is named after the file.
      if (result.doc.name === 'Imported')
        result.doc.name = file.name.replace(/\.[^.]+$/, '') || 'Imported';
      const base = session.content;
      setPending({
        file: file.name,
        result,
        diff: diffCharacterIds(base, result.doc),
        baseHash: characterContentHash(base),
      });
    } catch (e) {
      if (!(e instanceof GltfImportError)) throw e;
      setImportError(`Import refused: ${e.problem} (${e.detail})`);
    }
  };
  const apply = async () => {
    if (!pending || readOnlyNow.current) return;
    const { result, file, baseHash } = pending;
    setBusy(true);
    try {
      // The reviewed diff holds only for the document it was shown against (an Undo may have
      // changed it while the review was open).
      if (characterContentHash(session.content) !== baseHash)
        throw new Error('the character changed since the review; import the file again');
      const latest = storage.current.record();
      if (!latest) throw new Error('no record to save into');
      // Props are the character's, not the file's: they stay, with the joint keys of the actions
      // the file keeps (by action ID).
      const carried = carryProps(session.content, result.doc);
      assertCharacterImportFits(latest, carried.doc, result.assets);
      // The bytes are saved before the content names them.
      await store.stage(
        result.doc.assets.map((ref) => ({
          ref: ref as unknown as CadAssetRef,
          bytes: result.assets.get(ref.id)!,
        })),
      );
      setStored((n) => n + 1);
      session.execute(
        characterEditorCommand(
          { type: 'replaceDocument', document: carried.doc },
          // Read only may have been turned on while the bytes were saved: checked when it runs.
          { expectedHash: baseHash, canEdit: () => !readOnlyNow.current },
        ),
      );
      persist(session.content);
      setReport({
        fileName: file,
        losses: [...result.losses, ...carried.dropped],
        ...(result.vrm ? { vrm: result.vrm } : {}),
      });
      setPending(undefined);
    } catch (e) {
      // The review closes so the reason shows; the document is as it was.
      setPending(undefined);
      setImportError(`Import not applied: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // C3: a mesh edit's new asset is kept before the edit names it, in a record pruned to what the
  // draft, the versions and this session's history still reach.
  const keepMesh = async (asset: { ref: CharacterAssetRef; bytes: Uint8Array }) => {
    if (readOnlyNow.current) throw new Error('permission-denied');
    const latest = storage.current.record();
    if (!latest) throw new Error('no record to save into');
    const { record: next, forget } = characterMeshRecord({
      record: latest,
      content: session.content,
      undo: session.historyEntries('undo'),
      redo: session.historyEntries('redo'),
      ...asset,
    });
    // The Undo entries whose bytes the record drops are forgotten before it is written: none can
    // be restored while the write is pending (or after it), whatever the write's outcome.
    if (forget) session.forgetOldestUndo(forget);
    if (!(await storage.current.persistRecord(next)))
      throw new Error('the browser did not save the mesh');
    setStored((n) => n + 1);
    // Read only may have been turned on while the record was written.
    if (readOnlyNow.current) throw new Error('permission-denied');
  };

  /** C6d: the exported GLB, saved by the browser as a download (read only exports too). */
  const saveFile = (file: { name: string; bytes: Uint8Array }) => {
    const url = URL.createObjectURL(
      new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: 'model/gltf-binary' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div className="character-host">
      <CharacterSurface
        session={session}
        assets={assets}
        readOnly={readOnly}
        canEdit={() => !readOnlyNow.current}
        {...(readOnly ? {} : { onImport: (file: File) => void read(file) })}
        onExport={saveFile}
        {...(importError ? { importError } : {})}
        {...(report ? { report } : {})}
        props={views}
        propChoices={propChoices}
        onAddProp={(c) => void addProp(c)}
        {...(readOnly ? {} : { onMeshAsset: keepMesh })}
        onApplied={(content) => persist(content)}
        {...(import.meta.env.DEV ? { onFrame: exposeProbe } : {})}
        // An edit is admitted like Undo: the record must stay exportable and storable with it.
        admit={(next) => {
          const latest = storage.current.record();
          if (latest) assertCharacterHistoryFits(latest, next);
        }}
        onUndo={() => history('undo')}
        onRedo={() => history('redo')}
      />
      {pending && (
        <CharacterImportReview
          fileName={pending.file}
          diff={pending.diff}
          losses={pending.result.losses}
          busy={busy}
          onApply={() => void apply()}
          onCancel={() => setPending(undefined)}
        />
      )}
    </div>
  );
}
