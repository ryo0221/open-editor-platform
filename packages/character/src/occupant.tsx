import { useState } from 'react';
import {
  occupantCheck,
  occupantFigure,
  occupantSightLengthMm,
  poseAt,
  transformPoint,
  type CharacterAction,
  type CharacterDocument,
  type CharacterProp,
  type Mat4,
  type OccupantPiece,
  type OccupantReport,
  type Vec3,
} from '@editor-platform/character-core';
import { Section } from '@editor-platform/editor-ui';
import type { EpmMesh } from '@editor-platform/geometry-mesh';
import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments } from 'three';
import type { PropFrame } from './props';

/** The default eye of a figure facing −y: the front of the head, 150 mm up its bone. */
export const occupantEyeDefaults = {
  offset: [0, -110, 150] as Vec3,
  direction: [0, -1, 0] as Vec3,
};

/** One CR7d check, kept with what it was made for: an edit or another time asks for a new one. */
export interface OccupantResult {
  /**
   * The document it was checked for (the session's, not the display copy, which a change of
   * selection rebuilds).
   */
  doc: CharacterDocument;
  propId: string;
  action: CharacterAction | null;
  tick: number;
  report: OccupantReport;
  /** Piece IDs to names, for the report. */
  names: Map<string, string>;
  /** Parts drawn as boxes (no meshes at hand): not checked. */
  unchecked: string[];
  hPoint?: Vec3;
  hip?: Vec3;
  /** The panel's inputs it was checked with: a panel opened again shows them, not the defaults. */
  inputs: OccupantInputs;
}

/** The occupant panel's inputs, as typed. */
export interface OccupantInputs {
  headBone: string;
  hipBone: string;
  eye: string[];
  look: string[];
  seat: string;
  hPoint: string[];
}

/** The pieces of a prop's frame: its instances grouped by part occurrence, in character space. */
export function occupantPieces(frame: PropFrame | undefined) {
  const pieces = new Map<string, OccupantPiece & { meshes: OccupantPiece['meshes'][number][] }>();
  const names = new Map<string, string>();
  const frames = new Map<string, Mat4>();
  const unchecked = new Set<string>();
  for (const i of frame?.instances ?? []) {
    const id = i.piece?.id ?? '';
    names.set(id, i.piece?.name ?? 'Prop');
    if (i.piece?.frame) frames.set(id, i.piece.frame);
    // A room's air is not an obstacle: a figure stands inside it, rays pass through it.
    if (i.piece?.air) continue;
    if (i.piece?.box) {
      unchecked.add(names.get(id)!);
      continue;
    }
    let p = pieces.get(id);
    if (!p) pieces.set(id, (p = { id, meshes: [] }));
    p.meshes.push({
      positions: i.mesh.positions,
      indices: i.mesh.indices,
      matrix: i.matrix,
      ...(i.mesh.sheet ? { sheet: true } : {}),
      ...(i.body !== undefined ? { body: i.body } : {}),
    });
  }
  return { pieces: [...pieces.values()], names, frames, unchecked: [...unchecked] };
}

const parse = (v: string[]): Vec3 | undefined => {
  const n = v.map((x) => (x.trim() === '' ? Number.NaN : Number(x)));
  return n.every(Number.isFinite) ? (n as Vec3) : undefined;
};
/** One decimal, with no “-0.0” for a value that rounds to zero. */
const one = (v: number) => (Math.abs(v) < 0.05 ? 0 : v).toFixed(1);
const mm = (v: number) => `${one(v)} mm`;

/** The lines the check draws (character space): sight, headroom, H-point to hip. */
export function occupantLines(r: OccupantResult): Float32Array {
  const out: number[] = [];
  const { report } = r;
  if (report.sight) out.push(...report.sight.from, ...report.sight.to);
  if (report.headroom) {
    const top = report.headroom.from;
    const to = report.headroom.hit?.at ?? [top[0], top[1], top[2] + 500];
    out.push(...top, ...to);
  }
  if (r.hPoint && r.hip) out.push(...r.hPoint, ...r.hip);
  return new Float32Array(out);
}

/** The lines as an overlay drawn on top (orange). */
export function occupantOverlay(lines: Float32Array): Group {
  const group = new Group();
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(lines, 3));
  group.add(
    new LineSegments(
      g,
      new LineBasicMaterial({
        color: '#f97316',
        depthTest: false,
        depthWrite: false,
        transparent: true,
      }),
    ),
  );
  group.renderOrder = 10;
  return group;
}

