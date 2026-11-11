/**
 * R3e-4a: the structural analysis Surface's settings (docs/cad/r3-analysis.md, 代表操作1): what is
 * analysed, its material, the mesh settings and the static study. Every edit is one
 * `simulationEditorCommand` prepared against the content it was made on; the Host saves and owns
 * Undo/Redo. R3e-4b: the analysed body in the viewport, where faces are picked for loads and
 * constraints. Running (R3e-4c) comes next.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import type { EditorInputBoundary } from '@editor-platform/editor-core';
import {
  freshSimulationId,
  simulationInputHash,
  simulationLimits,
  simulationMaterialPresets,
  simulationTargets,
  type SimulationDocument,
  type SimulationMaterial,
  type SimulationMeshSettings,
  type SimulationBond,
  type SimulationConstraint,
  type SimulationLoad,
  type SimulationMass,
  type SimulationSpotWeld,
  type SimulationOperation,
  type SimulationPreparation,
  type SimulationStudy,
  type Vec3,
} from '@editor-platform/simulation-core';
import {
  addConditionOps,
  addGravityOps,
  addLocalSizesOp,
  addMassOps,
  addWeightOps,
  defaultModalStudy,
  defaultThermalStudy,
  isThermalKind,
  narrowFaces,
  rimFaces,
  thermalStudyReady,
  bodyFaceTargets,
  targetFacesByBody,
  setLocalSizeOp,
  removeConditionOps,
  retargetOp,
  simulationConditionLabels,
  targetFaces,
  type SimulationBodyFace,
  type SimulationConditionKind,
  type SimulationPickBody,
  type SimulationRimFace,
  spotWeldOf,
  type SimulationWeldRow,
} from './conditions';
import { SimulationViewport, type SimulationViewBody, type SimulationViewMark } from './viewport';
import {
  downloadVtu,
  ResultPanel,
  RunPanel,
  useResultDisplay,
  type RunState,
  type SimulationRunner,
} from './run-panel';
import { bondedBodies, readAt, runResult, vtuResult, type ResultSource } from './results';
import { MappingIssues } from './mapping-issues';
import {
  bondCandidates,
  candidateBond,
  exactBondCandidates,
  takenBondKey,
  type BondCandidateResult,
  type BondDistanceMeasure,
} from './bond-candidates';
import { RecordPanel } from './run-record';
import {
  bendingTestForceN,
  bendingTestOps,
  stiffnessTestResult,
  torsionTestDisplacementMm,
  torsionTestOps,
  type TestAxis,
} from './stiffness-test';

/** R3j-6a: another body of the analysed version, as the Host's kernel evaluated it. */
export interface SimulationOtherBody {
  bodyId: string;
  name: string;
  /** Its result feature: faces picked on it are referenced on it. */
  featureId: string;
  /** Its display mesh; absent when the evaluation shows none (the body failed or is hidden). */
  mesh?: CadMesh;
  /** CR0c: its colour in the CAD version (`#rrggbb`, its paint); absent for the default look. */
  color?: string;
  /** CR5e: a sheet, analysed as a shell on itself at the document's thickness. */
  sheet?: boolean;
}

/** The analysed body as evaluated by the Host's kernel. */
export type SimulationShape =
  | { status: 'evaluating' }
  | { status: 'failed'; message: string }
  /**
   * `featureId` is the body's result feature: picked faces are referenced on it. `others`
   * (R3j-6a): the version's other bodies, which may be analysed with it.
   */
  | {
      status: 'ok';
      mesh: CadMesh;
      featureId: string;
      others?: SimulationOtherBody[];
      /** CR0c: the analysed body's colour in the CAD version (`#rrggbb`), drawn while setting up. */
      color?: string;
      /** CR5e: the analysed body is a sheet (a shell on itself at the document's thickness). */
      sheet?: boolean;
      /**
       * CR4a: measures exact distances from points to the version's faces (its kernel); bond
       * candidates are then found on the exact surfaces, not the display triangles.
       */
      measure?: BondDistanceMeasure;
      /** CR5b: the version's spot weld rows, which the analysis may take as welds. */
      spotWelds?: SimulationWeldRow[];
    };

const noMarks: SimulationViewMark[] = [];

/** Mark colours: the selection, loads, constraints and faces with a finer mesh. */
export const simulationMarkColors = {
  selection: '#2563eb',
  mesh: '#d97706',
  load: '#dc2626',
  constraint: '#16a34a',
  /** R3j-6b: the faces of the bonds taken, and of a candidate being looked at. */
  bond: '#7c3aed',
  candidate: '#0891b2',
  /** CR5d (86A8): the rim pointed at in the rim list. */
  rim: '#db2777',
} as const;

export interface SimulationSurfaceProps {
  doc: SimulationDocument;
  /** The analysed version, as the picker named it, and the body's name; undefined if not kept. */
  source?: { label: string; bodyName: string };
  /** The analysed body's shape; undefined when the version is not kept. */
  shape?: SimulationShape;
  readOnly: boolean;
  /**
   * Applies one user action to `doc`, one operation or several in order, as one Undo step (the
   * Host prepares the command); the reason when refused.
   */
  apply(op: SimulationOperation | SimulationOperation[]): string | undefined;
  /**
   * The Host's save, export and switch boundary: a number field being typed in registers its
   * pending value, which the boundary commits (or refuses) before the content is read.
   */
  registerInput?(boundary: EditorInputBoundary): () => void;
  /** R3e-4c: runs a study in the Host's Worker; without it there is no Run button. */
  runner?: SimulationRunner;
  /** R3e-5b: the analysed version's place ("v2"), when its CAD Artifact is still here. */
  version?: string;
  /** Other saved versions of the analysed CAD Artifact with the same body, newest first. */
  versions?: { versionId: string; label: string }[];
  /** Switches the analysis to one of `versions` (one Undo step); the reason when refused. */
  switchVersion?(versionId: string): Promise<string | undefined>;
}

const InputBoundary = createContext<SimulationSurfaceProps['registerInput']>(undefined);

const field = (label: string, unit: string, input: ReactNode) => (
  <label className="simulation-field">
    <span>
      {label} <small>{unit}</small>
    </span>
    {input}
  </label>
);

/** A number input that applies on commit (blur or Enter), never on each keystroke. */
function NumberInput({
  label,
  value,
  min,
  max,
  step,
  disabled,
  commit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  /** Applies the value; the reason when refused. */
  commit(v: number): string | undefined;
}) {
  const [text, setText] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ text, value, commit });
  latest.current = { text, value, commit };
  const done = () => {
    const { text, value, commit } = latest.current;
    if (text === null) return undefined;
    const v = Number(text);
    setText(null);
    // A cleared or unreadable field goes back to the stored value: it never becomes 0.
    if (text.trim() === '' || !Number.isFinite(v)) return 'Enter a number.';
    return v !== value ? commit(v) : undefined;
  };
  const register = useContext(InputBoundary);
  const editing = text !== null;
  // While typed in, the field is pending at the Host's boundaries (save, export, switch): their
  // flush commits it first, or refuses with the reason. Registered once per edit, not per key.
  useEffect(() => {
    if (!editing || !register) return;
    return register({
      label,
      read: () => ({ dirty: latest.current.text !== null }),
      prepare: () => {
        const t = latest.current.text;
        if (t !== null && (t.trim() === '' || !Number.isFinite(Number(t))))
          throw new Error('Enter a number.');
        return () => (done() ? false : undefined);
      },
      focus: () => input.current?.focus(),
    });
    // `done` reads the latest values through the ref.
  }, [editing, register, label]);
  return (
    <input
      ref={input}
      aria-label={label}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={text ?? String(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done();
        if (e.key === 'Escape') setText(null);
      }}
    />
  );
}

let resultSeq = 0;

/** A length in mm, as the rim list shows it (four significant digits). */
const fmtMm = (x: number) => String(Number(x.toPrecision(4)));

