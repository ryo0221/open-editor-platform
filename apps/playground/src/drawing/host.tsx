import { fixedPdfFont } from '@editor-platform/document/pdf-text';
import { useEffect, useMemo, useRef } from 'react';
import { canonicalJson, commitVersion } from '@editor-platform/artifact-core';
import {
  cadContentHash,
  isCadDocument,
  readCadPmiAsset,
  type CadDocument,
  type CadPmiAsset,
} from '@editor-platform/cad-core';
import {
  BimDrawings,
  bimPartAvailable,
  WorkerBimKernel,
  type BimPartShape,
  type BimPartStatus,
} from '@editor-platform/bim';
import BimKernelWorker from '@editor-platform/bim/worker?worker';
import { bimDrawingState } from './bim-limits';
import {
  bimContentHash,
  bimElevationAxes,
  bimElevationView,
  bimFrameDrawing,
  bimFramingDrawing,
  bimMemberList,
  isBimDocument,
  type BimDocument,
  type BimDrawingScale,
} from '@editor-platform/bim-core';
import {
  DrawingController,
  DrawingProjector,
  drawingBimViewState,
  drawingDeriveKey,
  drawingProjectionJob,
  drawingViewState,
  DrawingSurface,
  type DrawingSourceChoice,
  type DrawingSources,
} from '@editor-platform/drawing';
import ProjectWorker from '@editor-platform/drawing/project-worker?worker';
import '@editor-platform/drawing/style.css';
import {
  drawingIsBuildingView,
  type DrawingDocument,
  type DrawingMeshBody,
  type DrawingPartsInfo,
  type DrawingProjectedView,
  type DrawingView,
  type DrawingViewState,
  type DrawingBimDrawing,
} from '@editor-platform/drawing-core';
import type { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { cadKernel, type StoredArtifact } from '../model';
import { versionCommit } from '../app/version-commit';
import { readBimPartShape } from '../bim/parts';
import { partKernel } from '../bim/part-kernel';
import { drawingCadBodies, drawingCadParts } from './cad-bodies';
import { DrawingMeshes } from './kernel';
import {
  drawingAssetBytes,
  drawingIssueLimits,
  drawingIssuePdf,
  drawingIssueRecord,
  drawingSourceOf,
  stageDrawingSources,
  validateDrawingSources,
} from './sources';
import type { CadResource } from '../cad/resources';

/** Every saved version of every 3D CAD Artifact here, newest first per Artifact. */
function cadChoices(records: readonly StoredArtifact[]): DrawingSourceChoice[] {
  return records.flatMap((r) =>
    r.kind !== 'cad'
      ? []
      : r.versions
          .map((v, i) => ({ v, i }))
          .filter(({ v }) => isCadDocument(v.content))
          .reverse()
          .map(({ v, i }) => {
            const content = v.content as CadDocument;
            const contentHash = cadContentHash(content);
            return {
              key: `${r.id}/${v.versionId}`,
              kind: 'cad' as const,
              artifactId: r.id,
              versionId: v.versionId,
              contentHash,
              name: r.name,
              label: `${r.name} · v${i + 1}`,
            };
          }),
  );
}

/** DW5a: every saved version of every building here, newest first, with its plans and sections. */
function bimChoices(records: readonly StoredArtifact[]): DrawingSourceChoice[] {
  return records.flatMap((r) =>
    r.kind !== 'bim'
      ? []
      : r.versions
          .map((v, i) => ({ v, i }))
          .filter(({ v }) => isBimDocument(v.content))
          .reverse()
          .map(({ v, i }) => {
            const content = v.content as BimDocument;
            return {
              key: `${r.id}/${v.versionId}`,
              kind: 'bim' as const,
              artifactId: r.id,
              versionId: v.versionId,
              contentHash: bimContentHash(content),
              name: r.name,
              label: `${r.name} · v${i + 1}`,
              views: content.views.map((view) => ({
                id: view.id,
                name: view.name,
                kind: view.kind,
                scale: `1:${view.scale}` as const,
              })),
              levels: [...content.levels]
                .sort((a, b) => a.elevationMm - b.elevationMm)
                .map((l) => ({ id: l.id, name: l.name })),
              grids: content.grids.map((g) => ({ id: g.id, label: g.label })),
            };
          }),
  );
}

/** The CAD content of a hash among every stored record's versions (for placed part versions). */
function cadLookup(records: readonly StoredArtifact[]) {
  const byHash = new Map<string, CadDocument>();
  for (const r of records)
    if (r.kind === 'cad')
      for (const v of r.versions)
        if (isCadDocument(v.content)) byHash.set(cadContentHash(v.content), v.content);
  // An assembly's or a building's retained part closure (imported, or parts whose own Artifacts
  // are gone) is kept by its record (Codex on #1237).
  for (const r of records)
    if (r.kind === 'cad' || r.kind === 'bim')
      for (const p of r.cadParts ?? [])
        if (!byHash.has(p.contentHash)) byHash.set(p.contentHash, p.content);
  return (hash: string) => byHash.get(hash);
}

/** DW3c-2: a CAD asset's kept bytes among every stored record (to keep them with the drawing). */
function cadAssetLookup(records: readonly StoredArtifact[]) {
  return (kind: string, sha: string): CadResource | undefined => {
    for (const r of records)
      if (r.kind === 'cad') {
        const found = r.cadResources?.find((x) => x.kind === kind && x.sha256 === sha);
        if (found) return found;
      }
    return undefined;
  };
}

/**
 * Playground binding for the drawing Surface (docs/cad/drawing-editor.md, DW1–DW2). An edit is
 * one session command applied at once; the Host saves the draft afterwards and owns Undo/Redo.
 * A view's source version is kept with the record before the edit that names it, and the view is
 * derived from the kept copy only, so it shows the same wherever the drawing goes.
 */
export default function DrawingHost({
  artifact,
  session,
  readOnly,
  inputs,
  persist,
  record,
  records,
  persistRecord,
}: {
  artifact: StoredArtifact;
  session: EditorSession<DrawingDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  persist(content: DrawingDocument): void;
  record(): StoredArtifact | undefined;
  /** Every stored record: the CAD and building versions the views see (DW2, DW5). */
  records(): StoredArtifact[];
  /** Saves the whole record (a new source version is kept before the edit names it). */
  persistRecord(record: StoredArtifact): Promise<boolean>;
}) {
  const access = useRef(readOnly);
  access.current = readOnly;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const recordRef = useRef(record);
  recordRef.current = record;
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const persistRecordRef = useRef(persistRecord);
  persistRecordRef.current = persistRecord;
  const applied = useRef<string | undefined>(undefined);
  const services = useMemo(
    () => ({
      // Imported geometry evaluates from the drawing's own copy of its bytes (DW3c-2).
      meshes: new DrawingMeshes((sha) => drawingAssetBytes(recordRef.current(), sha)),
      projector: new DrawingProjector(() => new ProjectWorker() as never),
      // DW5a: building views are drawn as the building editor draws them (kernel cuts).
      bim: new WorkerBimKernel({
        spawn: () => new BimKernelWorker() as never,
        build: cadKernel ?? undefined,
      }),
      // The CAD part versions a kept building places, read as the building editor reads them.
      parts: cadKernel ? partKernel(cadKernel) : undefined,
    }),
    [],
  );
  const bimDrawings = useMemo(() => new BimDrawings(services.bim), [services]);
  useEffect(
    () => () => {
      services.meshes.dispose();
      services.projector.dispose();
      services.bim.dispose();
      services.parts?.dispose();
    },
    [services],
  );
  const controller = useMemo(() => {
    /** The kept content of a hash: the record's copies only. */
    const kept = (hash: string) => {
      const r = drawingSourceOf(recordRef.current(), hash);
      return r?.kind === 'cad' ? r.content : undefined;
    };
    const keptBim = (hash: string) => {
      const r = drawingSourceOf(recordRef.current(), hash);
      return r?.kind === 'bim' ? r.content : undefined;
    };
    // A kept building's placed CAD parts: their BReps and what the drawing needs to know of them,
    // or why one can't be read (the drawing leaves it out, as the building editor does).
    const partShapes = new Map<string, Promise<BimPartShape | { code: string }>>();
    const partShape = (hash: string) => {
      let p = partShapes.get(hash);
      if (!p) {
        const content = kept(hash);
        p = content
          ? readBimPartShape(content, hash, services.parts).catch((e: unknown) => ({
              code: e instanceof Error ? e.message : String(e),
            }))
          : Promise.resolve({ code: 'part-source-missing' });
        partShapes.set(hash, p);
        // A failure is not kept: the next drawing tries again.
        void p.then((r) => {
          if ('code' in r) partShapes.delete(hash);
        });
      }
      return p;
    };
    const buildingParts = async (content: BimDocument) => {
      const assets = new Map<string, Uint8Array>();
      const parts = new Map<string, BimPartStatus>();
      const hashes = new Set<string>();
      for (const t of content.types) if (t.kind === 'part') hashes.add(t.source.contentHash);
      for (const hash of hashes) {
        const shape = await partShape(hash);
        if ('code' in shape) {
          parts.set(hash, { status: 'unavailable', code: shape.code });
          continue;
        }
        assets.set(hash, shape.brep);
        parts.set(hash, { status: 'available', ...bimPartAvailable(shape) });
      }
      return { assets, parts };
    };
    const bodies = new Map<string, Promise<DrawingMeshBody[] | { code: string }>>();
    // DW3c-2b: kept PMI assets, read once by hash (null: not a readable PMI asset).
    const pmiAssets = new Map<string, CadPmiAsset | null>();
    const readPmi = (sha: string) => {
      let a = pmiAssets.get(sha);
      if (a === undefined) {
        const bytes = drawingAssetBytes(recordRef.current(), sha);
        if (!bytes) return undefined;
        a = readCadPmiAsset(bytes) ?? null;
        pmiAssets.set(sha, a);
      }
      return a ?? undefined;
    };
    // DW4: each kept version's parts list, worked out once by hash.
    const partsByHash = new Map<string, DrawingPartsInfo>();
    const partsOf = (hash: string) => {
      let p = partsByHash.get(hash);
      const content = kept(hash);
      if (!p && content) {
        p = drawingCadParts(content, kept);
        partsByHash.set(hash, p);
      }
      return p;
    };
    const bodiesOf = (hash: string, only: readonly string[]) => {
      const key = `${hash} ${JSON.stringify(only)}`;
      let p = bodies.get(key);
      if (!p) {
        const content = kept(hash);
        p = content
          ? drawingCadBodies(content, hash, kept, services.meshes.meshes, only, readPmi)
          : Promise.resolve({ code: 'source-missing' });
        bodies.set(key, p);
        void p.then((r) => {
          if (!Array.isArray(r)) bodies.delete(key);
        });
      }
      return p;
    };
    const sources: DrawingSources = {
      choices: () => [...cadChoices(recordsRef.current()), ...bimChoices(recordsRef.current())],
      async prepare(choice, only) {
        const latest = recordRef.current();
        if (!latest) return { code: 'record-missing' };
        // DW5a: a building version (and the CAD part versions it places) kept with the drawing.
        if (choice.kind === 'bim') {
          if (keptBim(choice.contentHash)) return {};
          const from = recordsRef.current().find((r) => r.id === choice.artifactId);
          const version = from?.versions.find((v) => v.versionId === choice.versionId);
          if (!version || !isBimDocument(version.content)) return { code: 'source-missing' };
          let staged: StoredArtifact;
          try {
            staged = stageDrawingSources(
              latest,
              [{ kind: 'bim', content: version.content }],
              cadLookup(recordsRef.current()),
              cadAssetLookup(recordsRef.current()),
            );
          } catch (e) {
            return { code: e instanceof Error ? e.message : 'source-missing' };
          }
          if (staged !== latest && !(await persistRecordRef.current(staged)))
            return { code: 'source-not-kept' };
          return {};
        }
        // DW4b: a version the drawing keeps already (a part of a kept assembly) is drawn from its
        // copy, even where its own Artifact is gone or was never here (Codex on #1232).
        // A version kept only as a part a building places has no asset bytes kept: drawn as CAD
        // now, they are kept too (Codex on #1237).
        let content: CadDocument | undefined = kept(choice.contentHash);
        if (!content) {
          const from = recordsRef.current().find((r) => r.id === choice.artifactId);
          const version = from?.versions.find((v) => v.versionId === choice.versionId);
          if (!version || !isCadDocument(version.content)) return { code: 'source-missing' };
          content = version.content;
        }
        let staged: StoredArtifact;
        try {
          staged = stageDrawingSources(
            latest,
            [{ kind: 'cad', content }],
            cadLookup(recordsRef.current()),
            cadAssetLookup(recordsRef.current()),
          );
        } catch (e) {
          return { code: e instanceof Error ? e.message : 'source-missing' };
        }
        // Kept first, so the edit that names it is never saved without it.
        const grew =
          (staged.drawingSources?.length ?? 0) !== (latest.drawingSources?.length ?? 0) ||
          (staged.drawingAssets?.length ?? 0) !== (latest.drawingAssets?.length ?? 0);
        if (grew && !(await persistRecordRef.current(staged))) return { code: 'source-not-kept' };
        const r = await bodiesOf(choice.contentHash, only ?? []);
        if (!Array.isArray(r)) return r;
        const lo: [number, number, number] = [Infinity, Infinity, Infinity];
        const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (const b of r)
          for (let i = 0; i + 2 < b.positions.length; i += 3)
            for (let k = 0; k < 3; k++) {
              lo[k] = Math.min(lo[k]!, b.positions[i + k]!);
              hi[k] = Math.max(hi[k]!, b.positions[i + k]!);
            }
        if (!Number.isFinite(lo[0])) return { code: 'source-empty' };
        return { box: [lo, hi] };
      },
    };
    // A moved view keeps its projection: only the placement on the paper changes.
    const memberLists = new Map<string, ReturnType<typeof bimMemberList>>();
    /**
     * Projections by job key, shared by the views that show the same thing. One still running is
     * cancelled once every view waiting on it has moved on (Codex on #1278), so an abandoned job
     * never holds the queue for its whole time limit.
     */
    const projections = new Map<
      string,
      {
        result: Promise<DrawingProjectedView | { code: string }>;
        stop: AbortController;
        waiting: number;
        settled: boolean;
      }
    >();
    const project = async (
      key: string,
      start: (signal: AbortSignal) => Promise<DrawingProjectedView | { code: string }>,
      signal: AbortSignal,
    ) => {
      let entry = projections.get(key);
      if (!entry) {
        const stop = new AbortController();
        const made = { result: start(stop.signal), stop, waiting: 0, settled: false };
        entry = made;
        projections.set(key, made);
        void made.result.then((r) => {
          made.settled = true;
          if ('code' in r && projections.get(key) === made) projections.delete(key);
        });
        if (projections.size > 64) {
          const [oldest, first] = projections.entries().next().value!;
          if (first.settled) projections.delete(oldest);
        }
      }
      if (entry.settled) return entry.result;
      const e = entry;
      e.waiting++;
      const leave = () => {
        e.waiting--;
        if (e.waiting === 0 && !e.settled) {
          e.stop.abort();
          if (projections.get(key) === e) projections.delete(key);
        }
      };
      signal.addEventListener('abort', leave, { once: true });
      try {
        return await e.result;
      } finally {
        if (!signal.aborted) {
          signal.removeEventListener('abort', leave);
          e.waiting--;
        }
      }
    };
    const sourceHash = (doc: DrawingDocument, view: DrawingView) =>
      doc.sources.find((s) => s.id === view.sourceId)?.contentHash;
    return new DrawingController({
      session,
      canEdit: () => !access.current,
      // DW6: PDF text in the fixed font documents print with.
      pdfFont: fixedPdfFont,
      // DW6b: an issue is a saved version with its PDF kept beside it, never changed.
      issues: {
        list: () =>
          (recordRef.current()?.drawingIssues ?? []).map((i) => ({
            versionId: i.versionId,
            issuedAt: i.issuedAt,
            sheets: i.sheets,
            byteLength: i.pdf.byteLength,
          })),
        pdf: (versionId) => drawingIssuePdf(recordRef.current(), versionId),
        async issue({ content, pdf, sheets, reason }) {
          // Read-only now (it may have changed while the PDF was made), or a version being saved.
          if (access.current) return 'permission-denied';
          if (versionCommit.current) return 'issue-busy';
          versionCommit.current = true;
          try {
            const before = recordRef.current();
            if (!before) return 'issue-not-saved';
            if (pdf.length > drawingIssueLimits.pdfBytes) return 'issue-too-large';
            if ((before.drawingIssues?.length ?? 0) >= drawingIssueLimits.issues)
              return 'issue-limit';
            const committed = (await commitVersion(
              { ...before, draft: { ...before.draft, content } },
              'local-user',
              reason,
            )) as StoredArtifact;
            const v = committed.versions.at(-1)!;
            if (access.current) return 'permission-denied';
            // The version onto the record as it is now: the draft may have been edited meanwhile,
            // and the controller applies the revision marks to that draft after this returns.
            const cur = recordRef.current() ?? before;
            const result: StoredArtifact = {
              ...cur,
              versions: [...cur.versions, v],
              draft: { ...cur.draft, baseVersionId: v.versionId },
              drawingIssues: [
                ...(cur.drawingIssues ?? []),
                drawingIssueRecord(v.versionId, v.createdAt, sheets, pdf),
              ],
            };
            try {
              validateDrawingSources(result, { stored: true });
            } catch {
              return 'issue-not-saved';
            }
            if (await persistRecordRef.current(result)) return undefined;
            // Not kept: take the issue's version, its PDF and the base change back off the record
            // as it is now, so edits made meanwhile stay (Codex on #1246).
            const latest = recordRef.current() ?? cur;
            await persistRecordRef.current({
              ...latest,
              versions: latest.versions.filter((x) => x.versionId !== v.versionId),
              draft:
                latest.draft.baseVersionId === v.versionId
                  ? { ...latest.draft, baseVersionId: cur.draft.baseVersionId }
                  : latest.draft,
              drawingIssues: (latest.drawingIssues ?? []).filter(
                (i) => i.versionId !== v.versionId,
              ),
            });
            return 'issue-not-saved';
          } finally {
            versionCommit.current = false;
          }
        },
      },
      onApplied: (content) => {
        applied.current = canonicalJson(session.revision);
        persistRef.current(content);
      },
      sources,
      derive: {
        key: (doc, view) => drawingDeriveKey(doc, view, sourceHash(doc, view) ?? ''),
        async run(doc, view, signal): Promise<DrawingViewState> {
          const hash = sourceHash(doc, view);
          if (!hash) return { status: 'failed', code: 'source-missing' };
          if (drawingIsBuildingView(view)) {
            const content = keptBim(hash);
            if (!content) return { status: 'failed', code: 'source-missing' };
            // At the drawing's scale: the symbols' sizes go with it.
            const n = Number(view.scale.split(':')[1]) as BimDrawingScale;
            // DW5c: the version's member list goes with each of its views, empty too, so a list
            // of a newer version with no members keeps its columns (Codex on #1240).
            const listed = <D extends object>(d: D): D & Pick<DrawingBimDrawing, 'members'> => {
              let rows = memberLists.get(hash);
              if (!rows) {
                rows = bimMemberList(content);
                memberLists.set(hash, rows);
                if (memberLists.size > 16) memberLists.delete(memberLists.keys().next().value!);
              }
              return { ...d, members: rows };
            };
            // DW5b: framing plans and framing elevations are drawn from the derived axes alone.
            if (view.kind === 'bim-framing') {
              if (!content.levels.some((l) => l.id === view.levelId))
                return { status: 'failed', code: 'bim-level-missing' };
              return bimDrawingState(view, listed(bimFramingDrawing(content, view.levelId, n)));
            }
            if (view.kind === 'bim-frame') {
              if (!content.grids.some((g) => g.id === view.gridId))
                return { status: 'failed', code: 'bim-grid-missing' };
              return bimDrawingState(
                view,
                listed(bimFrameDrawing(content, view.gridId, view.bandMm, n)),
              );
            }
            const shown =
              view.kind === 'bim-view'
                ? content.views.find((v) => v.id === view.bimViewId)
                : bimElevationView(content, view.side, n);
            if (!shown)
              return {
                status: 'failed',
                code: view.kind === 'bim-view' ? 'bim-view-missing' : 'source-empty',
              };
            const placed = await buildingParts(content);
            if (signal.aborted) return { status: 'pending' };
            const r = await bimDrawings.draw(
              content,
              { ...shown, scale: n },
              placed.assets,
              placed.parts,
            );
            if (signal.aborted) return { status: 'pending' };
            if (r.status === 'error') return { status: 'failed', code: r.code };
            if (view.kind === 'bim-view') return drawingBimViewState(view, listed(r.drawing));
            // An elevation stands outside the axes' ends: its own axes, all of them.
            const axis = new Set(['grid', 'grid-bubble', 'grid-label']);
            const items = r.drawing.items.filter((i) => !axis.has(i.cls ?? ''));
            const shownAt = { ...shown, scale: n };
            return bimDrawingState(
              view,
              listed({ ...r.drawing, items: [...items, ...bimElevationAxes(content, shownAt)] }),
            );
          }
          const job = drawingProjectionJob(doc, view, hash);
          if ('code' in job) return { status: 'failed', code: job.code };
          const r = await bodiesOf(hash, job.spec.only);
          if (!Array.isArray(r)) return { status: 'failed', code: r.code };
          // An edit that moved on already: nothing is queued for it.
          if (signal.aborted) return { status: 'pending' };
          const projected = await project(
            job.key,
            (stop) => services.projector.project(r, job.frame, job.options, stop),
            signal,
          );
          if (signal.aborted) return { status: 'pending' };
          if ('code' in projected) return { status: 'failed', code: projected.code };
          // The PMI of the bodies the view shows (DW3c-2b).
          return drawingViewState(
            view,
            job,
            projected,
            r.flatMap((b) => b.pmi ?? []),
            partsOf(hash),
          );
        },
      },
    });
    // One controller per artifact: the Surface is keyed by it (editor-surfaces).
  }, [session, services, bimDrawings]);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => controller.accessChanged(), [controller, readOnly]);
  // Edits apply at once, so nothing is pending for the Host's export and switch boundaries.
  useEffect(
    () =>
      inputs.register({
        label: 'Drawing',
        read: () => ({ dirty: false, composing: false }),
        prepare: () => () => {},
        focus: () => {},
      }),
    [inputs],
  );
  // Host Undo/Redo or restore changed the session: show it.
  const revision = canonicalJson(session.revision);
  useEffect(() => {
    if (revision !== applied.current) controller.sync();
  }, [controller, revision]);
  return <DrawingSurface controller={controller} hostHistory name={artifact.name} />;
}
