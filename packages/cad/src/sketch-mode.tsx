import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { EditorInputs } from '@editor-platform/editor-core';
import {
  CommitInput,
  EditorInputsContext,
  IconButton,
  isTextInput,
} from '@editor-platform/editor-ui';
import { Circle, MousePointer2, PenLine, Scan, Spline, Waves } from 'lucide-react';
import {
  cadCurvature,
  cadLimits,
  combScale,
  combTip,
  formatExpression,
  splineComb,
  splinePoints,
  type CadCombSample,
  type CadDocument,
  type CadSketch,
  type CadSketchConstraint,
  type CadSketchEntity,
  type Length,
} from '@editor-platform/cad-core';
import type { CadController, CadSketchView } from './controller';
import { readCadInput } from './expression-input';
import { constraintTargets, currentLength, type SketchConstraintInput } from './sketch-draft';

/**
 * Sketch mode (docs/cad/r1-modeling.md, Surface, CAD34): the drawing on its plane, seen from the
 * plane's +normal with u to the right and v up, and the panel that constrains and finishes it.
 * Desktop only; nothing here is an edit until Finish.
 */
export type SketchTool = 'select' | 'line' | 'arc' | 'circle' | 'spline';
type Pt = [number, number];
/** Pointer tolerance for snapping and picking, in screen pixels. */
const snapPx = 8;

const kindOf = (s: CadSketch, id: string) => s.entities.find((e) => e.id === id)?.type;
const at = (s: CadSketch, id: string): Pt => s.solved[id] ?? [0, 0];
const radiusOf = (s: CadSketch, e: Extract<CadSketchEntity, { type: 'circle' | 'arc' }>) =>
  e.type === 'circle'
    ? (s.solved[e.id]?.[0] ?? 0)
    : Math.hypot(at(s, e.start)[0] - at(s, e.center)[0], at(s, e.start)[1] - at(s, e.center)[1]);
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The u/v box the drawing covers, at least 200 mm across, with a margin. */
function fitBox(s: CadSketch): [number, number, number, number] {
  const pts: Pt[] = [];
  for (const e of s.entities) {
    if (e.type === 'point') pts.push(at(s, e.id));
    if (e.type === 'circle') {
      const [cu, cv] = at(s, e.center);
      const r = radiusOf(s, e);
      pts.push([cu - r, cv - r], [cu + r, cv + r]);
    }
    if (e.type === 'arc') {
      // The quadrant points the arc passes through bound it with its ends.
      const [cu, cv] = at(s, e.center);
      const r = radiusOf(s, e);
      const angle = (p: Pt) => Math.atan2(p[1] - cv, p[0] - cu);
      const turn = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const [from, to] = e.clockwise
        ? [angle(at(s, e.end)), angle(at(s, e.start))]
        : [angle(at(s, e.start)), angle(at(s, e.end))];
      const sweep = turn(to - from);
      for (let k = 0; k < 4; k++) {
        const t = (k * Math.PI) / 2;
        if (turn(t - from) <= sweep) pts.push([cu + r * Math.cos(t), cv + r * Math.sin(t)]);
      }
    }
  }
  if (!pts.length) return [-100, -100, 200, 200];
  const us = pts.map((p) => p[0]);
  const vs = pts.map((p) => p[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const span = Math.max(200, (u1 - u0) * 1.3, (v1 - v0) * 1.3);
  return [(u0 + u1) / 2 - span / 2, (v0 + v1) / 2 - span / 2, span, span];
}

function arcPath(s: CadSketch, e: Extract<CadSketchEntity, { type: 'arc' }>) {
  const c = at(s, e.center);
  const a = at(s, e.start);
  const b = at(s, e.end);
  const r = radiusOf(s, e);
  let sweep = Math.atan2(b[1] - c[1], b[0] - c[0]) - Math.atan2(a[1] - c[1], a[0] - c[0]);
  if (e.clockwise) sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep;
  else sweep = sweep < 0 ? sweep + 2 * Math.PI : sweep;
  // SVG y is −v, which mirrors the turn: the plane's counter-clockwise is SVG's flag 0.
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  return `M ${a[0]} ${-a[1]} A ${r} ${r} 0 ${large} ${e.clockwise ? 1 : 0} ${b[0]} ${-b[1]}`;
}

/** A comb's teeth as one SVG path: each from its sample to its tip (SVG y is −v). */
const combTeeth = (samples: readonly CadCombSample[], scale: number) =>
  samples
    .map((x) => {
      const tip = combTip(x, scale);
      return `M ${x.at[0]} ${-x.at[1]} L ${tip[0]} ${-tip[1]}`;
    })
    .join(' ');
/** A spline's curve from its control points' current coordinates, 32 samples per knot span. */
const splineCurve = (s: CadSketch, e: Extract<CadSketchEntity, { type: 'spline' }>): Pt[] =>
  splinePoints(
    e.poles.map((q) => at(s, q)),
    e.degree,
    !!e.closed,
    32,
  );
const segmentDistance = (p: Pt, a: Pt, b: Pt) => {
  const d: Pt = [b[0] - a[0], b[1] - a[1]];
  const len2 = d[0] ** 2 + d[1] ** 2 || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / len2));
  return dist(p, [a[0] + t * d[0], a[1] + t * d[1]]);
};