export function SimulationSurface({
  doc,
  source,
  shape,
  readOnly,
  apply,
  registerInput,
  runner,
  version,
  versions,
  switchVersion,
}: SimulationSurfaceProps) {
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [runState, setRunState] = useState<RunState>({ status: 'idle' });
  // R3g-2: the study the panel shows and runs; the first when none is chosen or it was removed.
  const [studyChoice, setStudyChoice] = useState<string>();
  const study = doc.studies.find((s) => s.id === studyChoice) ?? doc.studies[0];
  const [showing, setShowing] = useState(false);
  // What a run solves: recording it (or renaming the analysis) leaves the shown run current.
  const hash = simulationInputHash(doc);
  // A finished run belongs to its study: another chosen study shows no result until it is run.
  const shownState: RunState =
    runState.status === 'done' && runState.run.studyId !== study?.id
      ? { status: 'idle' }
      : runState;
  const lastRun = shownState.status === 'done' ? shownState : undefined;
  const [imported, setImported] = useState<ResultSource>();
  const [resultError, setResultError] = useState('');
  const runFields = lastRun?.run.fields;
  // R3j-6c: the body of a bonded run shown, or every body together.
  // Undefined: every body (a body's ID can be any name, so none stands for all of them).
  const [resultBody, setResultBody] = useState<string>();
  const solvedBodies = useMemo(
    () => (runFields ? bondedBodies(runFields) : undefined),
    [runFields],
  );
  const shownBody = solvedBodies?.some((b) => b.bodyId === resultBody) ? resultBody : undefined;
  const runSource = useMemo(
    () => (runFields ? runResult(runFields, shownBody) : undefined),
    [runFields, shownBody],
  );
  // An opened VTU is shown instead of the run until it is closed.
  const result = imported ?? runSource;
  // A new result (another run, or a VTU opened or closed) refits the camera; a field or section
  // change keeps it.
  const resultKey = useMemo(() => `result-${++resultSeq}`, [result]);
  const display = useResultDisplay(result);
  const resultShown = showing && !!display.shown;
  const [point, setPoint] = useState<number[]>();
  const readout = point && display.shown ? readAt(display.shown, point) : undefined;
  const openVtu = (file: File) => {
    void file.text().then(
      (text) => {
        try {
          setImported(vtuResult(text, file.name));
          setPoint(undefined);
          setResultError('');
          setShowing(true);
        } catch (e) {
          setResultError(`Not opened: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      (e: unknown) => setResultError(`Not opened: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  // The running job's Worker is stopped when the Surface goes away (another Artifact opened).
  const activeJob = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => activeJob.current?.(), []);
  const startRun = (onHost = false) => {
    if (!runner || !study || runState.status === 'running') return;
    const at = hash;
    let live = true;
    const job = runner.run(
      study.id,
      (progress) => {
        if (live) setRunState({ status: 'running', progress, cancel });
      },
      { onHost },
    );
    const stop = () => {
      live = false;
      activeJob.current = undefined;
      job.cancel();
    };
    const cancel = () => {
      stop();
      setRunState({ status: 'idle' });
    };
    activeJob.current = stop;
    setRunState({ status: 'running', cancel });
    job.result.then(
      (run) => {
        if (!live) return;
        live = false;
        activeJob.current = undefined;
        setRunState({ status: 'done', run, hash: at });
        setImported(undefined);
        setPoint(undefined);
        setShowing(!!run.fields);
      },
      (e: unknown) => {
        if (!live) return;
        live = false;
        activeJob.current = undefined;
        setRunState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
  };
  /** One user action, one operation or several, as one Undo step; the reason when refused. */
  const run = (op: SimulationOperation | SimulationOperation[]) => {
    const reason = apply(op);
    setError(reason ?? '');
    return reason;
  };
  const ok = shape?.status === 'ok' ? shape : undefined;
  const sourceBodyId = doc.source.bodyId;
  // R3j-6a: the bodies faces are picked on: the source body and every other analysed body shown.
  const pickBodies = useMemo(() => {
    const out = new Map<
      string,
      SimulationPickBody & { mesh: CadMesh; name: string; sheet?: boolean }
    >();
    if (!ok) return out;
    out.set(sourceBodyId, {
      table: ok.mesh.topology,
      featureId: ok.featureId,
      mesh: ok.mesh,
      name: source?.bodyName ?? 'Analysed body',
      ...(ok.sheet ? { sheet: true } : {}),
    });
    const analysed = new Set((doc.bodies ?? []).map((b) => b.bodyId));
    for (const o of ok.others ?? [])
      if (o.mesh && analysed.has(o.bodyId))
        out.set(o.bodyId, {
          table: o.mesh.topology,
          featureId: o.featureId,
          mesh: o.mesh,
          name: o.name,
          ...(o.sheet ? { sheet: true } : {}),
        });
    return out;
  }, [ok, doc.bodies, sourceBodyId, source?.bodyName]);
  const bodyName = (id: string) =>
    id === sourceBodyId
      ? (source?.bodyName ?? 'Analysed body')
      : (ok?.others?.find((o) => o.bodyId === id)?.name ?? id);
  // R3j-6c: how each body was solved in the shown run, when it is current.
  const solvedNow = lastRun && lastRun.hash === hash ? solvedBodies : undefined;
  const [selection, setSelection] = useState<{ shape: unknown; faces: SimulationBodyFace[] }>();
  // R3j-6b: the faces of a bond or candidate being looked at, drawn in their own colour.
  const [preview, setPreview] = useState<SimulationBodyFace[]>();
  // CR5d (86A8): the rim a pointer or focus is on in the rim list, outlined in the view.
  const [pointedRim, setPointedRim] = useState<SimulationBodyFace>();
  // A selection belongs to the shape it was picked on, and only to bodies still analysed.
  const selected = useMemo(
    () =>
      ok && selection?.shape === ok ? selection.faces.filter((f) => pickBodies.has(f.bodyId)) : [],
    [ok, selection, pickBodies],
  );
  const isSelected = (bodyId: string, face: number) =>
    selected.some((f) => f.bodyId === bodyId && f.face === face);
  const toggleFace = (face: number, bodyId = sourceBodyId) => {
    if (!ok) return;
    const faces = isSelected(bodyId, face)
      ? selected.filter((f) => f.bodyId !== bodyId || f.face !== face)
      : [...selected, { bodyId, face }];
    setSelection({ shape: ok, faces });
  };
  // R3j-1: a plate's rims are too narrow to click: they are offered next to the selection, on
  // each body with selected faces.
  const narrow = useMemo(() => {
    const out = new Map<string, Map<number, SimulationRimFace>>();
    for (const [id, b] of pickBodies) out.set(id, narrowFaces(b.table));
    return out;
  }, [pickBodies]);
  const isNarrow = (f: SimulationBodyFace) => !!narrow.get(f.bodyId)?.has(f.face);
  const rims: (SimulationRimFace & { bodyId: string })[] = [];
  for (const [id, b] of pickBodies) {
    const faces = selected.filter((f) => f.bodyId === id).map((f) => f.face);
    for (const r of rimFaces(b.table, faces)) rims.push({ ...r, bodyId: id });
  }
  // CR5d: a pointed rim outlined only while it is still offered (adding it removes its button,
  // which then never sees the pointer leave).
  const shownRim =
    pointedRim && rims.some((r) => r.bodyId === pointedRim.bodyId && r.face === pointedRim.face)
      ? pointedRim
      : undefined;
  const keepRims = () => {
    if (!ok) return;
    setSelection({ shape: ok, faces: selected.filter(isNarrow) });
  };
  const resolved = useMemo(() => {
    const out = new Map<string, ReturnType<typeof targetFacesByBody>>();
    for (const item of [...doc.loads, ...doc.constraints, ...(doc.masses ?? [])])
      if ('targets' in item)
        out.set(item.id, targetFacesByBody(sourceBodyId, pickBodies, item.targets));
    return out;
  }, [pickBodies, doc, sourceBodyId]);
  // Kept apart from the items' map: an item's ID may be any string. Local sizes are the source
  // body's.
  const localResolved = useMemo(
    () => (ok ? doc.mesh.local.map((l) => targetFaces(ok.mesh.topology, [l.target])) : []),
    [ok, doc],
  );
  /** Each body's marks: finer-mesh faces, constraints, loads, then the selection over them. */
  const marks = useMemo(() => {
    const out = new Map<string, SimulationViewMark[]>();
    const push = (bodyId: string, face: number, color: string) => {
      const list = out.get(bodyId) ?? [];
      list.push({ face, color });
      out.set(bodyId, list);
    };
    const mark = (ids: string[], color: string) => {
      for (const id of ids)
        for (const f of resolved.get(id)?.faces ?? []) push(f.bodyId, f.face, color);
    };
    for (const r of localResolved)
      for (const face of r.faces) push(sourceBodyId, face, simulationMarkColors.mesh);
    mark(
      doc.constraints.map((c) => c.id),
      simulationMarkColors.constraint,
    );
    mark(
      [...doc.loads, ...(doc.masses ?? [])].map((l) => l.id),
      simulationMarkColors.load,
    );
    // R3j-6b: the bonds' faces, then a candidate being looked at, under the selection.
    for (const b of doc.bonds ?? [])
      for (const f of targetFacesByBody(sourceBodyId, pickBodies, [...b.follower, ...b.on]).faces)
        push(f.bodyId, f.face, simulationMarkColors.bond);
    for (const f of preview ?? []) push(f.bodyId, f.face, simulationMarkColors.candidate);
    for (const f of selected) push(f.bodyId, f.face, simulationMarkColors.selection);
    // A rim is often under a pixel: its face and its outline (lines drawn over everything).
    const rim = shownRim && pickBodies.get(shownRim.bodyId);
    if (shownRim && rim) {
      push(shownRim.bodyId, shownRim.face, simulationMarkColors.rim);
      const list = out.get(shownRim.bodyId)!;
      rim.table.edges.forEach((e, i) => {
        if (e.faces.includes(shownRim.face))
          list.push({ face: i, color: simulationMarkColors.rim, edge: true });
      });
    }
    return out;
  }, [resolved, localResolved, doc, selected, sourceBodyId, pickBodies, preview, shownRim]);
  const otherViews = useMemo<SimulationViewBody[]>(
    () =>
      (ok?.others ?? []).flatMap((o) =>
        o.mesh
          ? [
              {
                mesh: o.mesh,
                marks: marks.get(o.bodyId) ?? noMarks,
                faded: !pickBodies.has(o.bodyId),
                ...(o.color ? { color: o.color } : {}),
              },
            ]
          : [],
      ),
    [ok, marks, pickBodies],
  );
  /**
   * References for the selected faces, or undefined with the reason shown: a face without a name,
   * or one its neighbours' names cannot tell apart, cannot be referenced (nothing is applied).
   */
  const selectedTargets = () => {
    if (!ok) return [];
    try {
      return bodyFaceTargets(sourceBodyId, pickBodies, selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };
  const addCondition = (kind: SimulationConditionKind) => {
    const targets = selectedTargets();
    if (!targets) return;
    run(addConditionOps(doc, kind, targets));
    setSelection(undefined);
  };
  // CR0b: a part's weight on the selected faces, as a force of m g (an equivalent static load).
  const [weightKg, setWeightKg] = useState(100);
  const addWeight = () => {
    const targets = selectedTargets();
    if (!targets) return;
    run(addWeightOps(doc, targets, weightKg));
    setSelection(undefined);
  };
  // CR5a: the same mass as an added mass, which also counts in modal studies.
  const addMass = () => {
    const targets = selectedTargets();
    if (!targets) return;
    run(addMassOps(doc, targets, weightKg));
    setSelection(undefined);
  };
  // CR5c: the stiffness tests, made from the mounts picked in order (front left, front right,
  // rear left, rear right; a bending test's loaded faces after them).
  const [testDisplacementMm, setTestDisplacementMm] = useState(torsionTestDisplacementMm);
  const [testForceN, setTestForceN] = useState(bendingTestForceN);
  const [testUp, setTestUp] = useState<TestAxis>(2);
  const addTest = (kind: 'torsion' | 'bending') => {
    const targets = selectedTargets();
    if (!targets) return;
    const mounts = {
      frontLeft: [targets[0]!],
      frontRight: [targets[1]!],
      rear: [targets[2]!, targets[3]!],
    };
    let ops: SimulationOperation[];
    try {
      ops =
        kind === 'torsion'
          ? torsionTestOps(doc, mounts, testDisplacementMm, testUp)
          : bendingTestOps(doc, { ...mounts, loaded: targets.slice(4) }, testForceN, testUp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    const made = ops.find((op) => op.type === 'addStudy');
    if (!run(ops) && made?.type === 'addStudy') setStudyChoice(made.study.id);
    setSelection(undefined);
  };
  const material = doc.materials.find((m) => m.id === doc.materialId);
  const setMaterial = (m: SimulationMaterial) => run({ type: 'updateMaterial', material: m });
  const choosePreset = (index: number) => {
    const preset = simulationMaterialPresets[index]!;
    const existing = doc.materials.find((m) => m.name === preset.name);
    if (existing) return run({ type: 'setBodyMaterial', materialId: existing.id });
    const id = freshSimulationId(doc, 'material');
    // One edit for the user: the material and its assignment, one Undo step.
    run([
      { type: 'addMaterial', material: { id, ...preset } },
      { type: 'setBodyMaterial', materialId: id },
    ]);
  };
  const setMesh = (patch: Partial<SimulationMeshSettings>) =>
    run({ type: 'setMeshSettings', mesh: { ...doc.mesh, ...patch } });
  const setPreparation = (patch: Partial<SimulationPreparation>) =>
    run({ type: 'setPreparation', preparation: { ...doc.preparation, ...patch } });
  const addLocalSizes = () => {
    if (selected.some((f) => f.bodyId !== sourceBodyId)) {
      setError('A finer size is given on the source body’s faces only.');
      return;
    }
    const targets = selectedTargets();
    if (!targets) return;
    const op = addLocalSizesOp(doc, targets);
    if (op) run(op);
    else setError('The selected faces already have a finer size.');
    setSelection(undefined);
  };
  const L = simulationLimits;
  const addStudy = (made: SimulationStudy) => {
    if (!run({ type: 'addStudy', study: made })) setStudyChoice(made.id);
  };
  return (
    <InputBoundary.Provider value={registerInput}>
      <section className="simulation-surface" aria-label="Structural analysis">
        <header>
          <h2>{doc.name}</h2>
          <p className="simulation-source">
            {source ? (
              <>
                Analyses <strong>{source.label}</strong>
              </>
            ) : (
              <>The analysed 3D CAD version is not kept with this Artifact.</>
            )}{' '}
            <small title={doc.source.contentHash}>({doc.source.contentHash.slice(0, 12)}…)</small>
          </p>
          {!!versions?.length && switchVersion && (
            <label className="simulation-field">
              <span>CAD version</span>
              <select
                aria-label="CAD version"
                value={doc.source.versionId}
                disabled={readOnly || switching}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  setSwitching(true);
                  void switchVersion(id).then((reason) => {
                    setSwitching(false);
                    setError(reason ?? '');
                    setSelection(undefined);
                  });
                }}
              >
                <option value={doc.source.versionId}>{version ?? 'Analysed version'}</option>
                {versions.map((v) => (
                  <option key={v.versionId} value={v.versionId}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </header>
        <div className="simulation-body">
          <div className="simulation-view">
            <SimulationViewport
              mesh={resultShown ? display.shown!.mesh : ok?.mesh}
              colors={resultShown ? display.shown!.colors : undefined}
              color={resultShown ? undefined : ok?.color}
              fitKey={
                resultShown
                  ? resultKey
                  : // A new CAD version (or body) is a new shape: fit the camera to it again.
                    `shape:${doc.source.contentHash}:${doc.source.bodyId}`
              }
              marks={resultShown ? noMarks : (marks.get(sourceBodyId) ?? noMarks)}
              others={resultShown ? undefined : otherViews}
              picking={!!ok && !readOnly && !resultShown}
              onPoint={resultShown ? setPoint : undefined}
              onPickFace={toggleFace}
              note={
                !shape
                  ? 'The analysed version is not kept: its shape cannot be shown.'
                  : shape.status === 'failed'
                    ? `The analysed part could not be evaluated: ${shape.message}`
                    : undefined
              }
            />
            {!resultShown && (
              <p className="simulation-note simulation-legend">
                <span style={{ color: simulationMarkColors.selection }}>■</span> selected{' '}
                <span style={{ color: simulationMarkColors.load }}>■</span> loads{' '}
                <span style={{ color: simulationMarkColors.constraint }}>■</span> constraints
                {pickBodies.size > 1 && (
                  <>
                    {' '}
                    <span style={{ color: simulationMarkColors.bond }}>■</span> bonds{' '}
                    <span style={{ color: simulationMarkColors.candidate }}>■</span> looked at
                  </>
                )}
              </p>
            )}
          </div>
          <div className="simulation-panel">
            {!!ok && (!!ok.others?.length || !!doc.bodies?.length || !!ok.sheet) && (
              <BodiesPanel
                doc={doc}
                sourceName={source?.bodyName ?? 'Analysed body'}
                sourceSheet={!!ok.sheet}
                others={ok.others ?? []}
                study={study}
                readOnly={readOnly}
                run={run}
                refuse={setError}
                solved={solvedNow}
              />
            )}
            {/* Bonds already taken stay removable when one of their bodies left the version. */}
            {(pickBodies.size > 1 || !!doc.bonds?.length) && (
              <BondsPanel
                doc={doc}
                bodies={pickBodies}
                study={study}
                readOnly={readOnly}
                run={run}
                preview={setPreview}
                {...(ok?.measure ? { measure: ok.measure } : {})}
              />
            )}
            {/* CR5b: welds taken stay listed (as missing) when the version drops their row. */}
            {(!!ok?.spotWelds?.length || !!doc.spotWelds?.length) && (
              <SpotWeldsPanel
                doc={doc}
                rows={ok?.spotWelds ?? []}
                bodies={pickBodies}
                readOnly={readOnly}
                run={run}
                preview={setPreview}
              />
            )}
            <fieldset className="simulation-group" disabled={readOnly}>
              <legend>Loads and constraints</legend>
              <p className="simulation-note" aria-live="polite">
                {readOnly
                  ? 'Read only.'
                  : !ok
                    ? 'Faces can be picked once the part is shown.'
                    : selected.length
                      ? `${selected.length} face${selected.length === 1 ? '' : 's'} selected.`
                      : 'Click faces in the view to select them.'}
              </p>
              {(rims.length > 0 || selected.some(isNarrow)) && (
                <div className="simulation-actions" role="group" aria-label="Rim faces">
                  {rims.map((r) => (
                    <button
                      key={`${r.bodyId}:${r.face}`}
                      type="button"
                      title="A narrow face next to the selection (a plate's rim): outlined in the view while pointed at"
                      onClick={() => {
                        setPointedRim(undefined);
                        toggleFace(r.face, r.bodyId);
                      }}
                      onPointerEnter={() => setPointedRim({ bodyId: r.bodyId, face: r.face })}
                      onPointerLeave={() => setPointedRim(undefined)}
                      onFocus={() => setPointedRim({ bodyId: r.bodyId, face: r.face })}
                      onBlur={() => setPointedRim(undefined)}
                    >
                      Add rim {r.face + 1}
                      {pickBodies.size > 1 ? ` of ${pickBodies.get(r.bodyId)?.name}` : ''} (
                      {fmtMm(r.length)} × {fmtMm(r.width)} mm)
                    </button>
                  ))}
                  {selected.some((f) => !isNarrow(f)) && selected.some(isNarrow) && (
                    <button type="button" onClick={keepRims}>
                      Keep only rim faces
                    </button>
                  )}
                </div>
              )}
              <div className="simulation-actions">
                {(['fixed', 'pinned', 'force', 'pressure'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={!selected.length}
                    onClick={() => addCondition(kind)}
                  >
                    Add {simulationConditionLabels[kind].toLowerCase()}
                  </button>
                ))}
                <button
                  type="button"
                  title="The own weight of every body in the static studies"
                  disabled={doc.loads.some((l) => l.kind === 'gravity')}
                  onClick={() => run(addGravityOps(doc))}
                >
                  Add gravity
                </button>
              </div>
              <div className="simulation-actions" role="group" aria-label="Added weight">
                {field(
                  'Weight',
                  'kg',
                  <NumberInput
                    label="Weight (kg)"
                    value={weightKg}
                    min={0.001}
                    max={1e6}
                    step={10}
                    disabled={readOnly}
                    commit={(v) => {
                      if (!(v > 0) || v > 1e6)
                        return 'Enter a mass above 0 kg, at most 1,000,000 kg.';
                      setWeightKg(v);
                      return undefined;
                    }}
                  />,
                )}
                <button type="button" disabled={!selected.length} onClick={addWeight}>
                  Add weight
                </button>
                <button type="button" disabled={!selected.length} onClick={addMass}>
                  Add mass
                </button>
              </div>
              <p className="simulation-note">
                A weight is a force of m g on the selected faces (an equivalent static load): it
                acts in static studies only and does not change natural frequencies or masses. A
                mass is carried by the faces in every study: it falls with gravity and lowers the
                natural frequencies, without adding stiffness.
              </p>
              <div className="simulation-actions" role="group" aria-label="Stiffness tests">
                {field(
                  'Twist',
                  'mm',
                  <NumberInput
                    label="Test displacement (mm)"
                    value={testDisplacementMm}
                    min={0.001}
                    max={100}
                    step={0.1}
                    disabled={readOnly}
                    commit={(v) => {
                      if (!(v > 0) || v > 100)
                        return 'Enter a displacement above 0 mm, at most 100 mm.';
                      setTestDisplacementMm(v);
                      return undefined;
                    }}
                  />,
                )}
                {field(
                  'Push',
                  'N',
                  <NumberInput
                    label="Test force (N)"
                    value={testForceN}
                    min={0.001}
                    max={1e7}
                    step={100}
                    disabled={readOnly}
                    commit={(v) => {
                      if (!(v > 0) || v > 1e7)
                        return 'Enter a force above 0 N, at most 10,000,000 N.';
                      setTestForceN(v);
                      return undefined;
                    }}
                  />,
                )}
                <label>
                  Up{' '}
                  <select
                    aria-label="Test up axis"
                    value={testUp}
                    disabled={readOnly}
                    onChange={(e) => setTestUp(Number(e.currentTarget.value) as TestAxis)}
                  >
                    <option value={0}>x</option>
                    <option value={1}>y</option>
                    <option value={2}>z</option>
                  </select>
                </label>
                <button
                  type="button"
                  disabled={readOnly || selected.length !== 4}
                  onClick={() => addTest('torsion')}
                >
                  Torsion test
                </button>
                <button
                  type="button"
                  disabled={readOnly || selected.length < 5}
                  onClick={() => addTest('bending')}
                >
                  Bending test
                </button>
              </div>
              <p className="simulation-note">
                A stiffness test is a study of its own supports and loads. Pick the front left,
                front right, rear left and rear right mounts, in that order. Torsion holds the rear
                and moves the front left mount up and the front right one down; bending holds the
                rear, holds the front up and down only, and pushes the faces picked after the four
                mounts (the seats) down. Mounts on a section that can distort (no bulkhead or closed
                box near them) give a much lower stiffness.
              </p>
              <div className="simulation-actions" aria-label="Thermal conditions">
                {(['temperature', 'heat-flux', 'convection'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={!selected.length}
                    onClick={() => addCondition(kind)}
                  >
                    Add {simulationConditionLabels[kind].toLowerCase()}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={!selected.length}
                  onClick={() => setSelection(undefined)}
                >
                  Clear selection
                </button>
              </div>
              <ul className="simulation-items" aria-label="Loads and constraints">
                {[...doc.constraints, ...doc.loads].map((item) => (
                  <ConditionItem
                    key={item.id}
                    item={item}
                    collection={
                      doc.loads.includes(item as SimulationLoad) ? 'loads' : 'constraints'
                    }
                    faces={resolved.get(item.id)}
                    readOnly={readOnly}
                    selected={selected.length}
                    run={run}
                    retarget={() => {
                      const targets = selectedTargets();
                      if (!targets) return;
                      const op = retargetOp(item, targets);
                      if (op) run(op);
                      setSelection(undefined);
                    }}
                    remove={(collection) => run(removeConditionOps(doc, collection, item.id))}
                  />
                ))}
                {(doc.masses ?? []).map((m) => (
                  <MassItem
                    key={m.id}
                    item={m}
                    faces={resolved.get(m.id)}
                    readOnly={readOnly}
                    selected={selected.length}
                    run={run}
                    retarget={() => {
                      const targets = selectedTargets();
                      if (!targets) return;
                      run({ type: 'updateMass', mass: { ...m, targets } });
                      setSelection(undefined);
                    }}
                  />
                ))}
              </ul>
            </fieldset>
            <fieldset className="simulation-group" disabled={readOnly}>
              <legend>Material</legend>
              <label className="simulation-field">
                <span>Preset</span>
                <select
                  aria-label="Material preset"
                  value={simulationMaterialPresets.findIndex((p) => p.name === material?.name)}
                  onChange={(e) => choosePreset(Number(e.target.value))}
                >
                  {material && !simulationMaterialPresets.some((p) => p.name === material.name) && (
                    <option value={-1}>{material.name}</option>
                  )}
                  {!material && <option value={-1}>Choose a material</option>}
                  {simulationMaterialPresets.map((p, i) => (
                    <option key={p.name} value={i}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {material && (
                <>
                  {field(
                    "Young's modulus",
                    'MPa',
                    <NumberInput
                      label="Young's modulus (MPa)"
                      value={material.youngsModulus}
                      min={0}
                      max={L.modulusMPa}
                      step={1000}
                      disabled={readOnly}
                      commit={(v) => setMaterial({ ...material, youngsModulus: v })}
                    />,
                  )}
                  {field(
                    "Poisson's ratio",
                    '',
                    <NumberInput
                      label="Poisson's ratio"
                      value={material.poissonsRatio}
                      min={0}
                      max={0.5}
                      step={0.01}
                      disabled={readOnly}
                      commit={(v) => setMaterial({ ...material, poissonsRatio: v })}
                    />,
                  )}
                  {field(
                    'Density',
                    't/mm³',
                    <NumberInput
                      label="Density (t/mm³)"
                      value={material.density}
                      min={0}
                      max={L.densityMax}
                      step={1e-10}
                      disabled={readOnly}
                      commit={(v) => setMaterial({ ...material, density: v })}
                    />,
                  )}
                  {field(
                    'Conductivity',
                    'W/(m·K), for a thermal study',
                    <NumberInput
                      label="Thermal conductivity (W/(m·K))"
                      value={material.conductivity ?? 0}
                      min={0}
                      max={L.conductivity}
                      step={1}
                      disabled={readOnly}
                      commit={(v) => setMaterial({ ...material, conductivity: v })}
                    />,
                  )}
                </>
              )}
            </fieldset>
            <fieldset className="simulation-group" disabled={readOnly}>
              <legend>Preparation</legend>
              {(
                [
                  ['removeHolesBelow', 'Remove holes below', 'Hole diameter (mm)', 3],
                  ['removeFilletsBelow', 'Remove fillets below', 'Fillet radius (mm)', 1],
                ] as const
              ).map(([key, label, valueLabel, initial]) => (
                <div key={key} className="simulation-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={doc.preparation[key] !== null}
                      disabled={readOnly}
                      onChange={(e) =>
                        setPreparation({ [key]: e.currentTarget.checked ? initial : null })
                      }
                    />{' '}
                    {label} <small>mm</small>
                  </label>
                  {doc.preparation[key] !== null && (
                    <NumberInput
                      label={valueLabel}
                      value={doc.preparation[key]}
                      min={0}
                      max={L.lengthMm}
                      step={0.5}
                      disabled={readOnly}
                      commit={(v) => setPreparation({ [key]: v })}
                    />
                  )}
                </div>
              ))}
              <p className="simulation-note">
                Applied to the analysed shape before meshing; the CAD part is not changed. A load or
                constraint on a removed face stops the run with the reason.
              </p>
            </fieldset>
            <fieldset className="simulation-group" disabled={readOnly}>
              <legend>Mesh (tet10)</legend>
              {field(
                'Element size',
                'mm',
                <NumberInput
                  label="Element size (mm)"
                  value={doc.mesh.size}
                  min={0}
                  max={L.lengthMm}
                  step={0.5}
                  disabled={readOnly}
                  commit={(size) => setMesh({ size })}
                />,
              )}
              {field(
                'Smallest size',
                'mm',
                <NumberInput
                  label="Smallest element size (mm)"
                  value={doc.mesh.minSize}
                  min={0}
                  max={L.lengthMm}
                  step={0.1}
                  disabled={readOnly}
                  commit={(minSize) => setMesh({ minSize })}
                />,
              )}
              <p className="simulation-note" aria-label="Smallest size note">
                The smallest size also sets how finely the shape is tessellated before meshing (a
                chord within a fiftieth of it): a small one adds many nodes on curved faces, even
                where the element size is large.
              </p>
              {field(
                'Growth',
                '× per element',
                <NumberInput
                  label="Size growth between elements"
                  value={doc.mesh.grading}
                  min={1}
                  max={3}
                  step={0.1}
                  disabled={readOnly}
                  commit={(grading) => setMesh({ grading })}
                />,
              )}
              <div className="simulation-actions">
                <button type="button" disabled={!selected.length} onClick={addLocalSizes}>
                  Finer size on selected faces
                </button>
              </div>
              {doc.mesh.local.length > 0 && (
                <ul className="simulation-items" aria-label="Finer mesh sizes">
                  {doc.mesh.local.map((l, i) => {
                    const faces = localResolved[i];
                    return (
                      <li key={JSON.stringify(l.target)}>
                        <span>
                          {l.target.kind === 'face' ? 'Face' : 'Edge'}
                          {faces?.faces.length
                            ? ` ${faces.faces.map((f) => f + 1).join(', ')}`
                            : ''}
                          {faces?.unresolved ? ' (not on the shown shape)' : ''}
                        </span>
                        <NumberInput
                          label={`Finer size ${i + 1} (mm)`}
                          value={l.size}
                          min={0}
                          max={L.lengthMm}
                          step={0.1}
                          disabled={readOnly}
                          commit={(size) => run(setLocalSizeOp(doc, i, size))}
                        />
                        <button
                          type="button"
                          disabled={readOnly}
                          onClick={() => run(setLocalSizeOp(doc, i, undefined))}
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="simulation-note">
                The browser solves up to {L.browserNodes.toLocaleString('en')} nodes and{' '}
                {L.browserElements.toLocaleString('en')} elements; a finer mesh is refused before it
                is solved.
              </p>
            </fieldset>
            {/* Not disabled as a whole: choosing the shown study is open to a reader; every edit in
                it is disabled on its own. */}
            <fieldset className="simulation-group">
              <legend>Study</legend>
              {doc.studies.length > 1 && (
                <label className="simulation-field">
                  <span>Study</span>
                  <select
                    aria-label="Study"
                    value={study?.id}
                    onChange={(e) => setStudyChoice(e.currentTarget.value)}
                  >
                    {doc.studies.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {study ? (
                <>
                  <p>
                    <strong>{study.name}</strong>{' '}
                    {study.kind === 'thermal' ? (
                      <>
                        (steady heat conduction): {study.constraintIds.length} temperature
                        {study.constraintIds.length === 1 ? '' : 's'}, {study.loadIds.length} heat
                        flux or convection condition{study.loadIds.length === 1 ? '' : 's'}.
                      </>
                    ) : study.kind === 'modal' ? (
                      <>
                        (modal): the {study.modes} lowest natural frequencies with{' '}
                        {study.constraintIds.length} constraint
                        {study.constraintIds.length === 1 ? '' : 's'}; loads do not enter it.
                      </>
                    ) : (
                      <>
                        (linear static): {study.loadIds.length} load
                        {study.loadIds.length === 1 ? '' : 's'}, {study.constraintIds.length}{' '}
                        constraint
                        {study.constraintIds.length === 1 ? '' : 's'}.
                      </>
                    )}
                  </p>
                  {study.kind !== 'thermal' && (
                    <>
                      <label className="simulation-field">
                        <span>
                          Idealisation <small>of the part</small>
                        </span>
                        <select
                          aria-label="Idealisation"
                          value={study.idealisation ?? 'solid'}
                          disabled={readOnly}
                          onChange={(e) => {
                            const value = e.currentTarget.value as 'solid' | 'shell';
                            const { idealisation: _idealisation, ...rest } = study;
                            run({
                              type: 'updateStudy',
                              study: value === 'shell' ? { ...rest, idealisation: 'shell' } : rest,
                            });
                          }}
                        >
                          <option value="solid">Solid (tetrahedra)</option>
                          <option value="shell">Shell on the midsurface</option>
                        </select>
                      </label>
                      {study.idealisation === 'shell' && (
                        <p className="simulation-note">
                          A shell is solved on the midsurface the CAD history gives a wall of one
                          thickness (a shell, a thickened sheet or a thin extrude), in the browser.
                          Pick loads and constraints on the part as usual: a load or a constraint on
                          either side of the wall acts on the midsurface face, a constraint on a rim
                          face on its edge. A pinned support holds a shell's translations and leaves
                          its rotations free.
                        </p>
                      )}
                    </>
                  )}
                  {study.kind === 'modal' &&
                    field(
                      'Modes',
                      'lowest',
                      <NumberInput
                        label="Number of modes"
                        value={study.modes}
                        min={1}
                        max={L.modes}
                        step={1}
                        disabled={readOnly}
                        commit={(modes) => run({ type: 'updateStudy', study: { ...study, modes } })}
                      />,
                    )}
                  {field(
                    'Mesh levels',
                    'for convergence',
                    <NumberInput
                      label="Convergence mesh levels"
                      value={study.convergence.levels}
                      min={1}
                      max={L.convergenceLevels}
                      step={1}
                      disabled={readOnly}
                      commit={(levels) =>
                        run({
                          type: 'updateStudy',
                          study: { ...study, convergence: { ...study.convergence, levels } },
                        })
                      }
                    />,
                  )}
                  {field(
                    'Solver iterations',
                    'at most',
                    <NumberInput
                      label="Solver iteration limit"
                      value={study.solver.maxIterations}
                      min={1}
                      max={L.maxIterations}
                      step={1000}
                      disabled={readOnly}
                      commit={(maxIterations) =>
                        run({
                          type: 'updateStudy',
                          study: { ...study, solver: { ...study.solver, maxIterations } },
                        })
                      }
                    />,
                  )}
                </>
              ) : (
                <p className="simulation-note">
                  A study is made once there is a load and a constraint; a thermal study once there
                  is a temperature or a convection.
                </p>
              )}
              <div className="simulation-actions">
                <button
                  type="button"
                  disabled={readOnly || !doc.constraints.some((c) => !isThermalKind(c.kind))}
                  onClick={() => addStudy(defaultModalStudy(doc))}
                >
                  Add modal study
                </button>
                <button
                  type="button"
                  disabled={readOnly || !thermalStudyReady(doc)}
                  onClick={() => addStudy(defaultThermalStudy(doc))}
                >
                  Add thermal study
                </button>
                {study && doc.studies.length > 1 && (
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => run({ type: 'removeStudy', id: study.id })}
                  >
                    Remove study
                  </button>
                )}
              </div>
              {study?.kind === 'modal' && (
                <p className="simulation-note">
                  The browser solves a modal study up to {L.browserModalNodes.toLocaleString('en')}{' '}
                  nodes and {L.browserModalElements.toLocaleString('en')} elements.
                </p>
              )}
            </fieldset>
            {runner && (
              <RunPanel
                study={study}
                state={shownState}
                test={
                  // Only for the document the run solved: an edit since (its force, say) would
                  // mix the new input with the old result (Codex on #982).
                  lastRun && !lastRun.run.failure && lastRun.hash === hash
                    ? stiffnessTestResult(doc, lastRun.run)
                    : undefined
                }
                stale={!!lastRun && lastRun.hash !== hash}
                readOnly={readOnly}
                unavailable={runner.unavailable}
                start={() => startRun()}
                host={runner.host}
                startOnHost={
                  // R3j-5a/5b: shells and bonded bodies too; R3j-5c: modal studies too.
                  runner.host && study && study.kind !== 'thermal'
                    ? () => startRun(true)
                    : undefined
                }
              />
            )}
            <RecordPanel
              doc={doc}
              studyId={study?.id}
              run={lastRun?.run}
              runCurrent={!!lastRun && lastRun.hash === hash}
              readOnly={readOnly}
              builds={[runner?.builds, runner?.host?.builds]}
              apply={run}
            />
            {lastRun && lastRun.hash === hash && lastRun.run.failure?.code === 'mapping' && (
              <MappingIssues
                doc={doc}
                rows={lastRun.run.mapping}
                kernelBuild={lastRun.run.builds.kernel}
                readOnly={readOnly}
                run={run}
              />
            )}
            <ResultPanel
              source={result}
              display={display}
              showing={resultShown}
              setShowing={setShowing}
              readout={readout}
              exportVtu={
                !imported && lastRun?.run.fields
                  ? () => {
                      // R3j-6c: a VTU holds one kind of element: one file per body of a bonded run.
                      if (!solvedBodies) return downloadVtu(lastRun.run);
                      for (const b of solvedBodies)
                        if (shownBody === undefined || b.bodyId === shownBody)
                          downloadVtu(lastRun.run, b.bodyId);
                    }
                  : undefined
              }
              body={
                !imported && solvedBodies
                  ? {
                      value: shownBody,
                      options: solvedBodies.map((b) => ({
                        id: b.bodyId,
                        label: `${bodyName(b.bodyId)} (${solvedLabel(b)})`,
                      })),
                      choose: (id) => {
                        setResultBody(id);
                        setPoint(undefined);
                      },
                    }
                  : undefined
              }
              openVtu={openVtu}
              closeImported={
                imported
                  ? () => {
                      setImported(undefined);
                      setPoint(undefined);
                      setShowing(!!runSource);
                    }
                  : undefined
              }
              error={resultError}
            />
            {error && (
              <p className="simulation-error" role="alert">
                Not applied: {error}
              </p>
            )}
          </div>
        </div>
      </section>
    </InputBoundary.Provider>
  );
}

const idealisationLabels = { solid: 'Solid', shell: 'Shell' } as const;
/** CR5e: the thickness a sheet starts at (mm), a car body panel's. */
const sheetThicknessDefaultMm = 1;

type SolvedBody = NonNullable<ReturnType<typeof bondedBodies>>[number];
/** R3j-6c: how a body was solved: "solid", or "shell, 1.2 mm" (a range when it varies). */
const solvedLabel = (b: SolvedBody) =>
  b.kind === 'solid'
    ? 'solid'
    : `shell, ${
        Math.abs(b.thickness[1] - b.thickness[0]) < 1e-9
          ? fmtMm(b.thickness[0])
          : `${fmtMm(b.thickness[0])}–${fmtMm(b.thickness[1])}`
      } mm`;

/**
 * R3j-6a (docs/cad/r3-analysis.md, A4-U1): the version's bodies. The source body is always
 * analysed; each other body is analysed with it once ticked, with its own material and,
 * optionally, its own idealisation (else the study's). Bodies analysed together are joined only
 * by the bonds taken (A4-U2).
 */
function BodiesPanel({
  doc,
  sourceName,
  sourceSheet,
  others,
  study,
  readOnly,
  run,
  refuse,
  solved,
}: {
  doc: SimulationDocument;
  sourceName: string;
  /** CR5e: the source body is a sheet. */
  sourceSheet: boolean;
  others: readonly SimulationOtherBody[];
  study: SimulationStudy | undefined;
  readOnly: boolean;
  run(op: SimulationOperation | SimulationOperation[]): string | undefined;
  /** Shows why an action is not applied. */
  refuse(reason: string): void;
  /** R3j-6c: how each body was solved in the current run (a shell's thickness). */
  solved?: readonly SolvedBody[];
}) {
  const solvedAs = (bodyId: string) => {
    const b = solved?.find((x) => x.bodyId === bodyId);
    return b ? `; solved as ${solvedLabel(b)}` : '';
  };
  const studyIdealisation =
    study && study.kind !== 'thermal' ? (study.idealisation ?? 'solid') : 'solid';
  const materialName = (id: string | null) =>
    doc.materials.find((m) => m.id === id)?.name ?? 'no material';
  /** Chooses a material (an existing one, or a preset added in the same edit) for a body. */
  const chooseMaterial = (bodyId: string, value: string) => {
    if (value.startsWith('preset:')) {
      const preset = simulationMaterialPresets[Number(value.slice(7))]!;
      const id = freshSimulationId(doc, 'material');
      return run([
        { type: 'addMaterial', material: { id, ...preset } },
        { type: 'setBodyMaterial', materialId: id, bodyId },
      ]);
    }
    return run({ type: 'setBodyMaterial', materialId: value || null, bodyId });
  };
  const presets = simulationMaterialPresets
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !doc.materials.some((m) => m.name === p.name));
  /** CR5e: a sheet's thickness, entered in mm; a sheet without one is not run. */
  const thickness = (bodyId: string, name: string) => {
    const t = doc.sheets?.find((x) => x.bodyId === bodyId)?.thicknessMm;
    return (
      <>
        {field(
          'Thickness',
          t === undefined ? 'mm; the sheet needs one to be analysed' : 'mm, the sheet as a shell',
          <NumberInput
            label={`${name} thickness (mm)`}
            value={t ?? sheetThicknessDefaultMm}
            min={0}
            max={simulationLimits.sheetThicknessMm}
            step={0.1}
            disabled={readOnly}
            commit={(v) => {
              if (!(v > 0 && v <= simulationLimits.sheetThicknessMm))
                return `Enter a thickness above 0 and at most ${simulationLimits.sheetThicknessMm} mm.`;
              return run({ type: 'setSheetThickness', bodyId, thicknessMm: v });
            }}
          />,
        )}
        {t === undefined && !readOnly && (
          <div className="simulation-actions">
            <button
              type="button"
              onClick={() =>
                run({ type: 'setSheetThickness', bodyId, thicknessMm: sheetThicknessDefaultMm })
              }
            >
              Use {sheetThicknessDefaultMm} mm
            </button>
          </div>
        )}
      </>
    );
  };
  return (
    <fieldset className="simulation-group" disabled={readOnly}>
      <legend>Bodies</legend>
      <ul className="simulation-items" aria-label="Bodies">
        <li className="simulation-item" aria-label={sourceName}>
          <div className="simulation-item-head">
            <strong>{sourceName}</strong> <small>source</small>{' '}
            <span className="simulation-note">
              {sourceSheet
                ? 'Sheet, a shell on itself'
                : `${idealisationLabels[studyIdealisation]} (the study’s)`}
              , {materialName(doc.materialId)}
              {solvedAs(doc.source.bodyId)}
            </span>
          </div>
          {sourceSheet && thickness(doc.source.bodyId, sourceName)}
        </li>
        {[
          ...others,
          // An analysed body this version no longer has as an active solid (another version was
          // switched to): listed so it can be unticked, as a run refuses it.
          ...(doc.bodies ?? [])
            .filter((b) => !others.some((o) => o.bodyId === b.bodyId))
            .map((b) => ({ bodyId: b.bodyId, name: b.bodyId, missing: true as const })),
        ].map((o) => {
          const body = doc.bodies?.find((b) => b.bodyId === o.bodyId);
          const missing = 'missing' in o;
          return (
            <li key={o.bodyId} className="simulation-item" aria-label={o.name}>
              <div className="simulation-item-head">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Analyse ${o.name}`}
                    checked={!!body}
                    onChange={(e) => {
                      if (e.currentTarget.checked)
                        return run([
                          {
                            type: 'addBody',
                            body: { bodyId: o.bodyId, materialId: doc.materialId },
                          },
                          // CR5e: a sheet starts at the default thickness, edited below.
                          ...('sheet' in o && o.sheet
                            ? [
                                {
                                  type: 'setSheetThickness' as const,
                                  bodyId: o.bodyId,
                                  thicknessMm: sheetThicknessDefaultMm,
                                },
                              ]
                            : []),
                        ]);
                      // Said in the user's words before the edit refuses it (`body-in-use`).
                      if (simulationTargets(doc).some(({ target }) => target.body === o.bodyId))
                        return refuse(
                          `a load, constraint, bond or setting is on ${o.name}: remove it first.`,
                        );
                      return run({ type: 'removeBody', bodyId: o.bodyId });
                    }}
                  />{' '}
                  <strong>{o.name}</strong>
                </label>{' '}
                {missing ? (
                  <small>(not an active solid of this version: untick it to run)</small>
                ) : (
                  !o.mesh && <small>(not shown by the evaluation)</small>
                )}
                {body && !missing && solvedAs(o.bodyId) && (
                  <span className="simulation-note">{solvedAs(o.bodyId).slice(2)}</span>
                )}
              </div>
              {body && !missing && 'sheet' in o && o.sheet && thickness(o.bodyId, o.name)}
              {body && !missing && (
                <>
                  {!('sheet' in o && o.sheet) && (
                    <label className="simulation-field">
                      <span>Idealisation</span>
                      <select
                        aria-label={`${o.name} idealisation`}
                        value={body.idealisation ?? ''}
                        onChange={(e) => {
                          const v = e.currentTarget.value;
                          run({
                            type: 'setBodyIdealisation',
                            bodyId: o.bodyId,
                            idealisation: v === 'solid' || v === 'shell' ? v : null,
                          });
                        }}
                      >
                        <option value="">
                          As the study ({idealisationLabels[studyIdealisation].toLowerCase()})
                        </option>
                        <option value="solid">Solid (tetrahedra)</option>
                        <option value="shell">Shell on the midsurface</option>
                      </select>
                    </label>
                  )}
                  <label className="simulation-field">
                    <span>Material</span>
                    <select
                      aria-label={`${o.name} material`}
                      value={body.materialId ?? ''}
                      onChange={(e) => chooseMaterial(o.bodyId, e.currentTarget.value)}
                    >
                      {!body.materialId && <option value="">Choose a material</option>}
                      {doc.materials.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                      {presets.map(({ p, i }) => (
                        <option key={p.name} value={`preset:${i}`}>
                          {p.name} (preset)
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <p className="simulation-note">
        Ticked bodies are solved with the source body, joined only where a bond is taken. A shell
        takes its thickness from the CAD history (a shell, a thickened sheet or a thin extrude).
      </p>
    </fieldset>
  );
}

/** The candidate search tolerance the panel starts with (mm). */
const bondToleranceDefault = 0.5;

/**
 * R3j-6b (docs/cad/r3-analysis.md, A4-U2): where the analysed bodies touch, offered as bonds; only
 * the candidates the user takes are solved. The candidates are found on the display meshes of the
 * bodies as analysed now (a shell's face may not follow a solid's wall), and are dropped when the
 * bodies or their idealisations change. Each bond taken is listed with its tolerance.
 */
function BondsPanel({
  doc,
  bodies,
  study,
  readOnly,
  run,
  preview,
  measure,
}: {
  doc: SimulationDocument;
  bodies: ReadonlyMap<
    string,
    SimulationPickBody & { mesh: CadMesh; name: string; sheet?: boolean }
  >;
  /** CR4a: the kernel's exact distances; without it candidates are found on the triangles. */
  measure?: BondDistanceMeasure;
  study: SimulationStudy | undefined;
  readOnly: boolean;
  run(op: SimulationOperation | SimulationOperation[]): string | undefined;
  /** Shows faces in the view (undefined: none). */
  preview(faces: SimulationBodyFace[] | undefined): void;
}) {
  const [tolerance, setTolerance] = useState(bondToleranceDefault);
  const studyShell = !!study && study.kind !== 'thermal' && study.idealisation === 'shell';
  const shellOf = (bodyId: string) => {
    // CR5e (Codex on #977): a sheet is a shell whatever the study says, as the run solves it.
    if (bodies.get(bodyId)?.sheet) return true;
    if (bodyId === doc.source.bodyId) return studyShell;
    const i = doc.bodies?.find((b) => b.bodyId === bodyId)?.idealisation;
    return i ? i === 'shell' : studyShell;
  };
  // What the candidates were found for: the CAD version's geometry, the bodies' meshes, how each
  // is solved and the tolerance.
  const key = JSON.stringify([
    doc.source.contentHash,
    [...bodies].map(([id, b]) => [id, b.mesh.topology.faces.length, shellOf(id)]),
    tolerance,
  ]);
  const [found, setFound] = useState<{ key: string; result: BondCandidateResult }>();
  const result = found?.key === key ? found.result : undefined;
  const [looking, setLooking] = useState<string>();
  const look = (id: string, faces: SimulationBodyFace[]) => {
    const again = looking === id;
    setLooking(again ? undefined : id);
    preview(again ? undefined : faces);
  };
  useEffect(() => () => preview(undefined), []);
  // A candidate looked at belongs to the search it came from: another search key drops it.
  useEffect(() => {
    setLooking(undefined);
    preview(undefined);
  }, [key]);
  const [finding, setFinding] = useState<{ key: string; error?: string }>();
  /** The search running now: an earlier one's answer is dropped. */
  const searching = useRef<object | undefined>(undefined);
  const find = () => {
    const input = [...bodies].map(([bodyId, b]) => ({
      bodyId,
      mesh: b.mesh,
      shell: shellOf(bodyId),
    }));
    setLooking(undefined);
    preview(undefined);
    if (!measure) {
      setFound({ key, result: bondCandidates(input, tolerance) });
      return;
    }
    // CR4a: measured by the kernel on the exact surfaces.
    const mine = {};
    searching.current = mine;
    setFinding({ key });
    exactBondCandidates(input, tolerance, measure).then(
      (result) => {
        if (searching.current !== mine) return;
        setFinding(undefined);
        setFound({ key, result });
      },
      (e: unknown) => {
        if (searching.current !== mine) return;
        setFinding({ key, error: e instanceof Error ? e.message : String(e) });
      },
    );
  };
  const name = (id: string) => bodies.get(id)?.name ?? id;
  const bondFaces = (b: SimulationBond) =>
    targetFacesByBody(doc.source.bodyId, bodies, [...b.follower, ...b.on]).faces;
  /**
   * Whether a bond already ties these follower faces: by the faces its references resolve to, not
   * their stored form (a reference kept across a version switch has an older geometric hint).
   */
  const takenKeys = new Set(
    (doc.bonds ?? []).map((b) =>
      takenBondKey(
        targetFacesByBody(doc.source.bodyId, bodies, b.follower).faces,
        b.contact ? targetFacesByBody(doc.source.bodyId, bodies, b.on).faces : undefined,
      ),
    ),
  );
  const fmt = (x: number) => String(Number(x.toPrecision(3)));
  return (
    <fieldset className="simulation-group" disabled={readOnly}>
      <legend>Bonds</legend>
      {field(
        'Tolerance',
        'mm, the largest gap a candidate may have',
        <NumberInput
          label="Bond search tolerance (mm)"
          value={tolerance}
          min={0}
          max={simulationLimits.lengthMm}
          step={0.1}
          disabled={readOnly}
          commit={(v) => {
            if (!(v > 0)) return 'Enter a tolerance above 0.';
            setTolerance(v);
            return undefined;
          }}
        />,
      )}
      <div className="simulation-actions">
        <button
          type="button"
          onClick={find}
          disabled={bodies.size < 2 || (finding?.key === key && !finding.error)}
        >
          Find bond candidates
        </button>
      </div>
      {finding?.key === key && (
        <p
          className="simulation-note"
          aria-live="polite"
          role={finding.error ? 'alert' : undefined}
        >
          {finding.error
            ? `The candidates could not be measured: ${finding.error}`
            : 'Measuring the touching faces on the exact surfaces…'}
        </p>
      )}
      {bodies.size < 2 && (
        <p className="simulation-note">
          Candidates need two bodies in the analysis that this version has.
        </p>
      )}
      {bodies.size >= 2 && (
        // CR5d (86A2): what a body is solved as decides what it is offered, so say it before.
        <p className="simulation-note" aria-label="Bodies as measured">
          Found for the bodies as they are solved now:{' '}
          {[...bodies.keys()]
            .map((id) => `${name(id)} ${shellOf(id) ? 'shell' : 'solid'}`)
            .join(', ')}
          . A shell’s rim is offered on a solid’s faces, but a solid’s face never follows a shell:
          set each body’s idealisation (the source body’s is the study’s) before finding.
        </p>
      )}
      {result && (
        <>
          <p className="simulation-note" aria-live="polite">
            {result.candidates.length
              ? `${result.candidates.length} candidate${result.candidates.length === 1 ? '' : 's'} within ${fmt(tolerance)} mm`
              : `No bodies touch within ${fmt(tolerance)} mm`}
            {measure ? ', measured on the exact surfaces.' : ', measured on the display triangles.'}
          </p>
          <ul className="simulation-items" aria-label="Bond candidates">
            {result.candidates.map((c) => {
              // The follower and the faces it follows: the same faces may follow two bodies.
              const id = `${c.follower.bodyId}:${c.follower.faces.join(',')}>${c.on.bodyId}:${c.on.faces.join(',')}`;
              // A face its body's names cannot reference is offered with the reason, not taken.
              let bond: SimulationBond | undefined;
              let unreferenced = '';
              try {
                bond = candidateBond(doc, c, bodies, tolerance);
              } catch (e) {
                unreferenced = e instanceof Error ? e.message : String(e);
              }
              const label = bond?.name ?? `${name(c.follower.bodyId)} to ${name(c.on.bodyId)}`;
              const done = takenKeys.has(
                takenBondKey(
                  c.follower.faces.map((face) => ({ bodyId: c.follower.bodyId, face })),
                  c.contact ? c.on.faces.map((face) => ({ bodyId: c.on.bodyId, face })) : undefined,
                ),
              );
              const faces = [
                ...c.follower.faces.map((face) => ({ bodyId: c.follower.bodyId, face })),
                ...c.on.faces.map((face) => ({ bodyId: c.on.bodyId, face })),
              ];
              return (
                <li key={id} className="simulation-item" aria-label={label}>
                  <div className="simulation-item-head">
                    <strong>{label}</strong>{' '}
                    <span className="simulation-note">
                      {c.follower.faces.length} face{c.follower.faces.length === 1 ? '' : 's'} of{' '}
                      {name(c.follower.bodyId)} follow {c.on.faces.length} of {name(c.on.bodyId)};
                      gap {Number(c.gap.toFixed(3))} mm, {fmt(c.area)} mm²
                      {c.contact ? ' (contact: only the nodes lying on it follow)' : ''}
                      {done ? ' (taken)' : ''}
                      {unreferenced ? ` (cannot be taken: ${unreferenced})` : ''}
                    </span>
                  </div>
                  <div className="simulation-actions">
                    <button
                      type="button"
                      aria-pressed={looking === id}
                      onClick={() => look(id, faces)}
                    >
                      Show
                    </button>
                    <button
                      type="button"
                      disabled={done || !bond}
                      onClick={() => {
                        if (bond && !run({ type: 'addBond', bond })) {
                          setLooking(undefined);
                          preview(undefined);
                        }
                      }}
                    >
                      Take
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {result.notOffered.length > 0 && (
            <ul className="simulation-note" aria-label="Touching faces not offered">
              {result.notOffered.map((n) => (
                <li key={`${n.bodyId}:${n.face}:${n.onBodyId}`}>
                  Face {n.face + 1} of {name(n.bodyId)} on {name(n.onBodyId)}: {n.reason}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {!!doc.bonds?.length && (
        <ul className="simulation-items" aria-label="Bonds taken">
          {doc.bonds.map((b) => (
            <li key={b.id} className="simulation-item" aria-label={b.name}>
              <div className="simulation-item-head">
                <strong>{b.name}</strong>{' '}
                <span className="simulation-note">
                  {b.follower.length} face{b.follower.length === 1 ? '' : 's'} follow {b.on.length}
                  {b.contact ? ' (contact)' : ''}
                </span>
              </div>
              {field(
                'Tolerance',
                'mm',
                <NumberInput
                  label={`${b.name} tolerance (mm)`}
                  value={b.tolerance}
                  min={0}
                  max={simulationLimits.lengthMm}
                  step={0.1}
                  disabled={readOnly}
                  commit={(t) => run({ type: 'updateBond', bond: { ...b, tolerance: t } })}
                />,
              )}
              <div className="simulation-actions">
                <button
                  type="button"
                  aria-pressed={looking === b.id}
                  onClick={() => look(b.id, bondFaces(b))}
                >
                  Show
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!run({ type: 'removeBond', id: b.id }) && looking === b.id) {
                        setLooking(undefined);
                        preview(undefined);
                      }
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="simulation-note">
        Bodies are joined only by the bonds taken: each follower face follows the faces under it. A
        solid face does not follow a shell; bond the shell’s rim instead.
      </p>
    </fieldset>
  );
}

/**
 * CR5b (docs/cad/car-design.md, CR5の分け方): the CAD version's spot weld rows, offered as welds
 * as bond candidates are; only the rows taken tie the flanges. A weld whose row the version no
 * longer has stays listed as missing (its run is refused until it is removed).
 */
function SpotWeldsPanel({
  doc,
  rows,
  bodies,
  readOnly,
  run,
  preview,
}: {
  doc: SimulationDocument;
  rows: readonly SimulationWeldRow[];
  bodies: ReadonlyMap<string, SimulationPickBody & { name: string }>;
  readOnly: boolean;
  run(op: SimulationOperation | SimulationOperation[]): string | undefined;
  preview(faces: SimulationBodyFace[] | undefined): void;
}) {
  const [looking, setLooking] = useState<string>();
  const look = (id: string, faces: SimulationBodyFace[]) => {
    const again = looking === id;
    setLooking(again ? undefined : id);
    preview(again ? undefined : faces);
  };
  useEffect(() => () => preview(undefined), []);
  const name = (id: string) => bodies.get(id)?.name ?? id;
  const taken = new Set((doc.spotWelds ?? []).map((w) => w.weldId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const weldFaces = (w: SimulationSpotWeld) =>
    targetFacesByBody(doc.source.bodyId, bodies, [...w.follower, ...w.on]).faces;
  const stop = (id: string) => {
    if (looking === id) {
      setLooking(undefined);
      preview(undefined);
    }
  };
  return (
    <fieldset className="simulation-group" disabled={readOnly}>
      <legend>Spot welds</legend>
      {rows.length > 0 && (
        <ul className="simulation-items" aria-label="Spot weld rows">
          {rows.map((r) => {
            let weld: SimulationSpotWeld | undefined;
            let why = r.error ? `the row did not evaluate: ${r.error}` : '';
            if (!why)
              try {
                weld = spotWeldOf(doc, r, bodies);
              } catch (e) {
                why = e instanceof Error ? e.message : String(e);
              }
            const done = taken.has(r.id);
            return (
              <li key={r.id} className="simulation-item" aria-label={r.name}>
                <div className="simulation-item-head">
                  <strong>{r.name}</strong>{' '}
                  <span className="simulation-note">
                    {r.points ?? 0} point{r.points === 1 ? '' : 's'} from{' '}
                    {name(r.flanges[0].bodyId)} to {name(r.flanges[1].bodyId)}
                    {done ? ' (taken)' : ''}
                    {why ? ` (cannot be taken: ${why})` : ''}
                  </span>
                </div>
                <div className="simulation-actions">
                  {weld && (
                    <button
                      type="button"
                      aria-pressed={looking === `row:${r.id}`}
                      onClick={() => look(`row:${r.id}`, weldFaces(weld!))}
                    >
                      Show
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={done || !weld}
                    onClick={() => {
                      if (weld && !run({ type: 'addSpotWeld', weld })) stop(`row:${r.id}`);
                    }}
                  >
                    Take
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!!doc.spotWelds?.length && (
        <ul className="simulation-items" aria-label="Spot welds taken">
          {doc.spotWelds.map((w) => {
            const row = byId.get(w.weldId);
            return (
              <li key={w.id} className="simulation-item" aria-label={w.name}>
                <div className="simulation-item-head">
                  <strong>{w.name}</strong>{' '}
                  <span className="simulation-note">
                    {row
                      ? `${row.points ?? 0} point${row.points === 1 ? '' : 's'}`
                      : 'Missing: the version has no such row; remove it to run'}
                  </span>
                </div>
                {field(
                  'Radius',
                  'mm, nodes this near a point are tied',
                  <NumberInput
                    label={`${w.name} radius (mm)`}
                    value={w.radiusMm}
                    min={0}
                    max={simulationLimits.weldRadiusMm}
                    step={0.5}
                    disabled={readOnly}
                    commit={(v) => {
                      if (!(v > 0)) return 'Enter a radius above 0.';
                      return run({ type: 'updateSpotWeld', weld: { ...w, radiusMm: v } });
                    }}
                  />,
                )}
                {field(
                  'Tolerance',
                  'mm',
                  <NumberInput
                    label={`${w.name} tolerance (mm)`}
                    value={w.tolerance}
                    min={0}
                    max={simulationLimits.lengthMm}
                    step={0.1}
                    disabled={readOnly}
                    commit={(t) => run({ type: 'updateSpotWeld', weld: { ...w, tolerance: t } })}
                  />,
                )}
                <div className="simulation-actions">
                  <button
                    type="button"
                    aria-pressed={looking === w.id}
                    onClick={() => look(w.id, weldFaces(w))}
                  >
                    Show
                  </button>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!run({ type: 'removeSpotWeld', id: w.id })) stop(w.id);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="simulation-note">
        Each weld ties the first flange&rsquo;s nodes within its radius of a point (or, on a coarser
        mesh, the nearest element&rsquo;s) to the second flange; the welded faces are meshed at 10
        mm or finer.
      </p>
    </fieldset>
  );
}

const vecLabels = ['X', 'Y', 'Z'] as const;

/** CR5a: an added mass, edited in kilograms. */
function MassItem({
  item,
  faces,
  readOnly,
  selected,
  run,
  retarget,
}: {
  item: SimulationMass;
  faces: { unresolved: number } | undefined;
  readOnly: boolean;
  selected: number;
  run(op: SimulationOperation): string | undefined;
  retarget(): void;
}) {
  const count = item.targets.length;
  const maxKg = simulationLimits.massT * 1000;
  return (
    <li className="simulation-item" aria-label={item.name}>
      <div className="simulation-item-head">
        <strong>{item.name}</strong> <small>mass</small>{' '}
        <span className="simulation-note">
          {`${count} face${count === 1 ? '' : 's'}, every study`}
          {faces?.unresolved ? ` (${faces.unresolved} not found on the shown shape)` : ''}
        </span>
      </div>
      <label className="simulation-field">
        <span>
          Mass <small>kg</small>
        </span>
        <NumberInput
          label={`${item.name} mass (kg)`}
          value={+(item.mass * 1000).toPrecision(12)}
          min={0.001}
          max={maxKg}
          step={10}
          disabled={readOnly}
          commit={(v) => {
            if (!(v > 0) || v > maxKg)
              return `Enter a mass above 0 kg, at most ${maxKg.toLocaleString('en')} kg.`;
            return run({ type: 'updateMass', mass: { ...item, mass: v / 1000 } });
          }}
        />
      </label>
      {!readOnly && (
        <div className="simulation-actions">
          <button type="button" disabled={!selected} onClick={retarget}>
            Use selected faces
          </button>
          <button type="button" onClick={() => run({ type: 'removeMass', id: item.id })}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

function ConditionItem({
  item,
  collection,
  faces,
  readOnly,
  selected,
  run,
  retarget,
  remove,
}: {
  item: SimulationLoad | SimulationConstraint;
  collection: 'loads' | 'constraints';
  faces: { unresolved: number } | undefined;
  readOnly: boolean;
  /** Faces selected now. */
  selected: number;
  run(op: SimulationOperation): string | undefined;
  retarget(): void;
  remove(collection: 'loads' | 'constraints'): void;
}) {
  const count = 'targets' in item ? item.targets.length : 0;
  const L = simulationLimits;
  return (
    <li className="simulation-item" aria-label={item.name}>
      <div className="simulation-item-head">
        <strong>{item.name}</strong> <small>{item.kind}</small>{' '}
        <span className="simulation-note">
          {item.kind === 'gravity'
            ? 'every body, static studies'
            : `${count} face${count === 1 ? '' : 's'}`}
          {faces?.unresolved ? ` (${faces.unresolved} not found on the shown shape)` : ''}
        </span>
      </div>
      {item.kind === 'gravity' && (
        <div className="simulation-vector">
          {vecLabels.map((axis, k) => (
            <label key={axis}>
              <span>
                g{axis.toLowerCase()} <small>mm/s²</small>
              </span>
              <NumberInput
                label={`${item.name} g${axis.toLowerCase()} (mm/s²)`}
                value={item.acceleration[k]!}
                min={-L.accelerationMmS2}
                max={L.accelerationMmS2}
                step={100}
                disabled={readOnly}
                commit={(v) => {
                  const acceleration = [...item.acceleration] as Vec3;
                  acceleration[k] = v;
                  return run({ type: 'updateLoad', load: { ...item, acceleration } });
                }}
              />
            </label>
          ))}
        </div>
      )}
      {item.kind === 'force' && (
        <div className="simulation-vector">
          {vecLabels.map((axis, k) => (
            <label key={axis}>
              <span>
                F{axis.toLowerCase()} <small>N</small>
              </span>
              <NumberInput
                label={`${item.name} F${axis.toLowerCase()} (N)`}
                value={item.force[k]!}
                min={-L.forceN}
                max={L.forceN}
                step={10}
                disabled={readOnly}
                commit={(v) => {
                  const force = [...item.force] as Vec3;
                  force[k] = v;
                  return run({ type: 'updateLoad', load: { ...item, force } });
                }}
              />
            </label>
          ))}
        </div>
      )}
      {item.kind === 'pressure' &&
        field(
          'Pressure',
          'MPa, into the body',
          <NumberInput
            label={`${item.name} pressure (MPa)`}
            value={item.pressure}
            min={-L.pressureMPa}
            max={L.pressureMPa}
            step={0.1}
            disabled={readOnly}
            commit={(pressure) => run({ type: 'updateLoad', load: { ...item, pressure } })}
          />,
        )}
      {item.kind === 'temperature' &&
        field(
          'Temperature',
          'K',
          <NumberInput
            label={`${item.name} temperature (K)`}
            value={item.temperature}
            min={0}
            max={L.temperatureK}
            step={1}
            disabled={readOnly}
            commit={(temperature) =>
              run({ type: 'updateConstraint', constraint: { ...item, temperature } })
            }
          />,
        )}
      {item.kind === 'heat-flux' &&
        field(
          'Heat flux',
          'kW/m², into the body',
          <NumberInput
            label={`${item.name} heat flux (kW/m²)`}
            value={item.flux}
            min={-L.heatFlux}
            max={L.heatFlux}
            step={0.1}
            disabled={readOnly}
            commit={(flux) => run({ type: 'updateLoad', load: { ...item, flux } })}
          />,
        )}
      {item.kind === 'convection' && (
        <>
          {field(
            'Film coefficient',
            'kW/(m²·K)',
            <NumberInput
              label={`${item.name} film coefficient (kW/(m²·K))`}
              value={item.coefficient}
              min={0}
              max={L.filmCoefficient}
              step={0.001}
              disabled={readOnly}
              commit={(coefficient) => run({ type: 'updateLoad', load: { ...item, coefficient } })}
            />,
          )}
          {field(
            'Ambient',
            'K',
            <NumberInput
              label={`${item.name} ambient temperature (K)`}
              value={item.ambient}
              min={0}
              max={L.temperatureK}
              step={1}
              disabled={readOnly}
              commit={(ambient) => run({ type: 'updateLoad', load: { ...item, ambient } })}
            />,
          )}
        </>
      )}
      {!readOnly && (
        <div className="simulation-actions">
          {'targets' in item && (
            <button type="button" disabled={!selected} onClick={retarget}>
              Use selected faces
            </button>
          )}
          <button type="button" onClick={() => remove(collection)}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}
