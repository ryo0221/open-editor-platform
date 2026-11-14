import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import {
  pcbStackedModel3d,
  pcbStackPlacement,
  pcbZoneFills,
  type Pcb3dModel,
  type PcbStackedSource,
  type PcbDocument,
  type PcbSide,
  type PcbZoneFill,
} from '@editor-platform/pcb-core';
import { writePcbGlb, type PcbGlbMesh } from './glb';
import type { PcbKernel } from './kernel';
import { paintSideArt, pcbSideArt, sideArtSize } from './layer-art';
import {
  pcbFaceSheet,
  pcbFinishOf,
  pcbMeshRequests,
  pcbPieces,
  pcbPlacedSheet,
  pcbStepRequest,
  type Pcb3dPiece,
} from './scene3d';
import { PcbViewport3d, type PcbFaceSheet } from './viewport3d';

type Status =
  | { kind: 'building' }
  | {
      kind: 'ready';
      pieces: number;
      failed: string[];
      omittedHoles: number;
      /** Stacked boards that could not be read: name and why. */
      unread: string[];
    }
  | { kind: 'error'; code: string }
  | { kind: 'unavailable' }
  | { kind: 'no-webgl' };

const statusText = (s: Status) =>
  s.kind === 'building'
    ? 'Building 3D…'
    : s.kind === 'unavailable'
      ? '3D needs the geometry kernel, which this host does not provide.'
      : s.kind === 'no-webgl'
        ? '3D needs WebGL, which this browser does not provide.'
        : s.kind === 'error'
          ? `3D could not be built (${s.code}).`
          : `${s.pieces} pieces` +
            (s.failed.length ? ` · not built: ${s.failed.join(', ')}` : '') +
            (s.omittedHoles ? ` · ${s.omittedHoles} via holes drawn only` : '') +
            (s.unread.length ? ` · not shown: ${s.unread.join(', ')}` : '');

function picture(doc: PcbDocument, fills: PcbZoneFill[], side: PcbSide): HTMLCanvasElement {
  const art = pcbSideArt(doc, fills, side);
  const { pxPerMm, width, height } = sideArtSize(art);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paintSideArt(canvas.getContext('2d')!, art, pxPerMm);
  return canvas;
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const png = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error('png')),
      'image/png',
    ),
  );

/**
 * The stacked boards the view builds with: as read, or none for a board without a stack (a
 * host that does not stack boards leaves them out); undefined while a stack is being read.
 */
export function pcbStackSources(
  doc: PcbDocument,
  stacked: readonly PcbStackedSource[] | undefined,
): readonly PcbStackedSource[] | undefined {
  return stacked ?? (doc.stack.length ? undefined : []);
}

/** A face sheet and the name GLB gives it. */
type NamedSheet = PcbFaceSheet & { name: string };

/**
 * The board in 3D (PB7b): the kernel builds the board and parts from `pcbModel3d`; the faces
 * show the copper, mask and silkscreen as pictures. GLB carries the same pieces and pictures.
 * PB8: the boards stacked on it (`stacked`, read by the Host) are built and shown with it, and
 * GLB and STEP carry them too; until they are read the view waits.
 */
