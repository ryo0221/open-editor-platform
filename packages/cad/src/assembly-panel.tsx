/**
 * R2b-1 Surface entries (docs/cad/r2b-assembly.md, Surface): the component list with each
 * part's state, inserting a saved version from the Host, a fixed component's placement, and the
 * instanced parts in the viewport.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from 'react';
import { Dialog, Section, useEditorInput } from '@editor-platform/editor-ui';
import {
  composePoses,
  expandAssembly,
  occurrenceAccess,
  parseCopyStep,
  poseMatrix,
  type CadDocument,
  type CadSolvedPose,
  type Quaternion,
  type Vec3,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import {
  componentStates,
  type CadAssembly,
  type CadComponentState,
  type CadJointCreation,
  type CadPartCandidate,
} from './assembly';
import { describeCode, type CadSnapshot } from './controller';
import type { ViewportPart } from './assembly-view';
import { validJointFields } from './joint-values';
import { BomDialog } from './bom-panel';
import { PatternDialog, PatternInspector, patternSize } from './component-pattern-panel';
import { JointsSection } from './joints-panel';
import { UpdatePartsDialog } from './part-update-panel';
import type { CadViewport } from './viewport';

const stateLabel: Record<CadComponentState, string> = {
  available: '',
  pending: '計算中',
  substitute: '参考表示',
  failed: '計算できません',
  unavailable: '参照できません',
};
import {
  editedPlacement as placementOf,
  placementFields,
  validPlacement,
  type CadMirrorPlane,
} from './placement';
export { editedPlacement, placementFields } from './placement';

/** Draws every placed part from the shared part meshes, at its solved pose. */
export function AssemblyLayer({
  assembly,
  view,
  snapshot,
  restored,
}: {
  assembly: CadAssembly;
  view: RefObject<CadViewport | null>;
  snapshot: CadSnapshot;
  restored: number;
}) {
  const parts = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const [fits, setFits] = useState(true);
  // The parts are drawn again only when what they show changes: a joint drag's values (shown in
  // its Inspector) move the drawn parts by their matrices alone.
  const { creating, selectedJoint, selected, selectedPattern, meshes } = parts;
  const simplified = [...parts.simplified].sort().join(' ');
  // Placement and joint value entries not applied (any component or joint, shown or not) are
  // pending inputs: save, export and switching apply one, or refuse until it is valid. A joint
  // being made refuses them until it is applied or cancelled.
  useEditorInput({
    label: 'Placement',
    read: () => {
      const s = assembly.getSnapshot();
      return { dirty: s.drafts.size + s.jointDrafts.size > 0 || !!s.creating };
    },
    prepare: () => {
      const s = assembly.getSnapshot();
      // A joint being made shows poses that are not content (R2b-2c): nothing leaves with them.
      if (s.creating) throw new Error(describeCode('joint-creating'));
      const { components, joints } = snapshot.content;
      const pending = [
        ...[...s.drafts].map(([id, draft]) => ({
          id,
          name: components.find((c) => c.id === id)?.name ?? id,
          ok: validPlacement(draft.fields, draft.shown, snapshot.content),
          apply: () => assembly.applyDraft(id),
        })),
        ...[...s.jointDrafts].map(([id, draft]) => {
          const joint = joints.find((j) => j.id === id);
          return {
            id,
            name: joint?.name ?? id,
            ok: !!joint && validJointFields(joint, draft.fields),
            apply: () => assembly.applyJointDraft(id),
          };
        }),
      ];
      if (pending.length > 1)
        throw new Error(
          `${pending.map((p) => p.name).join('・')}の配置が適用されていません。1つずつApply placement・Apply valuesで適用してください。`,
        );
      const [entry] = pending;
      if (!entry) return () => {};
      if (!entry.ok) throw new Error(`${entry.name}：有効な数値を入力してください。`);
      // The placement applies through an evaluation: nothing may leave (or save) before it is
      // in the content, so the boundary starts it and refuses this time, like an open edit.
      return () => {
        void entry.apply();
        throw new Error('配置を適用しています。反映が終わってから、もう一度操作してください。');
      };
    },
    focus: () => {
      const s = assembly.getSnapshot();
      const id = [...s.drafts.keys()][0];
      const joint = [...s.jointDrafts.keys()][0];
      if (id) assembly.select(id);
      else if (joint) assembly.selectJoint(joint);
      setTimeout(() => document.querySelector<HTMLInputElement>('.cad-placement input')?.focus());
    },
  });
  useEffect(() => {
    // While broken connectors are chosen again, the previewed choice is shown (its versions and
    // solved poses), as the body meshes show its shapes; so is a joint being made (R2b-2c).
    const { content, evaluation } = creating?.preview ?? snapshot.rebindPreview ?? snapshot;
    const reduced = new Set(simplified.split(' '));
    const versions = assembly.versions(evaluation);
    const byVersion = new Map<string, ViewportPart>();
    const { occurrences } = expandAssembly(content, assembly.lookup);
    const access = occurrenceAccess(occurrences, assembly.access);
    const revokedPaths = new Set<string>();
    for (const [i, o] of occurrences.entries()) {
      const hash = o.part.source.contentHash;
      // Inside a revoked sub-assembly nothing is drawn: the sub-assembly is one box.
      const parent = o.path.slice(0, -1).join('\u0000');
      if (o.path.length > 1 && revokedPaths.has(parent)) {
        revokedPaths.add(o.path.join('\u0000'));
        continue;
      }
      // Access is checked for each occurrence: a revoked one is never drawn from a cached result,
      // even when an allowed Artifact places the same content. Geometry is shared per version.
      const allowed = access[i]!;
      if (!allowed) revokedPaths.add(o.path.join('\u0000'));
      const key = allowed ? hash : `${hash} revoked`;
      let entry = byVersion.get(key);
      if (!entry) {
        const state = allowed ? versions?.[hash]?.state : 'unavailable';
        const meshes = assembly.meshes(hash);
        const coarse = assembly.coarseMeshes(hash);
        const bodies = new Map((o.content?.bodies ?? []).map((b) => [b.id, b]));
        const drawn = (list: CadMesh[]) =>
          list.map((mesh) => {
            const body = bodies.get(mesh.bodyId);
            return {
              mesh,
              color: body?.appearance.color ?? '#9aa4b1',
              opacity: body?.appearance.opacity ?? 1,
              sheet: body?.kind === 'sheet',
            };
          });
        entry = {
          bounds: o.part.hint.boundsMm,
          instances: [],
          dim: state === 'substitute',
          // A simplified version keeps its coarse meshes when the budget allows (R2b-4, LOD).
          ...(state === 'unavailable' || state === 'failed'
            ? { box: 'unavailable' as const }
            : reduced.has(hash)
              ? coarse && state
                ? { coarse: drawn(coarse) }
                : { box: 'simplified' as const }
              : !meshes || !state
                ? { box: 'pending' as const }
                : { meshes: drawn(meshes), ...(coarse ? { coarse: drawn(coarse) } : {}) }),
        };
        byVersion.set(key, entry);
      }
      // A nested sub-assembly has no bodies of its own: only its parts are drawn.
      if (o.content && !o.content.bodies.some((b) => b.state === 'active') && !entry.box) continue;
      // A selected pattern shows its seed and every copy selected.
      const top = o.path[0]!;
      const seedOf = selectedPattern
        ? content.componentPatterns.find((p) => p.id === selectedPattern)?.seedComponentId
        : undefined;
      entry.instances.push({
        path: o.path,
        matrix: poseMatrix(o.pose),
        selected:
          top === selected ||
          (!!selectedPattern &&
            (top === seedOf || parseCopyStep(top)?.patternId === selectedPattern)),
      });
    }
    const viewport = view.current;
    if (!viewport) return;
    // The viewport admits the parts again when the budget or the native bodies change.
    viewport.onPartsFit = setFits;
    // Pending parts evaluate largest on screen first (R2b-4).
    assembly.setScreenSize((bounds) => viewport.screenSize(bounds));
    viewport.showParts([...byVersion.values()]);
  }, [assembly, view, snapshot, creating, selected, selectedPattern, meshes, simplified, restored]);
  useEffect(() => {
    const viewport = view.current;
    if (!viewport) return;
    // While a joint is made, clicks pick its connectors; a selected joint's child drags its value.
    const picking = creating && creating.step !== 'type';
    viewport.setConnectorTool(
      picking ? { onPick: (p) => void assembly.pickConnector(p) } : undefined,
    );
    viewport.setJointDragTool(creating ? undefined : assembly.jointDragTool());
  }, [assembly, view, snapshot, creating, selectedJoint, restored]);
  useEffect(() => {
    const viewport = view.current;
    if (!viewport) return;
    viewport.showJointMarks(jointMarks(creating, selectedJoint, snapshot));
  }, [view, snapshot, creating, selectedJoint, restored]);
  useEffect(() => () => view.current?.showJointMarks({ frames: [], points: [] }), [view]);
  return fits ? null : (
    <p className="cad-viewport-note" role="status">
      部品の形状が3D表示に使えるメモリーの上限を超えるため、部品を箱で表示しています。
    </p>
  );
}