/**
 * CR7d: the occupant check of the figure in a prop (docs/cad/car-design.md, CR7の分け方): the
 * figure's interference with the prop's parts, the headroom over the head's top, the H-point (a
 * point of a seat part, in that part's coordinates) to the hip bone, and a sight line from the eye.
 */
export function OccupantPanel({
  doc,
  source,
  prop,
  action,
  tick,
  meshes,
  figureProblem,
  frame,
  result,
  onResult,
}: {
  doc: CharacterDocument;
  prop: CharacterProp;
  action: CharacterAction | null;
  tick: number;
  /**
   * The figure as the view draws it (`doc` the display document: subdivided parts name their
   * smoothed meshes), its meshes by those IDs.
   */
  meshes: ReadonlyMap<string, EpmMesh>;
  /** The session's document that `doc` displays: a result holds while it is unchanged. */
  source: CharacterDocument;
  /** Why the figure cannot be checked (its assets did not read): nothing is checked then. */
  figureProblem?: string;
  /** The prop as drawn now (its placement and keyed joints applied). */
  frame: PropFrame | undefined;
  result: OccupantResult | undefined;
  onResult(result: OccupantResult | undefined): void;
}) {
  const bones = doc.skeletons.flatMap((s) => s.bones);
  const pick = (names: string[]) =>
    bones.find((b) => names.includes(b.id.toLowerCase()) || names.includes(b.name.toLowerCase()))
      ?.id ??
    bones[0]?.id ??
    '';
  // A panel opened again (another bone or prop selected meanwhile) starts from the inputs of the
  // result it shows; changing an input drops that result, so a report and its lines always
  // answer the inputs shown.
  const kept = result?.inputs;
  const [headBone, setHeadBone] = useState(() => kept?.headBone ?? pick(['head']));
  const [hipBone, setHipBone] = useState(() => kept?.hipBone ?? pick(['hip', 'hips', 'pelvis']));
  const [eye, setEyeValue] = useState(() => kept?.eye ?? occupantEyeDefaults.offset.map(String));
  const [look, setLookValue] = useState(
    () => kept?.look ?? occupantEyeDefaults.direction.map(String),
  );
  const [seat, setSeatValue] = useState(kept?.seat ?? '');
  const [hPoint, setHPointValue] = useState(kept?.hPoint ?? ['0', '0', '0']);
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      if (result) onResult(undefined);
    };
  const setHead = changed(setHeadBone);
  const setHip = changed(setHipBone);
  const setEye = changed(setEyeValue);
  const setLook = changed(setLookValue);
  const setSeat = changed(setSeatValue);
  const setHPoint = changed(setHPointValue);
  const [problem, setProblem] = useState<string>();
  const { pieces, names, frames, unchecked } = occupantPieces(frame);
  const seats = [...names].filter(([id]) => frames.has(id));
  const run = () => {
    setProblem(undefined);
    const offset = parse(eye);
    const direction = parse(look);
    const local = seat ? parse(hPoint) : undefined;
    if (!offset || !direction || (seat && !local)) {
      setProblem('occupant-input: every coordinate must be a number (mm).');
      return;
    }
    if (!pieces.length) {
      setProblem('occupant-no-prop: the prop has no meshes at hand yet.');
      return;
    }
    const side = occupantFigure(doc, meshes, poseAt(doc, action, tick), {
      headBone,
      hipBone,
      eye: { offset, direction },
    });
    const seatFrame = seat ? frames.get(seat) : undefined;
    const h = seatFrame && local ? transformPoint(seatFrame, local) : undefined;
    const report = occupantCheck({ ...side, ...(h ? { hPoint: h } : {}), pieces });
    onResult({
      doc: source,
      propId: prop.id,
      action,
      tick,
      report,
      names,
      unchecked,
      ...(h ? { hPoint: h } : {}),
      ...(side.hip ? { hip: side.hip } : {}),
      inputs: { headBone, hipBone, eye, look, seat, hPoint },
    });
  };
  const current =
    result &&
    result.doc === source &&
    result.propId === prop.id &&
    result.action === action &&
    result.tick === tick
      ? result
      : undefined;
  const r = current?.report;
  const name = (id: string) => current?.names.get(id) ?? id;
  const coords = (label: string, value: string[], set: (v: string[]) => void, disabled = false) => (
    <fieldset className="character-fields" aria-label={label} disabled={disabled}>
      <legend>{label}</legend>
      {(['x', 'y', 'z'] as const).map((axis, k) => (
        <label key={axis}>
          {axis}
          <input
            aria-label={`${label} ${axis}`}
            inputMode="decimal"
            disabled={disabled}
            value={value[k]}
            onChange={(e) => set(value.map((v, j) => (j === k ? e.target.value : v)))}
          />
        </label>
      ))}
    </fieldset>
  );
  return (
    <Section title="Occupant">
      <div data-testid="character-occupant">
        <div className="character-fields">
          <label>
            Head bone
            <select
              aria-label="Head bone"
              value={headBone}
              onChange={(e) => setHead(e.target.value)}
            >
              {bones.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Hip bone
            <select aria-label="Hip bone" value={hipBone} onChange={(e) => setHip(e.target.value)}>
              {bones.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {coords('Eye in the head bone (mm)', eye, setEye)}
        {coords('Eye looks along', look, setLook)}
        <div className="character-fields">
          <label>
            Seat part
            <select aria-label="Seat part" value={seat} onChange={(e) => setSeat(e.target.value)}>
              <option value="">No H-point</option>
              {seats.map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        {coords('H-point in the seat part (mm)', hPoint, setHPoint, !seat)}
        <div className="character-fields">
          <button type="button" disabled={!bones.length || !!figureProblem} onClick={run}>
            Check the occupant
          </button>
        </div>
        <p className="character-hint" role="status" data-testid="character-occupant-status">
          {figureProblem
            ? figureProblem
            : !bones.length
              ? 'The figure has no bones to read the head and hip from.'
              : result && !current
                ? 'The pose, the time or the document changed since the last check: check again.'
                : !r
                  ? 'Checks the figure as posed now against the prop’s parts, on their display meshes.'
                  : r.interference.status === 'refused'
                    ? `${r.interference.code}: the figure and the prop have ${r.interference.triangles} triangles; not checked.`
                    : r.interference.findings.length
                      ? `The figure overlaps ${r.interference.findings.length} part${r.interference.findings.length === 1 ? '' : 's'} of the prop.`
                      : 'The figure overlaps no part of the prop.'}
        </p>
        {problem && (
          <p className="character-hint" role="alert">
            {problem}
          </p>
        )}
        {r?.interference.status === 'ok' && r.interference.findings.length > 0 && (
          <ul aria-label="Parts the figure overlaps">
            {r.interference.findings.map((f) => (
              <li key={f.piece} data-testid="character-occupant-overlap">
                {name(f.piece)} ({f.kind}
                {f.kind === 'unknown' ? ', cannot be judged' : `, about ${mm(f.depthMm)}`})
              </li>
            ))}
          </ul>
        )}
        {r && (
          <ul aria-label="Occupant measures" data-testid="character-occupant-measures">
            <li data-testid="character-occupant-headroom">
              {!r.headroom
                ? 'Headroom: no vertex is carried by the head bone.'
                : r.headroom.hit
                  ? `Headroom: ${mm(r.headroom.hit.distanceMm)} up to ${name(r.headroom.hit.piece)}.`
                  : 'Headroom: nothing of the prop above the head.'}
            </li>
            <li data-testid="character-occupant-hpoint">
              {r.hPoint
                ? `H-point to the hip: ${mm(r.hPoint.distanceMm)} (x ${one(r.hPoint.offsetMm[0])}, y ${one(r.hPoint.offsetMm[1])}, z ${one(r.hPoint.offsetMm[2])}).`
                : 'H-point: choose a seat part and its point.'}
            </li>
            <li data-testid="character-occupant-sight">
              {!r.sight
                ? 'Sight line: the eye direction is zero.'
                : r.sight.hit
                  ? `Sight line: meets ${name(r.sight.hit.piece)} at ${mm(r.sight.hit.distanceMm)}.`
                  : `Sight line: meets nothing within ${mm(occupantSightLengthMm)}.`}
            </li>
          </ul>
        )}
        {current && current.unchecked.length > 0 && (
          <p className="character-hint" role="status">
            Not checked (no meshes at hand): {current.unchecked.join(', ')}
          </p>
        )}
        {r && (
          <p className="character-hint">
            On the display meshes: the values are as fine as their triangles. The sight line is only
            drawn; no standard is judged.
          </p>
        )}
      </div>
    </Section>
  );
}
