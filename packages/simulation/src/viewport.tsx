/**
 * R3e-4b: the analysed body in the CAD viewport (docs/cad/r3-analysis.md, Surface), with the
 * load and constraint faces drawn in their colours. While a load or constraint is being given its
 * faces, a click on a face reports that face's index on the body's topology table.
 */
import { useEffect, useRef, useState } from 'react';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import { CadViewport } from '@editor-platform/cad/viewport';
import '@editor-platform/cad/style.css';

export interface SimulationViewMark {
  /** Face index on the body's topology table (an edge index with `edge`). */
  face: number;
  color: string;
  /** CR5d (86A8): an edge of the table, drawn over everything as a line (a rim's outline). */
  edge?: boolean;
}

/** R3j-6a: another body of the analysed version, shown next to the source body. */
export interface SimulationViewBody {
  mesh: CadMesh;
  marks: SimulationViewMark[];
  /** Not analysed: drawn faint, and its faces are not picked. */
  faded: boolean;
  /** CR0c: its colour in the CAD version (`#rrggbb`); the neutral grey without one. */
  color?: string;
}

/** The look of a body without a colour of its own, and of the analysed body under a result. */
export const simulationBodyColor = '#9aa4b1';

export function SimulationViewport({
  mesh,
  marks,
  others,
  picking,
  onPickFace,
  note,
  colors,
  color,
  fitKey,
  onPoint,
}: {
  /** The analysed body's display mesh, or undefined while it is evaluated or when it failed. */
  mesh: CadMesh | undefined;
  marks: SimulationViewMark[];
  /** R3j-6a: the version's other bodies (none while a result is shown). */
  others?: readonly SimulationViewBody[];
  /** Faces can be picked (a load or constraint is being given its faces). */
  picking: boolean;
  /** A picked face: its index on the topology table of the body `bodyId`. */
  onPickFace(face: number, bodyId: string): void;
  /** Why no shape is shown (not kept, evaluation failed); "evaluating" when absent without a mesh. */
  note?: string;
  /** R3e-4c: one colour per node of `mesh` (a result's colour map) instead of the body colour. */
  colors?: Float32Array;
  /** CR0c: the analysed body's colour in the CAD version (its paint) when no result is shown. */
  color?: string;
  /** The camera fits again when this changes (another shape is shown); by default, the mesh. */
  fitKey?: string;
  /** R3e-4d: with it, a click on the shown shape gives the point under it (mm), e.g. to read a value. */
  onPoint?(point: [number, number, number]): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<CadViewport | null>(null);
  const [lost, setLost] = useState(false);
  // The viewport drops its objects when the WebGL context is lost: show them again on restore.
  const [restored, setRestored] = useState(0);
  const fitted = useRef<unknown>(undefined);
  const pick = useRef(onPickFace);
  pick.current = onPickFace;
  const point = useRef(onPoint);
  point.current = onPoint;
  const shown = useRef({ mesh, others });
  shown.current = { mesh, others };
  useEffect(() => {
    if (!host.current) return;
    try {
      view.current = new CadViewport(host.current, {
        onPick: () => {},
        onContextLost: () => setLost(true),
        onMeasure: (m) => point.current?.(m.point as [number, number, number]),
        onContextRestored: () => {
          setLost(false);
          setRestored((n) => n + 1);
        },
        onPickTopology: (p) => {
          const { mesh: m, others: o } = shown.current;
          if (p?.kind !== 'face' || !m) return;
          // Pick ids are the shown mesh's: its faces start after `faceBase`. A faint body's are not
          // picked.
          const hit =
            p.bodyId === m.bodyId
              ? m
              : o?.find((b) => !b.faded && b.mesh.bodyId === p.bodyId)?.mesh;
          if (hit) pick.current(p.id - 1 - hit.faceBase, hit.bodyId);
        },
      });
    } catch {
      setLost(true);
    }
    return () => {
      view.current?.dispose();
      view.current = null;
    };
  }, []);
  useEffect(() => view.current?.setTopologyTool(picking ? 'face' : undefined), [picking]);
  const measuring = !!onPoint;
  useEffect(() => view.current?.setMeasureTool(measuring), [measuring]);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const shownBody = (
      m: CadMesh,
      ms: SimulationViewMark[],
      opacity: number,
      look: string = simulationBodyColor,
    ) => ({
      mesh: m,
      color: look,
      opacity,
      selected: false,
      marks: ms.map((k) => ({
        pick: k.edge
          ? { bodyId: m.bodyId, kind: 'edge' as const, id: m.edgeBase + k.face + 1 }
          : { bodyId: m.bodyId, kind: 'face' as const, id: m.faceBase + k.face + 1 },
        color: k.color,
      })),
    });
    v.show(
      mesh
        ? [
            { ...shownBody(mesh, marks, 1, color), ...(colors ? { colors } : {}) },
            // A faint body lets the face picks through to the analysed bodies behind it.
            ...(others ?? []).map((b) => ({
              ...shownBody(b.mesh, b.marks, b.faded ? 0.25 : 1, b.color),
              ...(b.faded ? { topologyTransparent: true } : {}),
            })),
          ]
        : [],
      true,
    );
    // The camera fits a newly shown shape once; later marks keep the user's view.
    const key = fitKey ?? mesh;
    if (mesh && fitted.current !== key) {
      fitted.current = key;
      v.fit({ reset: true });
    }
  }, [mesh, marks, others, colors, color, fitKey, restored]);
  return (
    <div className="cad-viewport simulation-viewport">
      <div ref={host} className="cad-canvas-host" />
      {lost && <p className="cad-viewport-note">The 3D view is not available (WebGL).</p>}
      {!mesh && !lost && (
        <p className="cad-viewport-note">{note ?? 'Evaluating the analysed part…'}</p>
      )}
    </div>
  );
}