/** Distance from `p` to the drawn element `e` (points are picked separately). */
function hitDistance(s: CadSketch, e: CadSketchEntity, p: Pt): number {
  if (e.type === 'line') return segmentDistance(p, at(s, e.start), at(s, e.end));
  if (e.type === 'spline') {
    const pts = splineCurve(s, e);
    return Math.min(...pts.slice(1).map((b, i) => segmentDistance(p, pts[i]!, b)));
  }
  if (e.type === 'circle' || e.type === 'arc') {
    const off = Math.abs(dist(p, at(s, e.center)) - radiusOf(s, e));
    if (e.type === 'circle') return off;
    const c = at(s, e.center);
    const angle = (q: Pt) => Math.atan2(q[1] - c[1], q[0] - c[0]);
    const turn = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const from = e.clockwise ? angle(at(s, e.end)) : angle(at(s, e.start));
    const to = e.clockwise ? angle(at(s, e.start)) : angle(at(s, e.end));
    return turn(angle(p) - from) <= turn(to - from) ? off : Infinity;
  }
  return Infinity;
}

/**
 * The drawing over the 3D view. Line, arc, circle and spline tools add elements by clicks (a
 * click near a point reuses it); the select tool picks elements and drags points. A spline takes
 * a click per control point: Enter ends it open, a click on its first point closes it. Escape
 * drops the stroke in progress, then leaves the mode without an edit.
 */
