/**
 * #18 motions: an assembly's form-to-form animations with a camera path, played and scrubbed in
 * the view and recorded to an MP4 video in the editor (WebCodecs H.264), with progress and Stop.
 * A motion starts in a saved form and moves to each step's form over the step's duration; camera
 * keys are taken from the view at the time on the timeline.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import {
  cadMotionEasings,
  cadMotionLimits,
  motionCameraAt,
  motionDeltas,
  motionDurationMs,
  motionStaleForms,
  motionStateAt,
  motionUnsolvedJoints,
  withCameraKey,
  type CadMotion,
  type CadMotionEasing,
} from '@editor-platform/cad-core';
import { browserVideoEncoding, encodeMp4, videoSizes } from '@editor-platform/character/video';
import { useEditorInput } from '@editor-platform/editor-ui';
import type { CadAssembly } from './assembly';
import type { CadSnapshot } from './controller';
import type { CadViewport } from './viewport';

const fps = 30;
const easingLabel: Record<CadMotionEasing, string> = {
  linear: 'Linear',
  easeInOut: 'Ease in and out',
};
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const fileName = (name: string, motion: string, size: string) =>
  `${`${name}-${motion}`.replace(/[\\/:*?"<>|\s]+/g, '-')}-${size}.mp4`;
/** The motion with new steps; camera keys past the new end are dropped (Codex on #34). */
function withSteps(d: CadMotion, steps: CadMotion['steps']): CadMotion {
  const total = motionDurationMs({ steps });
  const camera = d.camera?.filter((k) => k.atMs <= total);
  const { camera: _old, ...rest } = d;
  return { ...rest, steps, ...(camera?.length ? { camera } : {}) };
}

