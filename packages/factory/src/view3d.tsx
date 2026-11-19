/**
 * FT4b: the factory in 3D inside its building, and the replay of a recorded run. The building is
 * evaluated by the Host's BIM kernel and drawn cut above the ground floor, its walls see-through;
 * the factory's boxes are drawn over it at the replay time (docs/cad/factory-twin.md).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { browserVideoEncoding, encodeMp4 } from '@editor-platform/character/video';
import {
  BimEvaluator,
  bimViewBounds,
  bimViewSolids,
  BimViewport,
  type BimEvaluation,
  type BimKernel,
  type BimLook,
} from '@editor-platform/bim';
import {
  bimElementBox,
  deriveBim,
  type BimDocument,
  type BimElementKind,
} from '@editor-platform/bim-core';
import {
  FactoryReplay,
  type FactoryDocument,
  type FactoryPlacement,
  type FactoryRunResult,
} from '@editor-platform/factory-core';
import { factorySceneSolids, type FactoryLookMesh } from './scene';

/** FT4c: a CAD look as the Host has it: being evaluated, failed (why), or its meshes. */
export type FactoryLookView =
  | { status: 'pending' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; meshes: FactoryLookMesh[] };
import {
  factoryStillFileName,
  factoryVideoFileName,
  factoryVideoFps,
  factoryVideoFrames,
  factoryVideoProblems,
  factoryVideoSizes,
  factoryVideoSpeeds,
  type FactoryVideoSettings,
} from './video';

type Bounds = [[number, number, number], [number, number, number]];
/** Elements starting this high or higher are cut away, to look in from above. */
export const factoryCutMm = 2500;
const wallLook: BimLook = { color: '#cbd5e1', opacity: 0.35 };
const hidden: ReadonlySet<BimElementKind> = new Set(['space', 'opening']);
/** The pick ID of a building element in the factory's 3D view. */
export const factoryBuildingPick = (id: string) => ` bim:${id}`;
export const factoryReplaySpeeds = [1, 10, 60, 600] as const;

/** FT4c: stills are drawn at 1080p. */
const stillSize = { width: 1920, height: 1080 };

const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** Waits until `ok()` holds (checked every animation frame), or fails after `ms`. */
function waitFor(ok: () => boolean, signal: AbortSignal, ms: number, what: string) {
  return new Promise<void>((resolve, reject) => {
    const until = performance.now() + ms;
    const check = () => {
      if (signal.aborted) return reject(new Error('cancelled'));
      if (ok()) return resolve();
      if (performance.now() > until) return reject(new Error(what));
      requestAnimationFrame(check);
    };
    check();
  });
}

/**
 * The building as the factory's 3D view draws it: the elements starting below the cut, walls and
 * columns see-through, picked under their own IDs; and the bounds of those elements only, so the
 * view is framed on what is drawn, not on the storeys above the cut.
 */