export function SketchCanvas({
  controller,
  view,
  tool,
  selected,
  onSelect,
  ownsKey,
  comb,
}: {
  controller: CadController;
  view: CadSketchView;
  tool: SketchTool;
  /** The curvature comb of every spline, its automatic scale times 2 to this power; off when undefined. */
  comb?: number;
  /** Whether a key event belongs to this canvas's Surface (several may be mounted). */
  ownsKey: (e: KeyboardEvent) => boolean;
  selected: string[];
  onSelect: (ids: string[]) => void;
}) {
  const { sketch } = view;
  const svg = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState(() => fitBox(sketch));
  const [pending, setPending] = useState<{ id?: string; at: Pt }[]>([]);
  const [cursor, setCursor] = useState<Pt>();
  const [drag, setDrag] = useState<{ id: string; at: Pt }>();
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = svg.current!;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth || 800));
    observer.observe(element);
    element.focus();
    return () => observer.disconnect();
  }, []);
  useEffect(() => setPending([]), [tool]);
  // A point the stroke started from may be removed from the panel: the stroke goes with it.
  useEffect(
    () =>
      setPending((p) =>
        p.every((q) => !q.id || sketch.entities.some((e) => e.id === q.id)) ? p : [],
      ),
    [sketch.entities],
  );
  // Viewbox is square in mm; the SVG letterboxes it into the canvas.
  const mmPerPx = box[2] / Math.max(1, Math.min(width, svg.current?.clientHeight || width));
  const snap = snapPx * mmPerPx;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const ownsKeyRef = useRef(ownsKey);
  ownsKeyRef.current = ownsKey;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
      if (e.key === 'Escape' && ownsKeyRef.current(e)) {
        // Ahead of the layout, whose Escape would close the side panels.
        e.preventDefault();
        e.stopPropagation();
        if (pendingRef.current.length) setPending([]);
        else controller.cancelSketch();
      }
      if (e.key === 'Enter' && toolRef.current === 'spline' && ownsKeyRef.current(e)) {
        const poles = pendingRef.current;
        if (poles.length < 4) return;
        e.preventDefault();
        controller.sketchSpline(
          poles.map((q) => (q.id ? { id: q.id } : { at: q.at })),
          false,
        );
        setPending([]);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [controller]);

  const toSketch = (e: { clientX: number; clientY: number }): Pt => {
    const m = svg.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return [p.x, -p.y];
  };
  const pointNear = (p: Pt, except?: string) => {
    let best: { id: string; d: number } | undefined;
    for (const e of sketch.entities)
      if (e.type === 'point' && e.id !== except) {
        const d = dist(at(sketch, e.id), p);
        if (d <= snap && (!best || d < best.d)) best = { id: e.id, d };
      }
    return best?.id;
  };
  const elementNear = (p: Pt) => {
    const point = pointNear(p);
    if (point) return point;
    let best: { id: string; d: number } | undefined;
    for (const e of sketch.entities) {
      const d = hitDistance(sketch, e, p);
      if (d <= snap && (!best || d < best.d)) best = { id: e.id, d };
    }
    return best?.id;
  };
  const input = (p: Pt) => {
    const id = pointNear(p);
    return { id, at: id ? at(sketch, id) : p };
  };
  const asInput = (q: { id?: string; at: Pt }) => (q.id ? { id: q.id } : { at: q.at });

  function down(e: PointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    const p = toSketch(e);
    if (tool === 'select') {
      const hit = elementNear(p);
      if (hit && kindOf(sketch, hit) === 'point') {
        setDrag({ id: hit, at: at(sketch, hit) });
        svg.current!.setPointerCapture?.(e.pointerId);
      }
      if (!hit) onSelect([]);
      else if (e.shiftKey || selected.length)
        onSelect(selected.includes(hit) ? selected.filter((x) => x !== hit) : [...selected, hit]);
      else onSelect([hit]);
      return;
    }
    const q = input(p);
    const next = [...pending, q];
    if (tool === 'line' && next.length === 2) {
      const line = controller.sketchLine(asInput(next[0]!), asInput(q));
      const drawn = line ? controller.getSnapshot().sketch?.sketch : undefined;
      const end = drawn?.entities.find((x) => x.id === line);
      // The stroke goes on from the new end, until it closes on a point it started from.
      setPending(end?.type === 'line' && !q.id ? [{ id: end.end, at: q.at }] : []);
    } else if (tool === 'circle' && next.length === 2) {
      controller.sketchCircle(asInput(next[0]!), dist(next[0]!.at, q.at));
      setPending([]);
    } else if (tool === 'arc' && next.length === 3) {
      controller.sketchArc(asInput(next[0]!), asInput(next[1]!), asInput(q), false);
      setPending([]);
    } else if (tool === 'spline' && pending.length >= 4 && dist(q.at, pending[0]!.at) <= snap) {
      // Back on the first control point: the spline closes.
      controller.sketchSpline(pending.map(asInput), true);
      setPending([]);
    } else setPending(next);
  }
  function move(e: PointerEvent<SVGSVGElement>) {
    const p = toSketch(e);
    setCursor(p);
    if (drag) setDrag({ id: drag.id, at: p });
  }
  function up() {
    if (!drag) return;
    const moved = dist(drag.at, at(sketch, drag.id)) > 1e-9;
    setDrag(undefined);
    if (moved) controller.sketchMove(drag.id, drag.at);
  }
  function wheel(e: React.WheelEvent<SVGSVGElement>) {
    const p = toSketch(e);
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    setBox(([u, v, w, h]) => [p[0] - (p[0] - u) * k, p[1] - (p[1] - v) * k, w * k, h * k]);
  }

  const shown: CadSketch = drag
    ? { ...sketch, solved: { ...sketch.solved, [drag.id]: drag.at } }
    : sketch;
  // One scale for every spline, so their teeth compare: the longest is a fifth of its curve's size.
  const combs = useMemo(() => {
    if (comb === undefined) return [];
    const each = shown.entities.flatMap((e) =>
      e.type === 'spline'
        ? [
            {
              id: e.id,
              samples: splineComb(
                e.poles.map((q) => at(shown, q)),
                e.degree,
                !!e.closed,
                cadCurvature.combPerSpan,
              ),
            },
          ]
        : [],
    );
    const scales = each.map((c) => combScale(c.samples)).filter((k) => k > 0);
    const scale = (scales.length ? Math.min(...scales) : 0) * 2 ** comb;
    return each.map((c) => ({ ...c, scale }));
  }, [comb, shown]);
  const problem = new Set(view.problem?.elements ?? []);
  const mark = (id: string) =>
    problem.has(id) ? 'is-problem' : selected.includes(id) ? 'is-selected' : '';
  const construction = (e: CadSketchEntity) =>
    'construction' in e && e.construction ? 'is-construction' : '';
  const preview = cursor && pending.length > 0 && (
    <g className="cad-sketch-preview">
      {tool === 'line' && (
        <line x1={pending[0]!.at[0]} y1={-pending[0]!.at[1]} x2={cursor[0]} y2={-cursor[1]} />
      )}
      {tool === 'spline' && (
        <polyline
          points={[...pending.map((q) => q.at), cursor].map(([x, y]) => `${x},${-y}`).join(' ')}
        />
      )}
      {tool !== 'line' && tool !== 'spline' && (
        <circle
          cx={pending[0]!.at[0]}
          cy={-pending[0]!.at[1]}
          r={dist(pending[0]!.at, pending[1]?.at ?? cursor)}
        />
      )}
    </g>
  );
  const [u, v, w, h] = box;
  return (
    <div className="cad-sketch" data-testid="cad-sketch">
      <svg
        ref={svg}
        className={`cad-sketch-canvas cad-sketch-tool-${tool}`}
        role="application"
        aria-label={`Drawing of ${sketch.name}`}
        aria-roledescription="sketch canvas"
        tabIndex={0}
        viewBox={`${u} ${-(v + h)} ${w} ${h}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={() => setCursor(undefined)}
        onWheel={wheel}
      >
        <g className="cad-sketch-axes">
          <line x1={u} y1={0} x2={u + w} y2={0} />
          <line x1={0} y1={-v} x2={0} y2={-(v + h)} />
        </g>
        {combs.map((c) => (
          <g
            key={`comb-${c.id}`}
            className="cad-sketch-comb"
            data-testid={`cad-sketch-comb-${c.id}`}
          >
            <path d={combTeeth(c.samples, c.scale)} />
            <polyline
              points={c.samples
                .map((x) => combTip(x, c.scale))
                .map(([x, y]) => `${x},${-y}`)
                .join(' ')}
            />
          </g>
        ))}
        {shown.entities.map((e) => {
          const cls = `${mark(e.id)} ${construction(e)}`;
          if (e.type === 'line') {
            const a = at(shown, e.start);
            const b = at(shown, e.end);
            return (
              <line
                key={e.id}
                data-id={e.id}
                className={cls}
                x1={a[0]}
                y1={-a[1]}
                x2={b[0]}
                y2={-b[1]}
              />
            );
          }
          if (e.type === 'circle') {
            const c = at(shown, e.center);
            return (
              <circle
                key={e.id}
                data-id={e.id}
                className={cls}
                cx={c[0]}
                cy={-c[1]}
                r={radiusOf(shown, e)}
              />
            );
          }
          if (e.type === 'arc')
            return <path key={e.id} data-id={e.id} className={cls} d={arcPath(shown, e)} />;
          if (e.type === 'spline') {
            const pts = splineCurve(shown, e);
            const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${-y}`).join(' ');
            const poles = e.poles.map((q) => at(shown, q));
            return (
              <g key={e.id}>
                <polyline
                  className="cad-sketch-control"
                  points={[...poles, ...(e.closed ? [poles[0]!] : [])]
                    .map(([x, y]) => `${x},${-y}`)
                    .join(' ')}
                />
                <path data-id={e.id} className={cls} d={e.closed ? `${d} Z` : d} />
              </g>
            );
          }
          return null;
        })}
        {shown.entities
          .filter((e) => e.type === 'point')
          .map((e) => {
            const p = at(shown, e.id);
            return (
              <circle
                key={e.id}
                data-id={e.id}
                className={`cad-sketch-point ${mark(e.id)}`}
                cx={p[0]}
                cy={-p[1]}
                r={3.5 * mmPerPx}
              />
            );
          })}
        {preview}
      </svg>
      <div className="cad-sketch-view-tools">
        <IconButton icon={Scan} label="Fit sketch" onClick={() => setBox(fitBox(sketch))} />
      </div>
    </div>
  );
}