export function MotionsSection({
  assembly,
  snapshot,
  view,
  name,
}: {
  assembly: CadAssembly;
  snapshot: CadSnapshot;
  view: RefObject<CadViewport | null>;
  /** The Artifact's name, for the video file. */
  name: string;
}) {
  const doc = snapshot.content;
  const forms = doc.configurations ?? [];
  const motions = doc.motions ?? [];
  const evaluated = snapshot.evaluation?.status === 'ok' ? snapshot.evaluation.assembly : undefined;
  const joints = evaluated?.joints;
  const [draft, setDraft] = useState<CadMotion>();
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState('');
  const [size, setSize] = useState<string>(videoSizes[0].label);
  const [recording, setRecording] = useState<{ done: number; total: number }>();
  const stop = useRef<AbortController>(undefined);
  const shown = useRef(false);
  // Parts still evaluating are drawn as boxes: no video of them yet (Codex on #34).
  const { progress: partsLeft } = useSyncExternalStore(assembly.subscribe, assembly.getSnapshot);
  // The content a recording runs on: an edit during it ends the recording (Codex on #34).
  const contentNow = useRef(snapshot.contentHash);
  contentNow.current = snapshot.contentHash;
  const disabled = snapshot.readOnly || snapshot.busy || !!recording;
  // A motion being edited is a pending input: save, export and switching wait for Save motion or
  // Cancel, so it is never lost unseen (Codex on #34).
  useEditorInput({
    label: 'Motion',
    // A video being recorded is pending work too: leaving would drop it unseen (Codex on #35).
    read: () => ({ dirty: !!draft || !!recording }),
    prepare: () => {
      if (recording)
        throw new Error(
          '動画を書き出しています。終わるか「Stop video」を押してから、もう一度操作してください。',
        );
      if (draft)
        throw new Error(
          '動きの編集が保存されていません。「Save motion」か「Cancel」を押してから、もう一度操作してください。',
        );
      return () => {};
    },
    focus: () => document.querySelector<HTMLElement>('[aria-label="Motion name"]')?.focus(),
  });

  /** The motion's frame at `t` in the view; false where it cannot be shown. */
  const show = (m: CadMotion, t: number) => {
    const v = view.current;
    const state = joints && motionStateAt(doc, m, t);
    if (!v || !state || !joints) return false;
    // A joint that has not solved would stand still while the rest moves (Codex on #34).
    const unsolved = motionUnsolvedJoints(doc, joints, state.mounts);
    if (unsolved.length) {
      setNote(
        `ジョイント ${unsolved.join('、')} が解けていないため、この動きは表示できません。ジョイントを直してから、もう一度試してください。`,
      );
      return false;
    }
    v.showMotion({
      deltas: motionDeltas(doc, joints, state.values, state.mounts),
      ...(m.camera ? { camera: motionCameraAt(m.camera, t)! } : {}),
    });
    shown.current = true;
    return true;
  };
  const endShow = () => {
    if (shown.current) view.current?.endMotion();
    shown.current = false;
  };
  // Leaving the editor (or the document changing under it) puts the parts back.
  useEffect(() => () => endShow(), []);
  useEffect(() => {
    if (!draft || recording) return;
    if (!show(draft, timeMs)) endShow();
  }, [draft, timeMs, doc, joints]);
  const draftTotal = draft ? motionDurationMs(draft) : 0;
  // The clock restarts from where it is when the steps change, with the new length (Codex on #34).
  useEffect(() => {
    if (!playing || !draft) return;
    const total = draftTotal;
    const start = performance.now() - timeMs;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(total, now - start);
      setTimeMs(t);
      if (t >= total) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, draftTotal]);

  if (forms.length < 2 && !motions.length && !draft) return null;
  const stale = (m: CadMotion) => motionStaleForms(doc, m).length > 0;
  const edit = (m: CadMotion) => {
    setDraft(structuredClone(m));
    setTimeMs(0);
    setNote('');
  };
  const create = () =>
    edit({
      id: assembly.newMotionId(),
      name: `Motion ${motions.length + 1}`,
      startFormId: forms[0]!.id,
      steps: [{ formId: forms[1]!.id, durationMs: 2000, easing: 'easeInOut' }],
    });
  const close = () => {
    setPlaying(false);
    setDraft(undefined);
    endShow();
  };
  const save = async () => {
    if (!draft) return;
    const rest = motions.filter((m) => m.id !== draft.id);
    const at = motions.findIndex((m) => m.id === draft.id);
    const next = at < 0 ? [...rest, draft] : motions.map((m) => (m.id === draft.id ? draft : m));
    if (await assembly.setMotions(next)) {
      setNote(`「${draft.name}」を保存しました。`);
      close();
    }
  };
  const remove = (id: string) => void assembly.setMotions(motions.filter((m) => m.id !== id));
  const patch = (p: Partial<CadMotion>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const patchStep = (i: number, p: Partial<CadMotion['steps'][number]>) => {
    if (!draft) return;
    const next = withSteps(
      draft,
      draft.steps.map((s, j) => (j === i ? { ...s, ...p } : s)),
    );
    setDraft(next);
    setTimeMs((t) => Math.min(t, motionDurationMs(next)));
  };
  const addKey = () => {
    const v = view.current?.currentView();
    if (!v || !draft) return;
    if (v.projection.type !== 'perspective')
      return setNote('カメラキーは透視投影のビューから追加してください。');
    if ((draft.camera?.length ?? 0) >= cadMotionLimits.cameraKeys)
      return setNote(`カメラキーは${cadMotionLimits.cameraKeys}個までです。`);
    patch({
      camera: withCameraKey(draft.camera, {
        atMs: Math.round(Math.min(timeMs, motionDurationMs(draft))),
        camera: v.camera,
        fovRad: v.projection.fovRad,
      }),
    });
  };
  const record = async (m: CadMotion) => {
    const v = view.current;
    const dims = videoSizes.find((s) => s.label === size) ?? videoSizes[0];
    if (!v || !joints) return;
    if (assembly.getSnapshot().progress)
      return setNote('部品の形を計算中です。計算が終わってから、もう一度書き出してください。');
    const startHash = snapshot.contentHash;
    const total = motionDurationMs(m);
    // The last tick reaches the end even when the length is not a whole number of frames: the
    // destination pose (and a mount switched there) is always in the video (Codex on #34).
    const ticks = Array.from({ length: Math.ceil((total / 1000) * fps - 1e-9) + 1 }, (_, i) => i);
    const ctl = new AbortController();
    stop.current = ctl;
    setPlaying(false);
    setNote('');
    setRecording({ done: 0, total: ticks.length });
    try {
      const blob = await encodeMp4(
        { width: dims.width, height: dims.height, fps: { numerator: fps, denominator: 1 }, ticks },
        {
          begin: (w, h) => v.beginCapture(w, h),
          frame: async (tick, timestamp, duration) => {
            if (contentNow.current !== startHash || assembly.getSnapshot().progress)
              throw new Error('書き出しの途中で組立てが変わりました。もう一度書き出してください。');
            // A joint drag holds the view's pose: a frame taken now would not be the motion's
            // (Codex on #34).
            if (v.draggingJoint)
              throw new Error(
                '書き出しの途中でジョイントが動かされました。もう一度書き出してください。',
              );
            if (!show(m, Math.min(total, (tick * 1000) / fps)))
              throw new Error('この動きは表示できません。');
            return new VideoFrame(v.captureCanvas(), { timestamp, duration });
          },
          end: () => v.endCapture(),
        },
        browserVideoEncoding(),
        (done, all) => setRecording({ done, total: all }),
        ctl.signal,
      );
      const file = fileName(name, m.name, dims.label);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: file }).click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setNote(`動画を書き出しました：${file}（${ticks.length}フレーム）`);
    } catch (e) {
      setNote(
        ctl.signal.aborted
          ? '動画の書き出しを中止しました。'
          : `動画を書き出せませんでした：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (stop.current === ctl) stop.current = undefined;
      setRecording(undefined);
      if (draft) show(draft, timeMs);
      else endShow();
    }
  };

  const total = draft ? motionDurationMs(draft) : 0;
  const draftStale = draft ? stale(draft) : false;
  return (
    <div className="cad-forms" data-testid="cad-motions">
      <h3>Motions ({motions.length})</h3>
      {motions.length > 0 && (
        <ul aria-label="Motions">
          {motions.map((m) => (
            <li key={m.id} className="cad-form" data-testid="cad-motion">
              <div className="cad-row">
                <strong>{m.name}</strong>
                <small className="cad-muted">
                  {seconds(motionDurationMs(m))} · {m.steps.length} steps
                  {m.camera ? ` · ${m.camera.length} camera keys` : ''}
                </small>
                {stale(m) && (
                  <small className="cad-part-state" data-state="stale">
                    形態が見つからないか、古くなっているか、ジョイントの範囲を外れています
                  </small>
                )}
              </div>
              <div className="cad-row" role="group" aria-label={`Motion ${m.name}`}>
                <button type="button" disabled={disabled || !!draft} onClick={() => edit(m)}>
                  Edit
                </button>
                <button
                  type="button"
                  disabled={disabled || !!draft || stale(m) || !joints || !!partsLeft}
                  onClick={() => void record(m)}
                >
                  Export video
                </button>
                <button type="button" disabled={disabled || !!draft} onClick={() => remove(m.id)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!draft && !snapshot.readOnly && (
        <div className="cad-row">
          <button
            type="button"
            disabled={disabled || forms.length < 2 || motions.length >= cadMotionLimits.motions}
            onClick={create}
          >
            New motion
          </button>
        </div>
      )}
      {draft && (
        <div className="cad-component" role="group" aria-label="Motion editor">
          <label>
            Motion name
            <input
              aria-label="Motion name"
              value={draft.name}
              disabled={!!recording}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <label>
            Start form
            <select
              aria-label="Start form"
              value={draft.startFormId}
              disabled={!!recording}
              onChange={(e) => patch({ startFormId: e.target.value })}
            >
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <ol aria-label="Motion steps">
            {draft.steps.map((s, i) => (
              <li key={i} className="cad-row">
                <select
                  aria-label={`Step ${i + 1} form`}
                  value={s.formId}
                  disabled={!!recording}
                  onChange={(e) => patchStep(i, { formId: e.target.value })}
                >
                  {forms.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Step ${i + 1} seconds`}
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={s.durationMs / 1000}
                  disabled={!!recording}
                  onChange={(e) => {
                    const ms = Math.round(Number(e.target.value) * 1000);
                    if (ms >= cadMotionLimits.minStepMs && ms <= cadMotionLimits.maxStepMs)
                      patchStep(i, { durationMs: ms });
                  }}
                />
                <select
                  aria-label={`Step ${i + 1} easing`}
                  value={s.easing}
                  disabled={!!recording}
                  onChange={(e) => patchStep(i, { easing: e.target.value as CadMotionEasing })}
                >
                  {cadMotionEasings.map((x) => (
                    <option key={x} value={x}>
                      {easingLabel[x]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!!recording || draft.steps.length < 2}
                  onClick={() => {
                    const next = withSteps(
                      draft,
                      draft.steps.filter((_, j) => j !== i),
                    );
                    setDraft(next);
                    setTimeMs((t) => Math.min(t, motionDurationMs(next)));
                  }}
                >
                  Remove step {i + 1}
                </button>
              </li>
            ))}
          </ol>
          <div className="cad-row">
            <button
              type="button"
              disabled={
                !!recording || forms.length < 2 || draft.steps.length >= cadMotionLimits.steps
              }
              onClick={() =>
                setDraft({
                  ...draft,
                  steps: [
                    ...draft.steps,
                    {
                      formId:
                        draft.steps[draft.steps.length - 1]?.formId === forms[0]!.id
                          ? forms[1]!.id
                          : forms[0]!.id,
                      durationMs: 2000,
                      easing: 'easeInOut',
                    },
                  ],
                })
              }
            >
              Add step
            </button>
          </div>
          <div className="cad-row">
            <input
              type="range"
              aria-label="Motion time"
              min={0}
              max={total}
              step={10}
              value={Math.min(timeMs, total)}
              disabled={!!recording}
              onChange={(e) => {
                setPlaying(false);
                setTimeMs(Number(e.target.value));
              }}
            />
            <output aria-label="Motion time shown">
              {seconds(Math.min(timeMs, total))} / {seconds(total)}
            </output>
          </div>
          <div className="cad-row">
            <button
              type="button"
              disabled={!!recording || draftStale || !joints}
              onClick={() => {
                if (!playing && timeMs >= total) setTimeMs(0);
                setPlaying(!playing);
              }}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            <button type="button" disabled={!!recording} onClick={addKey}>
              Add camera key
            </button>
          </div>
          {draft.camera && (
            <ul aria-label="Camera keys">
              {draft.camera.map((k) => (
                <li key={k.atMs} className="cad-row">
                  <span>Camera at {seconds(k.atMs)}</span>
                  <button
                    type="button"
                    disabled={!!recording}
                    onClick={() => {
                      const camera = draft.camera!.filter((x) => x.atMs !== k.atMs);
                      const { camera: _old, ...rest } = draft;
                      setDraft({ ...rest, ...(camera.length ? { camera } : {}) });
                    }}
                  >
                    Delete camera key at {seconds(k.atMs)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {draftStale && (
            <p className="cad-diagnostic" role="note">
              この動きが通る形態が見つからないか、古くなっているか、ジョイントの範囲を外れています。手順の形態を選び直してください。
            </p>
          )}
          <div className="cad-row">
            <button
              type="button"
              disabled={disabled || !draft.name.trim() || draftStale}
              onClick={() => void save()}
            >
              Save motion
            </button>
            <button type="button" disabled={!!recording} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="cad-row">
        <label>
          Video size
          <select
            aria-label="Video size"
            value={size}
            disabled={!!recording}
            onChange={(e) => setSize(e.target.value)}
          >
            {videoSizes.map((s) => (
              <option key={s.label} value={s.label}>
                {s.label} ({s.width} × {s.height}, {fps} fps)
              </option>
            ))}
          </select>
        </label>
      </div>
      {recording && (
        <div className="cad-row" role="status" aria-label="Video progress">
          <progress max={recording.total} value={recording.done} />
          <span>
            Frame {recording.done} of {recording.total}
          </span>
          <button type="button" onClick={() => stop.current?.abort()}>
            Stop video
          </button>
        </div>
      )}
      {note && (
        <p className="cad-muted" role="status" data-testid="cad-motion-note">
          {note}
        </p>
      )}
    </div>
  );
}