export function factoryBuildingView(
  bim: BimDocument,
  evaluation: Extract<BimEvaluation, { status: 'ok' }>,
): { solids: ReturnType<typeof bimViewSolids>; bounds: Bounds | undefined } {
  const derived = deriveBim(bim);
  const kinds = new Map(bim.elements.map((e) => [e.id, e.kind]));
  const kept = new Set<string>();
  const solids = bimViewSolids(bim, evaluation, {
    selection: new Set(),
    hiddenKinds: hidden,
    tint: (id) => {
      const b = bimElementBox(bim, derived, id);
      if (!b || b[0][2] >= factoryCutMm) return null;
      kept.add(id);
      const kind = kinds.get(id);
      return kind === 'wall' || kind === 'column' ? wallLook : undefined;
    },
  });
  return {
    // The building's IDs belong to another document: picked, they must never be read as a
    // factory object's (a leading space, which no document ID has).
    solids: solids.map((sol) => ({
      ...sol,
      instances: sol.instances.map((i) => ({ ...i, path: i.path.map(factoryBuildingPick) })),
    })),
    bounds: kept.size ? bimViewBounds(evaluation, bim, [...kept]) : undefined,
  };
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

export function FactoryView3D({
  doc,
  places,
  result,
  bim,
  kernel,
  selection,
  onPick,
  looks,
}: {
  doc: FactoryDocument;
  places: ReadonlyMap<string, FactoryPlacement>;
  /** The run to replay: only a result for the current model, with its timeline. */
  result: FactoryRunResult | undefined;
  bim: BimDocument | undefined;
  kernel: BimKernel | undefined;
  selection: string | undefined;
  onPick(id: string | undefined): void;
  /** FT4c: the objects' CAD looks, by content hash (from the Host), and when they change. */
  looks?: { view(contentHash: string): FactoryLookView; revision: number };
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<BimViewport | undefined>(undefined);
  const pick = useRef(onPick);
  pick.current = onPick;
  const objects = useRef(new Set<string>());
  objects.current = new Set(doc.objects.map((o) => o.id));
  const [status, setStatus] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let v: BimViewport;
    try {
      v = new BimViewport(host.current, {
        // Only an object is selected from the view (its ID among the document's objects).
        onPick: (id) => pick.current(id && objects.current.has(id) ? id : undefined),
        onContextLost: () => setStatus('The 3D view was lost; switch views to reopen it.'),
      });
    } catch {
      // No WebGL (or no context left): the factory stays usable in Plan.
      setUnavailable(true);
      return;
    }
    view.current = v;
    return () => {
      v.dispose();
      view.current = undefined;
    };
  }, []);
  // The building: evaluated once per version, cut and see-through.
  const evaluator = useMemo(() => (kernel ? new BimEvaluator(kernel) : undefined), [kernel]);
  const [evaluated, setEvaluated] = useState<{
    bim: BimDocument;
    result: Extract<BimEvaluation, { status: 'ok' }>;
  }>();
  const failedBim = useRef<BimDocument | undefined>(undefined);
  useEffect(() => {
    if (!bim || !evaluator) return;
    let live = true;
    setStatus('Evaluating the building…');
    evaluator
      .evaluate(bim)
      .then((r) => {
        if (!live) return;
        if (r.status !== 'ok') {
          failedBim.current = bim;
          return setStatus('The building could not be evaluated.');
        }
        setEvaluated({ bim, result: r });
        // Failed elements are left out of the view: say which, so the building is not read as
        // complete.
        const failed = [...r.elements].flatMap(([id, e]) =>
          e.status === 'error' ? [`${id} (${e.code})`] : [],
        );
        setStatus(
          failed.length
            ? `${failed.length} building element${failed.length === 1 ? '' : 's'} could not be built and ${failed.length === 1 ? 'is' : 'are'} not shown: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ' …' : ''}`
            : '',
        );
      })
      .catch((e) => {
        if (!live) return;
        failedBim.current = bim;
        setStatus(`The building could not be evaluated: ${String(e)}`);
      });
    return () => {
      live = false;
    };
  }, [bim, evaluator]);
  const building = useMemo(
    () =>
      bim && evaluated?.bim === bim
        ? factoryBuildingView(bim, evaluated.result)
        : { solids: [], bounds: undefined },
    [bim, evaluated],
  );
  // The replay.
  const replay = useMemo(
    () =>
      result?.timeline ? new FactoryReplay(doc, result.timeline, places, result.endMs) : undefined,
    [doc, result, places],
  );
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof factoryReplaySpeeds)[number]>(60);
  // Walkers stride in real time while playing (one stride a second), whatever the speed.
  const [stride, setStride] = useState<number>();
  const end = replay?.endMs ?? 0;
  const t = Math.min(time, end);
  useEffect(() => {
    if (!playing || !replay) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const dt = (now - last) * speed;
      last = now;
      setStride(now / 1000);
      setTime((x) => {
        const next = Math.min(replay.endMs, x + dt);
        if (next >= replay.endMs) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, replay, speed]);
  const frame = useMemo(() => replay?.at(t), [replay, t]);
  const scene = useMemo(
    () =>
      factorySceneSolids(doc, places, frame, selection, stride, (h) => {
        const v = looks?.view(h);
        return v?.status === 'ready' ? v.meshes : undefined;
      }),
    [doc, places, frame, selection, stride, looks?.revision],
  );
  // How many objects are drawn by their CAD look (the rest are boxes).
  const lookCount = doc.objects.filter(
    (o) => o.look && looks?.view(o.look.contentHash).status === 'ready',
  ).length;
  // What the view last drew (the time and stride), for a recording to wait on.
  const drawn = useRef('');
  const framed = useRef<string | undefined>(undefined);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const own = building.bounds;
    const bounds: Bounds | undefined =
      own && scene.bounds
        ? ([
            [0, 1, 2].map((k) => Math.min(own[0][k]!, scene.bounds![0][k]!)),
            [0, 1, 2].map((k) => Math.max(own[1][k]!, scene.bounds![1][k]!)),
          ] as Bounds)
        : (own ?? scene.bounds);
    v.show([...building.solids, ...scene.solids], bounds);
    drawn.current = `${frame?.timeMs ?? -1}|${stride ?? ''}|${building.solids.length}`;
    // Framed once on the factory, and once more when the building or the first looks arrive (a
    // look keeps its own size, so it may reach past its box). Later looks leave the camera.
    const key = `${own ? 'building' : 'factory'}|${lookCount > 0 ? 'looks' : ''}`;
    const first = !framed.current;
    const grew =
      !!framed.current &&
      ((own && !framed.current.startsWith('building')) ||
        (lookCount > 0 && !framed.current.endsWith('looks')));
    if (framed.current !== key && bounds && (first || grew)) {
      v.fit(bounds);
      framed.current = key;
    }
  }, [building, scene, frame, stride, lookCount]);
  // FT4c: a still of the view, and a video of the replay.
  const [note, setNote] = useState('');
  const [video, setVideo] = useState<FactoryVideoSettings>();
  const [recording, setRecording] = useState<{ done: number; total: number }>();
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  // A recording is of one model's replay: an edit (or a new run) stops it.
  const source = useRef<{ doc: FactoryDocument; replay: FactoryReplay } | undefined>(undefined);
  const changed = useRef(false);
  useEffect(() => {
    const s = source.current;
    if (!s || (s.doc === doc && s.replay === replay)) return;
    changed.current = true;
    abort.current?.abort();
  }, [doc, replay]);
  const busy = !!recording;
  // Whether the building is still being evaluated (read now, not as of a past render).
  const evaluating = useRef(false);
  evaluating.current = !!bim && !!evaluator && evaluated?.bim !== bim && failedBim.current !== bim;
  // And whether a placed CAD look is still being evaluated (every frame shows the finished look).
  const lookPending = useRef(false);
  lookPending.current = doc.objects.some(
    (o) => !!o.look && looks?.view(o.look.contentHash).status === 'pending',
  );
  const waitingForBuilding = () => evaluating.current || lookPending.current;
  const still = async () => {
    const v = view.current;
    if (!v || busy) return;
    setNote('');
    try {
      v.beginCapture(stillSize.width, stillSize.height);
      let blob: Blob | null;
      try {
        // The canvas is read as drawn now, before anything draws again.
        blob = await new Promise<Blob | null>((res) => v.captureCanvas().toBlob(res, 'image/png'));
      } finally {
        v.endCapture();
      }
      if (!blob) throw new Error('the browser made no image');
      const name = factoryStillFileName(doc.name, t);
      download(blob, name);
      setNote(`Still saved: ${name}.`);
    } catch (e) {
      setNote(`The still was not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const videoProblems = video && replay ? factoryVideoProblems(end / 1000, video) : [];
  const record = async (settings: FactoryVideoSettings) => {
    const v = view.current;
    if (!v || !replay || busy || videoProblems.length) return;
    const frames = factoryVideoFrames(settings);
    const ctl = new AbortController();
    abort.current = ctl;
    source.current = { doc, replay };
    changed.current = false;
    const [before, beforeStride] = [time, stride];
    setPlaying(false);
    setNote('');
    setRecording({ done: 0, total: frames.ticks.length });
    try {
      // The building and the looks are in every frame: wait while they are evaluated.
      if (waitingForBuilding())
        await waitFor(
          () => !waitingForBuilding(),
          ctl.signal,
          600_000,
          'the building or a CAD look was not evaluated',
        );
      const blob = await encodeMp4(
        {
          width: settings.width,
          height: settings.height,
          fps: factoryVideoFps,
          ticks: frames.ticks,
        },
        {
          begin: (w, h) => v.beginCapture(w, h),
          frame: async (tick, timestamp, duration) => {
            const at = frames.timeOf(tick);
            const gait = frames.strideOf(tick);
            flushSync(() => {
              setTime(at);
              setStride(gait);
            });
            await waitFor(
              () => drawn.current.startsWith(`${replay.at(at).timeMs}|${gait}|`),
              ctl.signal,
              30_000,
              'the 3D view did not draw the frame',
            );
            return new VideoFrame(v.captureCanvas(), { timestamp, duration });
          },
          end: () => v.endCapture(),
        },
        browserVideoEncoding(),
        (done, total) => setRecording({ done, total }),
        ctl.signal,
      );
      const name = factoryVideoFileName(doc.name, settings);
      download(blob, name);
      setNote(`Video recorded: ${name}, ${frames.ticks.length} frames.`);
      setVideo(undefined);
    } catch (e) {
      if (ctl.signal.aborted)
        setNote(
          changed.current
            ? 'The recording stopped: the model or its run changed.'
            : 'The recording was cancelled.',
        );
      else setNote(`The video was not recorded: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      abort.current = undefined;
      source.current = undefined;
      setRecording(undefined);
      setTime(before);
      setStride(beforeStride);
    }
  };
  return (
    <div className="fac-3d" data-testid="fac-3d" data-looks={lookCount}>
      <div ref={host} className="fac-3d-canvas" />
      {(unavailable || status || (bim && !kernel)) && (
        <p className="fac-3d-status" role="status" data-testid="fac-3d-status">
          {unavailable
            ? 'The 3D view could not start here (no WebGL); the plan still works.'
            : status || 'No kernel build: the building is not drawn.'}
        </p>
      )}
      <div className="fac-replay" role="group" aria-label="Replay">
        <button
          type="button"
          disabled={!replay || busy}
          onClick={() => {
            if (!replay) return;
            if (!playing && t >= replay.endMs) setTime(0);
            setPlaying(!playing);
          }}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          aria-label="Replay time (s)"
          min={0}
          max={Math.floor(end / 1000)}
          step={1}
          value={Math.floor(t / 1000)}
          disabled={!replay || busy}
          onChange={(e) => {
            setPlaying(false);
            setTime(Number(e.target.value) * 1000);
          }}
        />
        <output data-testid="fac-replay-time">{replay ? clock(t) : 'Run to replay'}</output>
        <select
          aria-label="Replay speed"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value) as typeof speed)}
        >
          {factoryReplaySpeeds.map((s) => (
            <option key={s} value={s}>
              ×{s}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void still()}>
          Save still
        </button>
        <button
          type="button"
          disabled={!replay || busy}
          onClick={() =>
            setVideo(
              video
                ? undefined
                : {
                    fromS: Math.floor(t / 1000),
                    toS: Math.min(Math.floor(end / 1000), Math.floor(t / 1000) + 3600),
                    speed: 600,
                    width: factoryVideoSizes[0].width,
                    height: factoryVideoSizes[0].height,
                  },
            )
          }
        >
          Record video
        </button>
        {replay && result?.timeline?.truncated && (
          <span className="fac-replay-cut" role="note" data-testid="fac-replay-cut">
            The recording reached its record limit: the replay ends at {clock(replay.endMs)} of{' '}
            {clock(result.endMs)}.
          </span>
        )}
        {frame && (
          <span className="fac-replay-counts" data-testid="fac-replay-counts">
            {frame.parts.length} parts · {frame.vehicles.filter((v) => v.driving).length} driving ·{' '}
            {frame.workers.filter((w) => w.walking).length} walking
          </span>
        )}
      </div>
      {video && replay && (
        <div className="fac-video" role="group" aria-label="Video">
          <label>
            Video from (s)
            <input
              type="number"
              min={0}
              max={Math.floor(end / 1000)}
              value={video.fromS}
              disabled={busy}
              onChange={(e) => setVideo({ ...video, fromS: Number(e.target.value) })}
            />
          </label>
          <label>
            Video to (s)
            <input
              type="number"
              min={0}
              max={Math.floor(end / 1000)}
              value={video.toS}
              disabled={busy}
              onChange={(e) => setVideo({ ...video, toS: Number(e.target.value) })}
            />
          </label>
          <label>
            Video speed
            <select
              value={video.speed}
              disabled={busy}
              onChange={(e) => setVideo({ ...video, speed: Number(e.target.value) })}
            >
              {factoryVideoSpeeds.map((x) => (
                <option key={x} value={x}>
                  ×{x}
                </option>
              ))}
            </select>
          </label>
          <label>
            Video size
            <select
              value={`${video.width}x${video.height}`}
              disabled={busy}
              onChange={(e) => {
                const [w, h] = e.target.value.split('x').map(Number);
                setVideo({ ...video, width: w!, height: h! });
              }}
            >
              {factoryVideoSizes.map((x) => (
                <option key={x.label} value={`${x.width}x${x.height}`}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          {recording ? (
            <>
              <span data-testid="fac-video-progress">
                Recording {recording.done} / {recording.total}
              </span>
              <button type="button" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={videoProblems.length > 0}
              onClick={() => void record(video)}
            >
              Record
            </button>
          )}
          {videoProblems.length > 0 && (
            <p className="fac-video-problems" role="alert">
              {videoProblems.join(' ')}
            </p>
          )}
        </div>
      )}
      {note && (
        <p className="fac-export-note" aria-label="Export status" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