/** The sketch tools, shown in place of the modelling tools while Sketch mode is open. */
export function SketchTools({
  tool,
  onTool,
}: {
  tool: SketchTool;
  onTool: (tool: SketchTool) => void;
}) {
  const tools: [SketchTool, typeof PenLine, string, string][] = [
    [
      'select',
      MousePointer2,
      'Select',
      'Click elements to constrain them; drag a point to move it',
    ],
    [
      'line',
      PenLine,
      'Draw lines',
      'Click the start, then each next point; Escape ends the stroke',
    ],
    ['arc', Spline, 'Draw arc', 'Click the centre, the start, then the end (counter-clockwise)'],
    ['circle', Circle, 'Draw circle', 'Click the centre, then a point on the circle'],
    [
      'spline',
      Waves,
      'Draw spline',
      'Click 4 or more control points; Enter ends it, a click on the first point closes it',
    ],
  ];
  return (
    <>
      {tools.map(([key, icon, label, reason]) => (
        <IconButton
          key={key}
          icon={icon}
          label={label}
          reason={reason}
          aria-pressed={tool === key}
          onClick={() => onTool(key)}
        />
      ))}
    </>
  );
}

type Kind = CadSketchEntity['type'];
/** Constraints the current selection can take, each built at the drawing's current values. */
function offers(
  s: CadSketch,
  ids: string[],
): { label: string; constraint: SketchConstraintInput }[] {
  const kinds = ids.map((id) => kindOf(s, id));
  const is = (...want: Kind[]) =>
    kinds.length === want.length && want.every((k, i) => kinds[i] === k);
  const curve = (k: Kind | undefined) => k === 'arc' || k === 'circle';
  const out: { label: string; constraint: SketchConstraintInput }[] = [];
  // A dimension is offered only at a value it may take (a zero distance is no dimension).
  const offer = (label: string, constraint: object) => {
    const v = (constraint as { value?: { literalMm?: number } }).value;
    if (v?.literalMm !== undefined && !(v.literalMm >= cadLimits.minDimensionMm)) return;
    out.push({ label, constraint: constraint as SketchConstraintInput });
  };
  const [a, b] = ids as [string, string];
  const endpoints = (line: string): [string, string] => {
    const e = s.entities.find((x) => x.id === line) as Extract<CadSketchEntity, { type: 'line' }>;
    return [e.start, e.end];
  };
  const distances = (p: string, q: string) => {
    const [pp, qq] = [at(s, p), at(s, q)];
    offer('Distance', { type: 'distance', a: p, b: q, value: currentLength(dist(pp, qq)) });
    offer('Horizontal distance', {
      type: 'horizontalDistance',
      a: p,
      b: q,
      value: currentLength(Math.abs(qq[0] - pp[0])),
    });
    offer('Vertical distance', {
      type: 'verticalDistance',
      a: p,
      b: q,
      value: currentLength(Math.abs(qq[1] - pp[1])),
    });
  };
  if (is('line')) {
    offer('Horizontal', { type: 'horizontal', line: a });
    offer('Vertical', { type: 'vertical', line: a });
    distances(...endpoints(a));
  }
  if (is('point')) {
    const p = at(s, a);
    offer('Fix', { type: 'fix', point: a, at: [currentLength(p[0]), currentLength(p[1])] });
  }
  if (is('point', 'point')) {
    offer('Coincident', { type: 'coincident', a, b });
    distances(a, b);
  }
  if (is('line', 'line')) {
    offer('Parallel', { type: 'parallel', a, b });
    offer('Perpendicular', { type: 'perpendicular', a, b });
    offer('Equal', { type: 'equal', a, b });
  }
  if (kinds.length === 1 && curve(kinds[0])) {
    const e = s.entities.find((x) => x.id === a) as Extract<
      CadSketchEntity,
      { type: 'arc' | 'circle' }
    >;
    const r = radiusOf(s, e);
    offer('Radius', { type: 'radius', curve: a, value: currentLength(r) });
    offer('Diameter', { type: 'diameter', curve: a, value: currentLength(2 * r) });
  }
  if (kinds.length === 2 && curve(kinds[0]) && curve(kinds[1])) {
    offer('Equal', { type: 'equal', a, b });
    offer('Tangent', { type: 'tangent', a, b });
  }
  if (kinds.length === 2 && kinds.includes('line') && kinds.some(curve)) {
    const [line, other] = kinds[0] === 'line' ? [a, b] : [b, a];
    offer('Tangent', { type: 'tangent', a: line, b: other });
  }
  if (kinds.length === 2 && kinds.includes('point') && kinds.includes('line')) {
    const [point, line] = kinds[0] === 'point' ? [a, b] : [b, a];
    offer('On line', { type: 'pointOnLine', point, line });
    offer('Midpoint', { type: 'midpoint', point, line });
  }
  if (kinds.length === 2 && kinds.includes('point') && kinds.some(curve)) {
    const [point, c] = kinds[0] === 'point' ? [a, b] : [b, a];
    offer('On curve', { type: 'pointOnCurve', point, curve: c });
  }
  return out;
}