export function PcbView3d({
  doc,
  fills,
  kernel,
  fileStem,
  current,
  stacked,
}: {
  doc: PcbDocument;
  fills: PcbZoneFill[];
  kernel: PcbKernel | undefined;
  fileStem: string;
  /** The board as it is now (after the inspector's pending inputs are committed). */
  current(): PcbDocument;
  /**
   * The stacked boards as read, or undefined while they are being read. Left out by a host
   * that does not stack boards: a board without a stack is built at once.
   */
  stacked?: readonly PcbStackedSource[];
}) {
  const inputs = useContext(EditorInputsContext);
  /** An export asked for while the model was out of date: run once the build catches up. */
  const pending = useRef<(() => Promise<void>) | undefined>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<PcbViewport3d>(undefined);
  const shown = useRef<{
    doc: PcbDocument;
    model: Pcb3dModel;
    pieces: Pcb3dPiece[];
    sheets: NamedSheet[];
  }>(undefined);
  const [status, setStatus] = useState<Status>(
    kernel ? { kind: 'building' } : { kind: 'unavailable' },
  );
  const sources = useMemo(() => pcbStackSources(doc, stacked), [doc, stacked]);
  const model = useMemo(
    () => (sources ? pcbStackedModel3d(doc, sources) : undefined),
    [doc, sources],
  );
  const [webgl, setWebgl] = useState(true);
  useEffect(() => {
    let v: PcbViewport3d;
    try {
      v = new PcbViewport3d(host.current!);
    } catch {
      // WebGL disabled or missing: say so and stay usable (back to 2D).
      setWebgl(false);
      return;
    }
    viewport.current = v;
    return () => {
      v.dispose();
      viewport.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (!webgl) return setStatus({ kind: 'no-webgl' });
    if (!kernel) return setStatus({ kind: 'unavailable' });
    if (!model || !sources) return setStatus({ kind: 'building' });
    const abort = new AbortController();
    setStatus({ kind: 'building' });
    // Edits come in bursts (a drag): build once they settle.
    const timer = setTimeout(() => {
      void kernel.run(model.graph, pcbMeshRequests(model), abort.signal).then((outcome) => {
        if (abort.signal.aborted) return;
        const result = pcbPieces(model, outcome);
        if ('error' in result) return setStatus({ kind: 'error', code: result.error });
        const sheets: NamedSheet[] = (['top', 'bottom'] as const).map((side) => ({
          ...pcbFaceSheet(doc, side),
          picture: picture(doc, fills, side),
          name: side === 'top' ? 'Board top face' : 'Board bottom face',
        }));
        for (const source of sources)
          if ('doc' in source) {
            const place = pcbStackPlacement(doc, source.entry);
            // The stacked board's own fills: the same `pcbZoneFills` its own editor shows.
            const own = pcbZoneFills(source.doc);
            for (const side of ['top', 'bottom'] as const)
              sheets.push({
                ...pcbPlacedSheet(pcbFaceSheet(source.doc, side), place),
                picture: picture(source.doc, own, side),
                name: `${source.entry.name} · ${side === 'top' ? 'top' : 'bottom'} face`,
              });
          }
        const first = !shown.current;
        shown.current = { doc, model, pieces: result.pieces, sheets };
        viewport.current?.show(result.pieces, sheets, first);
        setStatus({
          kind: 'ready',
          pieces: result.pieces.length,
          failed: result.failed,
          omittedHoles: model.omittedHoles,
          unread: sources.flatMap((x) => ('error' in x ? [`${x.entry.name} (${x.error})`] : [])),
        });
        const run = pending.current;
        pending.current = undefined;
        if (run && shown.current.doc === current()) void run();
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [kernel, model, doc, fills, webgl, sources]);

  const [stepState, setStepState] = useState<string>();
  /** PB7c: one kernel run that writes the board and its pieces as STEP (AP214 or AP242). */
  async function exportStep(schema: 'ap214' | 'ap242') {
    // The model the view shows, which `settled` made sure is the board as it is now.
    const model = shown.current?.model;
    if (!kernel || !model) return;
    setStepState('Writing STEP…');
    const outcome = await kernel.run(
      model.graph,
      [],
      undefined,
      pcbStepRequest(model, fileStem, schema),
    );
    const step = outcome.status === 'ok' ? outcome.step : undefined;
    if (step?.status !== 'ok') {
      const why =
        step?.status === 'error'
          ? `${step.code}${step.node ? ` at ${model.parts.find((p) => p.node === step.node)?.name ?? step.node}` : ''}`
          : outcome.status === 'error'
            ? outcome.code
            : outcome.status;
      return setStepState(`STEP could not be written (${why}).`);
    }
    download(new Blob([step.bytes as BlobPart], { type: 'model/step' }), `${fileStem}.step`);
    setStepState(`${fileStem}.step written (${schema === 'ap214' ? 'AP214' : 'AP242'}).`);
  }

  /**
   * Runs an export of the model as the board is now: the inspector's pending inputs are
   * committed first (a refused one keeps its draft and nothing is exported), and an export
   * whose model is out of date waits for the rebuild.
   */
  function settled(run: () => Promise<void>) {
    try {
      inputs?.flush();
    } catch {
      return;
    }
    if (shown.current?.doc === current()) void run();
    else pending.current = run;
  }

  async function exportGlb() {
    const s = shown.current;
    if (!s) return;
    const meshes: PcbGlbMesh[] = s.pieces.map((p) => ({
      name: p.name,
      positions: p.mesh.positions,
      normals: p.mesh.normals,
      indices: p.mesh.indices,
      color: p.color,
      ...pcbFinishOf[p.material],
    }));
    for (const sheet of s.sheets)
      meshes.push({
        name: sheet.name,
        positions: sheet.positions,
        normals: sheet.normals,
        indices: sheet.indices,
        color: '#ffffff',
        metalness: 0.1,
        roughness: 0.55,
        texture: { uvs: sheet.uvs, png: await png(sheet.picture) },
      });
    const bytes = writePcbGlb(meshes, fileStem);
    download(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' }), `${fileStem}.glb`);
  }

  return (
    <div className="pcb-3d" data-testid="pcb-3d">
      <div className="pcb-3d-bar">
        <button type="button" onClick={() => viewport.current?.fit()}>
          Fit
        </button>
        <button type="button" onClick={() => viewport.current?.look([0, 0, -1])}>
          Top
        </button>
        <button type="button" onClick={() => viewport.current?.look([0, 0, 1])}>
          Bottom
        </button>
        <button type="button" disabled={status.kind !== 'ready'} onClick={() => settled(exportGlb)}>
          Export GLB
        </button>
        <button
          type="button"
          disabled={status.kind !== 'ready'}
          onClick={() => settled(() => exportStep('ap214'))}
        >
          Export STEP (AP214)
        </button>
        <button
          type="button"
          disabled={status.kind !== 'ready'}
          onClick={() => settled(() => exportStep('ap242'))}
        >
          Export STEP (AP242)
        </button>
        <span className="pcb-3d-status" data-testid="pcb-3d-status" role="status">
          {statusText(status)}
        </span>
        {stepState && (
          <span className="pcb-3d-status" data-testid="pcb-step-status">
            {stepState}
          </span>
        )}
      </div>
      <div
        className="pcb-3d-view"
        ref={host}
        data-pieces={status.kind === 'ready' ? status.pieces : 0}
      />
    </div>
  );
}