/**
 * The connector frames drawn over the model: a joint being made, from its preview (or the points
 * picked until there is one), or the selected joint's.
 */
function jointMarks(
  creating: CadJointCreation | undefined,
  selectedJoint: string | undefined,
  snapshot: CadSnapshot,
): { frames: CadSolvedPose[]; points: Vec3[] } {
  const { evaluation, content } = creating?.preview ?? snapshot;
  const id = creating ? creating.jointId : selectedJoint;
  const assembly = evaluation?.status === 'ok' ? evaluation.assembly : undefined;
  const solution = id ? assembly?.joints?.[id] : undefined;
  const joint = id ? content.joints.find((j) => j.id === id) : undefined;
  const pose = joint && assembly?.poses?.[joint.child.componentId];
  if (solution?.status === 'solved' && pose)
    return { frames: [solution.parent, composePoses(pose, solution.child)], points: [] };
  const points = [creating?.parent?.point, creating?.child?.point].filter((p): p is Vec3 => !!p);
  return { frames: [], points };
}

const originFields = ['0', '0', '0', '0', '0', '0'];
const originPose = { translationMm: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as Quaternion };

function InsertPartDialog({
  assembly,
  doc,
  onClose,
}: {
  assembly: CadAssembly;
  doc: CadDocument;
  onClose: () => void;
}) {
  const [list, setList] = useState<CadPartCandidate[] | 'loading' | 'failed'>('loading');
  const [choice, setChoice] = useState<{ artifactId: string; versionId: string }>();
  // Where it goes: beside the model (so it is not hidden inside it), the origin, or typed.
  const [where, setWhere] = useState<'beside' | 'origin' | 'values'>('beside');
  const [fields, setFields] = useState(originFields);
  const valid = where !== 'values' || validPlacement(fields, originFields, doc);
  useEffect(() => {
    let live = true;
    assembly.source
      ?.list()
      .then((l) => live && setList(l))
      .catch(() => live && setList('failed'));
    return () => {
      live = false;
    };
  }, [assembly]);
  const { inserting } = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const chosen =
    typeof list === 'object' ? list.find((c) => c.artifactId === choice?.artifactId) : undefined;
  return (
    <Dialog title="Insert part" onClose={onClose}>
      <div className="cad-export" data-testid="cad-insert-part">
        <p>保存した版だけを挿入できます。版は自動では更新されません。</p>
        {list === 'loading' && <p role="status">読み込んでいます…</p>}
        {list === 'failed' && <p role="alert">部品の一覧を読み込めませんでした。</p>}
        {typeof list === 'object' && !list.length && (
          <p>挿入できる部品がありません。部品の文書で版を保存してください。</p>
        )}
        {typeof list === 'object' && list.length > 0 && (
          <ul className="cad-part-candidates" aria-label="Parts">
            {list.map((c) => (
              <li key={c.artifactId}>
                <span>{c.name}</span>
                <select
                  aria-label={`Version of ${c.name}`}
                  value={choice?.artifactId === c.artifactId ? choice.versionId : ''}
                  onChange={(e) =>
                    setChoice(
                      e.target.value
                        ? { artifactId: c.artifactId, versionId: e.target.value }
                        : undefined,
                    )
                  }
                >
                  <option value="">Choose a version</option>
                  {c.versions.map((v) => (
                    <option key={v.versionId} value={v.versionId}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
        <label>
          <span>Position</span>
          <select
            aria-label="Position"
            value={where}
            onChange={(e) => setWhere(e.target.value as typeof where)}
          >
            <option value="beside">Beside the model (+X)</option>
            <option value="origin">Origin</option>
            <option value="values">These values</option>
          </select>
        </label>
        {where === 'values' && (
          <div className="cad-placement" aria-label="Insert placement" role="group">
            <PlacementInputs fields={fields} onChange={setFields} />
            {!valid && <p className="cad-diagnostic">{placementProblem}</p>}
          </div>
        )}
        <div className="cad-row">
          <button
            type="button"
            disabled={!choice || !chosen || inserting || !valid}
            onClick={async () => {
              if (!choice || !chosen) return;
              let at: Parameters<CadAssembly['insert']>[3] =
                where === 'origin' ? 'origin' : 'beside';
              if (where === 'values') {
                const [translation, rotation] = placementOf(originPose, originFields, fields, doc);
                at = { translation, rotation };
              }
              if (await assembly.insert(choice.artifactId, choice.versionId, chosen.name, at))
                onClose();
            }}
          >
            {inserting ? 'Inserting…' : 'Insert'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

const placementLabels = [
  'X (mm)',
  'Y (mm)',
  'Z (mm)',
  'Rotate X (°)',
  'Rotate Y (°)',
  'Rotate Z (°)',
];
const placementProblem =
  '位置は数か長さの式（parameterの名前を使えます）、回転は度の数を入力してください。';

/** The six placement inputs: a position takes a number or a length expression, a turn degrees. */
function PlacementInputs({
  fields,
  disabled,
  onChange,
}: {
  fields: string[];
  disabled?: boolean;
  onChange: (fields: string[]) => void;
}) {
  return placementLabels.map((label, i) => (
    <label key={label}>
      <span>{label}</span>
      <input
        inputMode={i < 3 ? 'text' : 'decimal'}
        placeholder={i < 3 ? 'mm or expression' : undefined}
        value={fields[i] ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(fields.map((v, j) => (j === i ? e.target.value : v)))}
      />
    </label>
  ));
}

const mirrorPlanes: { plane: CadMirrorPlane; label: string }[] = [
  { plane: 'xz', label: 'XZ plane (Y → −Y)' },
  { plane: 'yz', label: 'YZ plane (X → −X)' },
  { plane: 'xy', label: 'XY plane (Z → −Z)' },
];

/** A copy of a fixed component on the other side of a plane through the origin (one edit). */
function MirrorCopy({
  assembly,
  componentId,
  disabled,
}: {
  assembly: CadAssembly;
  componentId: string;
  disabled: boolean;
}) {
  const [plane, setPlane] = useState<CadMirrorPlane>('xz');
  return (
    <div className="cad-row">
      <select
        aria-label="Mirror plane"
        value={plane}
        disabled={disabled}
        onChange={(e) => setPlane(e.target.value as CadMirrorPlane)}
      >
        {mirrorPlanes.map((p) => (
          <option key={p.plane} value={p.plane}>
            {p.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={disabled}
        title="反対側に、半回転した写しを置きます（形そのものは鏡映しません）。"
        onClick={() => void assembly.duplicateMirrored(componentId, plane)}
      >
        Mirror copy
      </button>
    </div>
  );
}

function PlacementFields({
  assembly,
  doc,
  componentId,
  readOnly,
}: {
  assembly: CadAssembly;
  doc: CadDocument;
  componentId: string;
  readOnly: boolean;
}) {
  const pose = doc.solvedPoses[componentId];
  const component = doc.components.find((c) => c.id === componentId);
  // Every edit settles the poses again (a new object for the same placement): the fields follow
  // only a change of the shown placement.
  const stored = JSON.stringify(pose ? placementFields(pose, component?.placement, doc) : []);
  const initial = useMemo(() => JSON.parse(stored) as string[], [stored]);
  // An entry not applied lives in the assembly, so selecting another component, closing the
  // panel or an unrelated edit keeps it; the layer's input boundary applies or refuses it.
  const { drafts } = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const draft = drafts.get(componentId);
  // The fields last applied, shown until the stored pose catches up with them.
  const [applying, setApplying] = useState<string[]>();
  useEffect(() => setApplying(undefined), [initial]);
  const fields = draft?.fields ?? applying ?? initial;
  const valid = validPlacement(fields, draft?.shown ?? initial, doc);
  const apply = () => {
    const attempt = fields;
    setApplying(attempt);
    void assembly.applyDraft(componentId).then((ok) => {
      // A refused placement (e.g. past the coordinate limit) returns to the stored one.
      if (!ok) setApplying((current) => (current === attempt ? undefined : current));
    });
  };
  if (!pose || !component) return null;
  return (
    <form
      className="cad-placement"
      aria-label="Placement"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) apply();
      }}
    >
      <PlacementInputs
        fields={fields}
        disabled={readOnly}
        onChange={(next) =>
          assembly.setDraft(componentId, { fields: next, shown: draft?.shown ?? initial })
        }
      />
      {!valid && <p className="cad-diagnostic">{placementProblem}</p>}
      {!readOnly && (
        <button type="submit" disabled={!valid}>
          Apply placement
        </button>
      )}
    </form>
  );
}

/** The Assembly section of the left panel: components, their states, insert and placement. */
export function AssemblyPanel({
  assembly,
  snapshot,
  narrow,
  name,
  onExportCsv,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
  narrow: boolean;
  /** The Artifact's name, for exported files. */
  name: string;
  onExportCsv?: (csv: Blob, options: { fileName: string }) => void;
}) {
  const parts = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  const [inserting, setInserting] = useState(false);
  const [bom, setBom] = useState(false);
  const [patterning, setPatterning] = useState<string>();
  const [updating, setUpdating] = useState<string[]>();
  const doc = snapshot.content;
  // Parts whose Artifact has a newer saved version than the one placed (never taken in itself).
  const newer = doc.parts.filter((p) => assembly.newerVersion(p.id));
  const states = useMemo(
    () =>
      componentStates(doc, snapshot.evaluation, assembly.lookup, assembly.access, assembly.later),
    // A pending part evaluated since bumps `meshes` (R2b-4).
    [doc, snapshot.evaluation, assembly, parts.meshes],
  );
  // Components with a version the budget simplified, anywhere inside (R2b-4, 簡略表示).
  const simplified = useMemo(() => {
    const ids = new Set<string>();
    if (!parts.simplified.size) return ids;
    for (const o of expandAssembly(doc, assembly.lookup).occurrences)
      if (parts.simplified.has(o.part.source.contentHash)) ids.add(o.path[0]!);
    return ids;
  }, [doc, assembly, parts.simplified]);
  const selected = doc.components.find((c) => c.id === parts.selected);
  const part = selected && doc.parts.find((p) => p.id === selected.partId);
  const state = selected && states.get(selected.id);
  const placedBy = selected && doc.joints.find((j) => j.child.componentId === selected.id);
  const pattern = doc.componentPatterns.find((p) => p.id === parts.selectedPattern);
  const seed = doc.components.find((c) => c.id === patterning);
  // Inserting parts is desktop work, like sketching (docs/cad/r2b-assembly.md, Surface).
  const insertReason = narrow
    ? 'Inserting parts needs a wider window (over 800 px).'
    : !assembly.source
      ? 'This Host offers no saved parts.'
      : undefined;
  if (!doc.components.length && snapshot.readOnly) return null;
  return (
    <nav className="cad-navigator cad-assembly" aria-label="Assembly">
      <Section title={`Assembly (${doc.components.length})`}>
        <ul aria-label="Components">
          {doc.components.map((c) => {
            const s = states.get(c.id)?.state ?? 'pending';
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="cad-item"
                  aria-pressed={parts.selected === c.id}
                  onClick={() => assembly.select(parts.selected === c.id ? undefined : c.id)}
                >
                  {c.name}
                  {stateLabel[s] && (
                    <small className={`cad-part-state cad-part-${s}`} data-state={s}>
                      {stateLabel[s]}
                    </small>
                  )}
                  {s === 'available' && simplified.has(c.id) && (
                    <small className="cad-part-state cad-part-simplified" data-state="simplified">
                      簡略表示
                    </small>
                  )}
                  {newer.some((p) => p.id === c.partId) && (
                    <small className="cad-part-state cad-part-newer">新しい版あり</small>
                  )}
                </button>
                {/* A pattern is one collapsed row under its seed: its copies are not listed. */}
                {doc.componentPatterns.some((p) => p.seedComponentId === c.id) && (
                  <ul aria-label={`Patterns of ${c.name}`}>
                    {doc.componentPatterns
                      .filter((p) => p.seedComponentId === c.id)
                      .map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            className="cad-item cad-pattern-item"
                            aria-pressed={parts.selectedPattern === p.id}
                            onClick={() =>
                              assembly.selectPattern(
                                parts.selectedPattern === p.id ? undefined : p.id,
                              )
                            }
                          >
                            {p.name}
                            <small className="cad-muted"> ×{patternSize(doc, p)}</small>
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {!snapshot.readOnly && (
          <div className="cad-row" role="group" aria-label="Parts">
            <button
              type="button"
              title={insertReason}
              disabled={!parts.canInsert || narrow}
              onClick={() => setInserting(true)}
            >
              Insert part…
            </button>
            {newer.length > 0 && (
              <button
                type="button"
                disabled={snapshot.busy}
                onClick={() => setUpdating(newer.map((p) => p.id))}
              >
                Update parts…
              </button>
            )}
          </div>
        )}
        {insertReason && !snapshot.readOnly && <p className="cad-muted">{insertReason}</p>}
        {doc.components.length > 0 && (
          <div className="cad-row">
            <button type="button" onClick={() => setBom(true)}>
              Bill of materials…
            </button>
          </div>
        )}
        {selected && part && (
          <div className="cad-component" data-testid="cad-component">
            <p>
              <strong>{selected.name}</strong>
              <br />
              <small>
                {part.name} ·{' '}
                {part.source.kind === 'version'
                  ? assembly.versionLabel(part.source.artifactId, part.source.versionId)
                  : `STEP product ${part.source.stepProduct.name}`}
              </small>
            </p>
            {state?.code && (
              <p className="cad-diagnostic" role="note">
                {describeCode(state.code)}
              </p>
            )}
            {(() => {
              const latest = assembly.newerVersion(part.id);
              return (
                latest && (
                  <p className="cad-muted">
                    新しい版{latest.label ? ` ${latest.label}` : ''}
                    があります。版は自動では更新されません。
                  </p>
                )
              );
            })()}
            {placedBy ? (
              <p className="cad-muted">
                jointの「{placedBy.name}」が配置しています。
                <button type="button" onClick={() => assembly.selectJoint(placedBy.id)}>
                  Show joint
                </button>
              </p>
            ) : (
              <>
                <PlacementFields
                  key={selected.id}
                  assembly={assembly}
                  doc={doc}
                  componentId={selected.id}
                  readOnly={snapshot.readOnly || snapshot.busy}
                />
                {!snapshot.readOnly && (
                  <MirrorCopy
                    assembly={assembly}
                    componentId={selected.id}
                    disabled={snapshot.busy}
                  />
                )}
              </>
            )}
            <label className="cad-check">
              <input
                type="checkbox"
                checked={selected.bom === 'include'}
                disabled={snapshot.readOnly || snapshot.busy}
                onChange={(e) =>
                  void assembly.setComponentBom(
                    selected.id,
                    e.target.checked ? 'include' : 'exclude',
                  )
                }
              />
              Count in BOM
            </label>
            <div className="cad-row">
              {state?.state === 'failed' && (
                <button
                  type="button"
                  disabled={snapshot.busy}
                  onClick={() => assembly.retryParts()}
                >
                  Recalculate parts
                </button>
              )}
              {assembly.source?.open && part.source.kind === 'version' && (
                <button
                  type="button"
                  onClick={() =>
                    part.source.kind === 'version' &&
                    assembly.source?.open?.(part.source.artifactId, part.source.versionId)
                  }
                >
                  Open part
                </button>
              )}
              {!snapshot.readOnly && assembly.source && part.source.kind === 'version' && (
                <button
                  type="button"
                  disabled={snapshot.busy}
                  onClick={() => setUpdating([part.id])}
                >
                  Change version…
                </button>
              )}
              {!snapshot.readOnly && (
                <button
                  type="button"
                  disabled={snapshot.busy}
                  onClick={() => setPatterning(selected.id)}
                >
                  Pattern…
                </button>
              )}
              {!snapshot.readOnly && (
                <button
                  type="button"
                  disabled={snapshot.busy}
                  onClick={() => void assembly.remove(selected.id)}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        )}
        {pattern && <PatternInspector assembly={assembly} snapshot={snapshot} pattern={pattern} />}
        <JointsSection assembly={assembly} snapshot={snapshot} narrow={narrow} />
      </Section>
      {inserting && (
        <InsertPartDialog assembly={assembly} doc={doc} onClose={() => setInserting(false)} />
      )}
      {seed && !snapshot.readOnly && (
        <PatternDialog assembly={assembly} seed={seed} onClose={() => setPatterning(undefined)} />
      )}
      {bom && (
        <BomDialog
          assembly={assembly}
          name={name}
          onExportCsv={onExportCsv}
          onClose={() => setBom(false)}
        />
      )}
      {updating && !snapshot.readOnly && (
        <UpdatePartsDialog
          assembly={assembly}
          partIds={updating}
          content={doc}
          onClose={() => setUpdating(undefined)}
        />
      )}
    </nav>
  );
}