const typeLabel: Record<CadSketchConstraint['type'], string> = {
  coincident: 'Coincident',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
  equal: 'Equal',
  midpoint: 'Midpoint',
  pointOnLine: 'On line',
  pointOnCurve: 'On curve',
  symmetric: 'Symmetric',
  fix: 'Fix',
  distance: 'Distance',
  horizontalDistance: 'Horizontal distance',
  verticalDistance: 'Vertical distance',
  pointLineDistance: 'Point–line distance',
  angle: 'Angle',
  radius: 'Radius',
  diameter: 'Diameter',
};

function DimensionField({
  label,
  value,
  doc,
  onCommit,
}: {
  label: string;
  value: Length;
  doc: CadDocument;
  onCommit: (value: Length) => boolean;
}) {
  const names = (id: string) => doc.parameters.find((p) => p.id === id)?.name ?? id;
  const text =
    'expression' in value
      ? formatExpression(value.expression, names)
      : 'parameterId' in value
        ? names(value.parameterId)
        : 'affine' in value
          ? `${value.affine.scale} * ${names(value.affine.parameterId)} + ${value.affine.offsetMm} mm`
          : value.literalMm;
  return (
    <CommitInput
      label={`${label} (mm)`}
      value={text}
      placeholder="mm or expression"
      onCommit={(input) => {
        const v = readCadInput(input, doc, 'length');
        return onCommit('literal' in v ? { literalMm: v.literal } : v);
      }}
    />
  );
}

/**
 * The panel beside the drawing: its degrees of freedom, the refused change, the constraints the
 * selection can take, the constraints with their dimensions, and Finish / Cancel.
 */
export function SketchPanel({
  controller,
  view,
  doc,
  selected,
  onSelect,
  comb,
  onComb,
}: {
  controller: CadController;
  view: CadSketchView;
  doc: CadDocument;
  selected: string[];
  onSelect: (ids: string[]) => void;
  /** The curvature comb's scale step (SketchCanvas `comb`), undefined when off. */
  comb?: number;
  onComb(comb: number | undefined): void;
}) {
  const { sketch } = view;
  const [distance, setDistance] = useState('10');
  // The dimension fields buffer their input here: Finish commits them first, and keeps the sketch
  // open while one is invalid, refused or composing.
  const fields = useMemo(() => new EditorInputs(), []);
  const [fieldError, setFieldError] = useState<string>();
  const finish = (extrude?: { distance: number }) => {
    try {
      fields.flush();
    } catch (error) {
      return setFieldError(error instanceof Error ? error.message : String(error));
    }
    setFieldError(undefined);
    void controller.finishSketch(extrude);
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const available = useMemo(() => offers(sketch, selected), [sketch, selected]);
  const problem = new Set(view.problem?.elements ?? []);
  const extrudable = Number(distance) > 0 && Number.isFinite(Number(distance));
  return (
    <section className="cad-sketch-panel" aria-label="Sketch" data-testid="cad-sketch-panel">
      <h2 ref={heading}>{view.isNew ? 'New sketch' : `Edit ${sketch.name}`}</h2>
      <output className="cad-sketch-dof" data-testid="cad-sketch-dof">
        {view.dof === 0 ? 'Fully constrained' : `${view.dof} degrees of freedom`}
      </output>
      {fieldError && (
        <p role="alert" className="cad-diagnostic" data-testid="cad-sketch-field-error">
          {fieldError}
        </p>
      )}
      {view.problem && (
        <p role="alert" className="cad-diagnostic" data-testid="cad-sketch-problem">
          {view.problem.message}
        </p>
      )}
      {sketch.entities.some((e) => e.type === 'spline') && (
        <div className="cad-row" role="group" aria-label="Curvature comb">
          <label>
            <input
              type="checkbox"
              checked={comb !== undefined}
              onChange={(e) => onComb(e.target.checked ? 0 : undefined)}
            />{' '}
            Curvature comb
          </label>
          {comb !== undefined && (
            <label>
              Scale{' '}
              <input
                type="range"
                min={-3}
                max={3}
                step={1}
                value={comb}
                onChange={(e) => onComb(Number(e.target.value))}
              />{' '}
              <output>×{2 ** comb}</output>
            </label>
          )}
        </div>
      )}
      <div className="cad-row" role="group" aria-label="Add constraint">
        {available.length ? (
          available.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => {
                if (controller.sketchConstrain(o.constraint)) onSelect([]);
              }}
            >
              {o.label}
            </button>
          ))
        ) : (
          <span className="cad-muted">
            {selected.length
              ? 'No constraint fits this selection.'
              : 'Select elements to constrain them.'}
          </span>
        )}
      </div>
      {selected.length > 0 && (
        <div className="cad-row">
          <button
            type="button"
            onClick={() => {
              if (controller.sketchRemoveAll(selected)) onSelect([]);
            }}
          >
            Remove selected
          </button>
        </div>
      )}
      <EditorInputsContext.Provider value={fields}>
        <ul className="cad-sketch-constraints" aria-label="Constraints">
          {sketch.constraints.map((k) => (
            <li
              key={k.id}
              className={problem.has(k.id) ? 'is-problem' : undefined}
              data-testid={`cad-constraint-${k.id}`}
            >
              <button
                type="button"
                className="cad-item"
                aria-pressed={selected.includes(k.id)}
                onClick={() => onSelect(constraintTargets(k))}
              >
                {typeLabel[k.type]}
                <small>{constraintTargets(k).join(', ')}</small>
              </button>
              {'value' in k && k.type !== 'angle' && (
                <DimensionField
                  label={typeLabel[k.type]}
                  value={k.value as Length}
                  doc={doc}
                  onCommit={(value) => controller.sketchDimension(k.id, value)}
                />
              )}
              <button
                type="button"
                aria-label={`Remove ${typeLabel[k.type]} ${k.id}`}
                onClick={() => controller.sketchRemove(k.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </EditorInputsContext.Provider>
      <p className="cad-muted" data-testid="cad-sketch-region">
        {view.region
          ? `Closed region: ${view.region.outer.length} edges, ${view.region.holes.length} holes`
          : 'No closed region yet'}
      </p>
      <div className="cad-row">
        <button type="button" onClick={() => finish()}>
          Finish
        </button>
        {view.isNew && (
          <>
            <label className="ep-field">
              Extrude (mm)
              <input
                aria-label="Extrude distance (mm)"
                type="number"
                min={0}
                value={distance}
                onChange={(e) => setDistance(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!view.region || !extrudable}
              onClick={() => finish({ distance: Number(distance) })}
            >
              Finish and extrude
            </button>
          </>
        )}
        <button type="button" onClick={() => controller.cancelSketch()}>
          Cancel
        </button>
      </div>
    </section>
  );
}
