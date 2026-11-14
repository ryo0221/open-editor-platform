import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  BimEvaluator,
  BimViewport,
  exportBimIfc,
  bimViewBounds,
  bimViewSolids,
  type BimEvaluation,
  type BimKernel,
} from '@editor-platform/bim';
import {
  bimElementMass,
  deriveBim,
  type BimDocument,
  type BimElementKind,
} from '@editor-platform/bim-core';
import type { EditorInputBoundary } from '@editor-platform/editor-core';
import {
  checkBuildingInSite,
  checkConstructionSource,
  checkSite,
  earthworkVolumes,
  siteTerrain,
  siteWorksOnDay,
  constructionActions,
  freshConstructionId,
  readConstructionCsv,
  scheduleConstruction,
  siteOnDay,
  taskSpan,
  elementState,
  unscheduledElements,
  validateConstruction,
  writeConstructionCsv,
  type ConstructionAction,
  type ConstructionDocument,
  type ConstructionOperation,
  type ConstructionTask,
  type ConstructionDiagnostic,
  type SiteFootprint,
  type ConstructionSite,
  checkCranes,
  craneBaseZ,
  craneStands,
  liftScene,
  liftTimes,
  type CraneState,
  type CraneWorld,
  type LiftBody,
  type Point3,
  approachesOnDay,
  groundOnDay,
  gateCounts,
  hazardsOnDay,
  liftsPastDayEnd,
  siteHours,
  tripsOnDay,
  type HazardWorld,
  approachRows,
  diagnosticRows,
  liftOverflowRows,
  writeChecksCsv,
  writeConstructionIfc,
  type CheckRow,
} from '@editor-platform/construction-core';
import {
  PathRenderDialog,
  type PathRenderSource,
  type ViewSolid,
} from '@editor-platform/geometry-view';
import { browserVideoEncoding, encodeMp4 } from '@editor-platform/character/video';
import { addDays, utcDay } from '@editor-platform/time-axis';
import {
  formatLinks,
  formatTonnes,
  parseLinks,
  playbackDays,
  stateLook,
  stateLooks,
} from './display';
import { AnalysisPanel } from './analysis-panel';
import { analysedLook, analysisLooks, type FrameAnalysis, type FrameSolver } from './analysis-view';
import { CranePanel, type LiftOfDay } from './crane-panel';
import { craneSolid, siteCraneId } from './crane-view';
import { SitePanel, type SiteItem } from './site-panel';
import { TrafficPanel, type TrafficItem } from './traffic-panel';
import {
  hazardSolid,
  moverSolids,
  clockInDay,
  playStep,
  routeSolid,
  siteHazardId,
  siteRouteId,
} from './traffic-view';
import { siteBackdrop, sitePickPrefix, siteTemporaryId, siteViewSolids, union } from './site-view';
import {
  scheduleVideoFileName,
  scheduleVideoFps,
  scheduleVideoFrames,
  scheduleVideoProblems,
  scheduleVideoRates,
  scheduleVideoSizes,
  type ScheduleVideoSettings,
} from './schedule-video';

/** CS6c: what the surface asks of the 3D view for a still or a video. */
interface ViewHandle {
  renderSource(): PathRenderSource | undefined;
  /** The revision the view last drew (it starts with the day shown). */
  drawn(): string | undefined;
  /** True once the building is evaluated (or there is none to wait for). */
  ready(): boolean;
  /** Why the building can never be drawn here (no geometry kernel), if so. */
  unavailable(): string | undefined;
  begin(width: number, height: number): void;
  canvas(): HTMLCanvasElement;
  end(): void;
}

export interface ConstructionSurfaceProps {
  doc: ConstructionDocument;
  /** The scheduled BIM version's content, when the record keeps it. */
  bim: BimDocument | undefined;
  /** Names the BIM Artifact and version ("Office · v2"). */
  sourceLabel: string;
  /** Evaluates the building for the 3D view; without it the view stays empty. */
  kernel: BimKernel | undefined;
  readOnly: boolean;
  /** Applies operations as one Undo step; the reason when refused. */
  apply(ops: ConstructionOperation | ConstructionOperation[]): string | undefined;
  /** Other saved versions of the scheduled BIM Artifact, newest first. */
  versions?: { versionId: string; label: string }[];
  switchVersion?(versionId: string): Promise<string | undefined>;
  /**
   * The Host's save/export/switch boundary: a task or calendar form changed but not saved holds
   * it until the form is saved or discarded.
   */
  registerInput?(boundary: EditorInputBoundary): () => void;
  /** Tells the Host the forms' pending state changed. */
  inputsChanged?(): void;
  /** CS4b: solves a construction stage's frame (the Host's CalculiX); without it, no analysis. */
  frameSolver?: FrameSolver;
  /** CS6b: the schedule Artifact's ID, for the IFC's stable GlobalIds. */
  artifactId?: string;
}

/** Reports a form's unsaved state while it is mounted. */
function useDirty(report: (dirty: boolean) => void, dirty: boolean) {
  useEffect(() => report(dirty), [report, dirty]);
  useEffect(() => () => report(false), [report]);
}

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const actionLabels: Record<ConstructionAction, string> = {
  construct: 'Build',
  remove: 'Remove',
  temporary: 'Temporary',
};
const dayIndex = (day: string) => utcDay(day) ?? 0;
/** Not built objects: rooms and the openings cut by doors and windows. */
const hiddenKinds: ReadonlySet<BimElementKind> = new Set(['space', 'opening']);
const massReasons = {
  'no-density': 'a material has no density',
  'no-volume': 'not measured yet',
  unsupported: 'no mass for this kind',
  missing: 'not in the building',
} as const;

/**
 * CS1 (docs/cad/construction-site.md): the 4D schedule of a building. The task table and its
 * form, the calendar, CSV import and export, and a day slider over the building's 3D view, which
 * shows each element as it stands on that day.
 */
export function ConstructionSurface({
  doc,
  bim,
  sourceLabel,
  kernel,
  readOnly,
  apply,
  versions = [],
  switchVersion,
  registerInput,
  inputsChanged,
  frameSolver,
  artifactId,
}: ConstructionSurfaceProps) {
  const [error, setError] = useState('');
  // Forms with changes not yet saved: they hold the Host's save, export and switch.
  const pending = useRef(new Set<string>());
  const changed = useRef(inputsChanged);
  changed.current = inputsChanged;
  const reportTask = useCallback(
    (dirty: boolean) => markPending(pending.current, 'task', dirty, changed.current),
    [],
  );
  const reportCalendar = useCallback(
    (dirty: boolean) => markPending(pending.current, 'calendar', dirty, changed.current),
    [],
  );
  const reportBoundary = useCallback(
    (dirty: boolean) => markPending(pending.current, 'boundary', dirty, changed.current),
    [],
  );
  const reportSiteItem = useCallback(
    (dirty: boolean) => markPending(pending.current, 'site item', dirty, changed.current),
    [],
  );
  const reportCrane = useCallback(
    (dirty: boolean) => markPending(pending.current, 'crane', dirty, changed.current),
    [],
  );
  // Each form's Discard remounts only that form.
  const [taskEpoch, setTaskEpoch] = useState(0);
  const [calendarEpoch, setCalendarEpoch] = useState(0);
  const [boundaryEpoch, setBoundaryEpoch] = useState(0);
  const [siteItemEpoch, setSiteItemEpoch] = useState(0);
  const [craneEpoch, setCraneEpoch] = useState(0);
  const reportLoad = useCallback(
    (dirty: boolean) => markPending(pending.current, 'site load', dirty, changed.current),
    [],
  );
  const [loadEpoch, setLoadEpoch] = useState(0);
  // CS4b: the last frame analysis, and whether the view shows its members by their ratio.
  const [analysis, setAnalysis] = useState<FrameAnalysis>();
  /** The last analysed day whose frame could not be built, and why (for the checks). */
  const [unsolved, setUnsolved] = useState<{ day: string; notes: ConstructionDiagnostic[] }>();
  const [colour, setColour] = useState(false);
  const ratioLook = useMemo(
    () => (analysis && colour ? analysisLooks(analysis) : undefined),
    [analysis, colour],
  );
  // CS6c: while a video records, the schedule holds still.
  const recordingNow = useRef(false);
  // The building shown now: a recording stops if it changes under it.
  const bimNow = useRef(bim);
  bimNow.current = bim;
  useEffect(
    () =>
      registerInput?.({
        label: 'Construction schedule',
        // A recording holds saves and switches too, so the Host asks before either.
        read: () => ({ dirty: pending.current.size > 0 || recordingNow.current }),
        prepare: () => {
          if (recordingNow.current)
            throw new Error('A video is being recorded: wait for it, or cancel it, first.');
          if (pending.current.size)
            throw new Error(
              `Save or discard the ${[...pending.current].sort().join(' and ')} form first.`,
            );
          return () => {};
        },
        focus: () => {},
        // Host Undo/Redo would replace the content under an unsaved form: refused until then.
        history: () => {
          if (recordingNow.current) {
            setError('A video is being recorded: wait for it, or cancel it, before Undo or Redo.');
            return true;
          }
          if (!pending.current.size) return false;
          setError(`Save or discard the ${[...pending.current].sort().join(' and ')} form first.`);
          return true;
        },
      }),
    [registerInput],
  );
  const run = (ops: ConstructionOperation | ConstructionOperation[]) => {
    if (recordingNow.current) {
      setError('A video is being recorded: wait for it, or cancel it, before changing the plan.');
      return false;
    }
    const e = apply(ops);
    setError(e ?? '');
    return !e;
  };
  const valid = validateConstruction(doc).length === 0;
  const schedule = useMemo(() => (valid ? scheduleConstruction(doc) : undefined), [doc, valid]);
  const range = schedule ? playbackDays(doc, schedule) : undefined;
  const [day, setDay] = useState<string>();
  const shown =
    range && day
      ? day < range.first
        ? range.first
        : day > range.last
          ? range.last
          : day
      : range?.first;
  const site = schedule && shown ? siteOnDay(doc, schedule, shown) : undefined;
  // CS2b: the ground, earthworks and temporary works on the day.
  const terrain = useMemo(() => (valid ? siteTerrain(doc.site) : undefined), [doc.site, valid]);
  const volumes = useMemo(
    () => (valid && doc.site && terrain ? earthworkVolumes(doc.site, terrain) : []),
    [doc.site, terrain, valid],
  );
  const works = schedule && shown ? siteWorksOnDay(doc, schedule, volumes, shown) : undefined;
  const [siteItem, setSiteItem] = useState<SiteItem>();
  /** True while the open site item form has unsaved changes (and says so). */
  const siteHeld = () => {
    if (!pending.current.has('site item')) return false;
    setError('Save or discard the site item form first.');
    return true;
  };
  const selectSiteItem = (item: SiteItem | undefined) => {
    if ((item?.id !== siteItem?.id || item?.type !== siteItem?.type) && siteHeld()) return;
    setSiteItem(item);
  };
  const progressKey = works ? [...works.progress].join() + '|' + works.standing.join() : '';
  const siteView = useMemo(
    () =>
      doc.site && terrain && works
        ? siteViewSolids(doc.site, {
            progress: works.progress,
            standing: works.standing,
            selected: siteItem?.type === 'temporary' ? siteItem.id : undefined,
            terrain,
          })
        : undefined,
    // `works` is rebuilt every render; its content is `progressKey`.
    [doc.site, terrain, progressKey, siteItem],
  );
  const siteProblems = useMemo(
    () => (valid ? checkSite(doc, schedule) : []),
    [doc, schedule, valid],
  );
  const [buildingProblems, setBuildingProblems] = useState<ConstructionDiagnostic[]>([]);
  // CS3b: the cranes, their lifts and checks. The building's evaluated bodies come from the view.
  const [bodies, setBodies] = useState<{
    bim: BimDocument;
    bodies: Map<string, LiftBody>;
    kernelQuantities: ReadonlyMap<string, Record<string, number>>;
  }>();
  const derived = useMemo(() => (bim ? deriveBim(bim) : undefined), [bim]);
  const world = useMemo((): CraneWorld | undefined => {
    if (!bim || !derived || !bodies || bodies.bim !== bim || !terrain) return undefined;
    return {
      bodies: bodies.bodies,
      mass: (id) => {
        const m = bimElementMass(bim, derived, id, bodies.kernelQuantities);
        return m.status === 'ok' ? { kg: m.kg } : { reason: massReasons[m.status] };
      },
      ground: (p) => terrain.heightAt(p),
    };
  }, [bim, derived, bodies, terrain]);
  const [craneProblems, setCraneProblems] = useState<{
    doc: ConstructionDocument;
    world: CraneWorld;
    problems: ConstructionDiagnostic[];
  }>();
  const hasCranes = !!doc.site?.lifts?.length || (doc.site?.cranes?.length ?? 0) > 1;
  useEffect(() => {
    if (!schedule || !world || !hasCranes) return;
    // After the frame is drawn: the check takes a moment on a whole building.
    const timer = setTimeout(
      () => setCraneProblems({ doc, world, problems: checkCranes(doc, schedule, world) }),
      0,
    );
    return () => clearTimeout(timer);
  }, [doc, schedule, world, hasCranes]);
  const craneChecking =
    hasCranes && !!world && (craneProblems?.doc !== doc || craneProblems.world !== world);
  const shownCraneProblems =
    hasCranes && craneProblems?.doc === doc && craneProblems.world === world
      ? craneProblems.problems
      : [];
  const [selectedCrane, setSelectedCrane] = useState<string>();
  const craneHeld = () => {
    if (!pending.current.has('crane')) return false;
    setError('Save or discard the crane form first.');
    return true;
  };
  const selectCrane = (id: string | undefined) => {
    if (id !== selectedCrane && craneHeld()) return;
    setSelectedCrane(id);
  };
  const times = useMemo(
    () => (schedule && doc.site?.lifts?.length ? liftTimes(doc, schedule) : undefined),
    [doc, schedule],
  );
  const liftsToday: LiftOfDay[] = useMemo(() => {
    if (!times || !shown) return [];
    return (doc.site?.lifts ?? [])
      .filter((l) => times.get(l.id)?.day === shown)
      .sort((a, b) => times.get(a.id)!.order - times.get(b.id)!.order)
      .map((lift) => {
        const m = world?.mass(lift.elementId);
        return {
          lift,
          mass: !m ? '…' : 'kg' in m ? formatTonnes(m.kg) : `unknown (${m.reason})`,
        };
      });
  }, [doc, times, shown, world]);
  // Lift playback: each lift of the day in turn, 2.5 s each.
  const [play, setPlay] = useState<{ index: number; u: number }>();
  useEffect(() => setPlay(undefined), [shown, doc]);
  useEffect(() => {
    if (!play) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 2500;
      last = now;
      setPlay((p) => {
        if (!p) return p;
        const u = p.u + dt;
        if (u < 1) return { ...p, u };
        return p.index + 1 < liftsToday.length ? { index: p.index + 1, u: 0 } : undefined;
      });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [play !== undefined, liftsToday.length]);
  const current = play ? liftsToday[play.index] : undefined;
  const scene = useMemo(() => {
    if (!current || !schedule || !world || !times) return undefined;
    const crane = doc.site?.cranes?.find((c) => c.id === current.lift.craneId);
    const body = world.bodies.get(current.lift.elementId);
    const time = times.get(current.lift.id);
    if (!crane || !body || !time) return undefined;
    return { crane, ...liftScene(doc, schedule, world, current.lift, crane, body, time) };
  }, [current, doc, schedule, world, times]);
  const craneState: CraneState | undefined = scene && play ? scene.motion.at(play.u) : undefined;
  const moved =
    scene && craneState && current
      ? {
          id: current.lift.elementId,
          offset: [
            craneState.hook[0] - scene.motion.placeHook[0],
            craneState.hook[1] - scene.motion.placeHook[1],
            craneState.hook[2] - scene.motion.placeHook[2],
          ] as Point3,
        }
      : undefined;
  // During playback the day's lifts stand once lifted, and are not there yet before.
  const playLook = new Map<string, 'lifted' | 'waiting'>();
  if (play)
    liftsToday.forEach(({ lift }, i) =>
      playLook.set(
        lift.elementId,
        i < play.index ? 'lifted' : i > play.index ? 'waiting' : 'lifted',
      ),
    );
  const standingCranes = new Set(
    schedule && shown
      ? (doc.site?.cranes ?? [])
          .filter((c) => craneStands(doc, schedule, c, shown))
          .map((c) => c.id)
      : [],
  );
  const craneSolids =
    terrain && doc.site?.cranes
      ? doc.site.cranes
          .filter((c) => standingCranes.has(c.id))
          .map((c) =>
            craneSolid(
              c,
              craneBaseZ(c, (p) => terrain.heightAt(p)),
              scene?.crane.id === c.id ? craneState : undefined,
              selectedCrane === c.id,
            ),
          )
      : [];
  // CS5b: people and trucks on the shown day, at a time of that day.
  const [trafficItem, setTrafficItem] = useState<TrafficItem>();
  const [trafficEpoch, setTrafficEpoch] = useState(0);
  const reportTraffic = useCallback(
    (dirty: boolean) => markPending(pending.current, 'traffic item', dirty, changed.current),
    [],
  );
  const reportHours = useCallback(
    (dirty: boolean) => markPending(pending.current, 'site hours', dirty, changed.current),
    [],
  );
  const [hoursEpoch, setHoursEpoch] = useState(0);
  const trafficHeld = () => {
    if (!pending.current.has('traffic item')) return false;
    setError('Save or discard the route or zone form first.');
    return true;
  };
  const selectTraffic = (item: TrafficItem | undefined) => {
    if ((item?.id !== trafficItem?.id || item?.type !== trafficItem?.type) && trafficHeld()) return;
    setTrafficItem(item);
  };
  const [clock, setClock] = useState(() => (valid ? siteHours(doc)[0] : 480));
  /** Real seconds for the walkers' stride while time plays (their legs at walking pace). */
  const [gait, setGait] = useState<number>();
  // Zones and cut edges need only the ground: they are found while the building is evaluated (or
  // without one); the lifts' loads wait for its bodies.
  const hazardWorld = useMemo((): HazardWorld | undefined => {
    if (!terrain) return undefined;
    return {
      terrain,
      place: (id) => {
        const b = world?.bodies.get(id)?.bounds;
        if (!b) return undefined;
        return {
          centre: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2],
          half: [(b[1][0] - b[0][0]) / 2, (b[1][1] - b[0][1]) / 2],
        };
      },
    };
  }, [world, terrain]);
  // The derived dangers (cut edges, lifts) stand without any route or zone.
  const hasTraffic =
    !!doc.site?.routes?.length ||
    !!doc.site?.zones?.length ||
    !!doc.site?.lifts?.length ||
    !!doc.site?.earthworks.some((w) => w.kind === 'cut');
  // Hours changed under the clock: keep it within the new day.
  const [dayStart, dayEnd] = valid ? siteHours(doc) : [480, 1020];
  useEffect(() => setClock((c) => clockInDay(c, [dayStart, dayEnd])), [dayStart, dayEnd]);
  const traffic = useMemo(() => {
    if (!schedule || !shown || !hasTraffic) return undefined;
    const gates = gateCounts(doc, schedule, shown);
    const liftsPast = liftsPastDayEnd(doc, schedule).filter((o) => o.day === shown);
    return {
      day: shown,
      hazards: hazardWorld ? hazardsOnDay(doc, schedule, hazardWorld, shown) : [],
      approaches: hazardWorld ? approachesOnDay(doc, schedule, hazardWorld, shown) : [],
      trips: tripsOnDay(doc, schedule, shown),
      gates: gates.counts,
      notes: [
        ...gates.notes.map((n) => n.message),
        ...liftsPast.map(
          (o) =>
            `${o.liftIds.length} lifts do not fit in the working day and are not drawn: ${o.liftIds.join(', ')}`,
        ),
      ],
      gateNotes: gates.notes,
      liftsPast,
    };
  }, [doc, schedule, shown, hazardWorld, hasTraffic]);
  // Play time: ten times as fast, skipping the minutes when no one moves; stops at the day's end.
  useEffect(() => {
    if (gait === undefined || !traffic) return;
    const [, end] = siteHours(doc);
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = ((now - last) / 1000) * (10 / 60);
      last = now;
      setGait(now / 1000);
      setClock((c) => {
        const next = playStep(c, dt, traffic.trips, end);
        if (next.done) setGait(undefined);
        return next.clock;
      });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [gait !== undefined, traffic, doc]);
  // People and trucks stand on the ground shown for the day (cuts dug and fills made so far).
  const dayGround =
    doc.site && terrain && works
      ? (p: [number, number]) => groundOnDay(doc.site!, terrain, works.progress, p)
      : undefined;
  const trafficSolids: ViewSolid[] = [];
  if (traffic && dayGround) {
    const ground = dayGround;
    const onDay = new Set(traffic.trips.map((t) => t.routeId));
    for (const r of doc.site?.routes ?? []) {
      const chosen = trafficItem?.type === 'route' && trafficItem.id === r.id;
      if (!onDay.has(r.id) && !chosen) continue;
      const s = routeSolid(r, ground, chosen);
      if (s) trafficSolids.push(s);
    }
    for (const h of traffic.hazards) {
      const chosen = trafficItem?.type === 'zone' && trafficItem.id === h.id;
      const s = hazardSolid(h, ground, clock >= h.from && clock <= h.to, chosen);
      if (s) trafficSolids.push(s);
    }
  }
  const movers = traffic && dayGround ? moverSolids(traffic.trips, clock, dayGround, gait) : [];
  const siteWithCranes =
    siteView || craneSolids.length || trafficSolids.length || movers.length
      ? {
          solids: [...(siteView?.solids ?? []), ...craneSolids, ...trafficSolids, ...movers],
          // The movers come and go: they leave the bounds (and so the camera) alone.
          bounds: [...craneSolids, ...trafficSolids].reduce<Bounds | undefined>(
            (acc, c) => (acc ? union(acc, c.bounds) : c.bounds),
            siteView?.bounds,
          ),
        }
      : undefined;
  const boundary = doc.site?.boundary;
  const [ghost, setGhost] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [selectedTask, setSelectedTask] = useState<string>();
  /** True while the open task form has unsaved changes (and says so). */
  const taskHeld = () => {
    if (!pending.current.has('task')) return false;
    setError('Save or discard the task form first.');
    return true;
  };
  /** Another task opens only once the open task form is saved or discarded. */
  const select = (id: string | undefined) => {
    if (id !== selectedTask && taskHeld()) {
      return;
    }
    setSelectedTask(id);
  };
  const [picked, setPicked] = useState<string[]>([]);
  const task = doc.tasks.find((t) => t.id === selectedTask);
  const sourceProblems = bim ? checkConstructionSource(doc, bim) : [];
  // CS6b: the schedule with its building as IFC4, and every check as one CSV.
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState('');
  const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  /** True (and says so) while a form holds unsaved input the file would leave out. */
  const formsHeld = () => {
    if (recordingNow.current) {
      setError('A video is being recorded: wait for it, or cancel it, first.');
      return true;
    }
    if (!pending.current.size) return false;
    setError('Save or discard the open forms first: the file would leave them out.');
    return true;
  };
  const exportIfc = async () => {
    if (formsHeld()) return;
    if (!bim || !kernel || !schedule)
      return setError('The building is not loaded yet: the IFC carries it with the schedule.');
    setExporting(true);
    setExportNote('Writing the building and its schedule to IFC…');
    try {
      const r = await exportBimIfc(bim, kernel, {
        artifactId: doc.source.artifactId,
        // The schedule's own start: the same plan gives the same file.
        timeStamp: `${doc.startDate}T00:00:00`,
        fileName: `${doc.name || 'schedule'}.ifc`,
      });
      if (r.status === 'error') {
        setExportNote('');
        return setError(
          `The building could not be written to IFC: ${r.code}${r.ids.length ? ` (${r.ids.slice(0, 5).join(', ')})` : ''}`,
        );
      }
      const out = writeConstructionIfc(doc, schedule, r.file, {
        artifactId: artifactId ?? `${doc.source.artifactId}:schedule`,
      });
      download(`${doc.name || 'schedule'}.ifc`, out.text, 'application/x-step');
      setExportNote(
        `IFC written: ${doc.tasks.length} tasks, ${out.temporaryGlobalIds.size} temporary works.${out.notes.length ? ` ${out.notes.join(' ')}` : ''}`,
      );
    } catch (e) {
      // A plan without dates, or a building file the schedule cannot be added to.
      setExportNote('');
      setError(`The IFC was not written: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };
  // CS6c: a path-traced still of the day, and a video of the days played.
  const viewHandle = useRef<ViewHandle | undefined>(undefined);
  // The still being rendered: its file name, fixed when the dialog opens.
  const [rendering, setRendering] = useState<string>();
  const [video, setVideo] = useState<ScheduleVideoSettings>();
  const [recording, setRecording] = useState<{ done: number; total: number }>();
  const recordAbort = useRef<AbortController | undefined>(undefined);
  const videoProblems = video && range ? scheduleVideoProblems(range, video) : [];
  // Closing the schedule stops a recording.
  useEffect(() => () => recordAbort.current?.abort(), []);
  const recordVideo = async (settings: ScheduleVideoSettings) => {
    if (recordingNow.current || formsHeld()) return;
    if (!range) return setError("Fix the schedule's problems first: it has no days to record.");
    const problems = scheduleVideoProblems(range, settings);
    if (problems.length) return setError(problems.join(' '));
    const view = viewHandle.current;
    if (!view) return setError('The 3D view is not open.');
    // A video without the building would be only the site.
    const missing = view.unavailable();
    if (missing) return setError(missing);
    const frames = scheduleVideoFrames(settings);
    const abort = new AbortController();
    const before = day;
    recordAbort.current = abort;
    recordingNow.current = true;
    changed.current?.();
    setPlaying(false);
    // Lifts, people and trucks hold still too: their wall-clock playback would differ frame to frame.
    setPlay(undefined);
    setGait(undefined);
    setError('');
    setRecording({ done: 0, total: frames.ticks.length });
    setExportNote('');
    let last: string | undefined;
    const building = bimNow.current;
    try {
      // A building still being evaluated is waited for (it is in every frame).
      if (!view.ready()) {
        setExportNote('Waiting for the building to be drawn…');
        await waitFor(() => view.ready(), abort.signal, 600_000, 'the building was not evaluated');
        setExportNote('');
      }
      const blob = await encodeMp4(
        {
          width: settings.width,
          height: settings.height,
          fps: scheduleVideoFps,
          ticks: frames.ticks,
        },
        {
          begin: (w, h) => view.begin(w, h),
          frame: async (tick, timestamp, duration) => {
            // A building switched (or re-evaluated) under the recording would leave the
            // frames from then on without it.
            if (bimNow.current !== building || !view.ready())
              throw new Error('the building changed while recording');
            const d = frames.dayOf(tick);
            if (d !== last) {
              flushSync(() => setDay(d));
              await waitFor(
                () => !!view.drawn()?.startsWith(`${d}|`),
                abort.signal,
                30_000,
                `the 3D view did not draw ${d}`,
              );
              last = d;
            }
            return new VideoFrame(view.canvas(), { timestamp, duration });
          },
          end: () => view.end(),
        },
        browserVideoEncoding(),
        (done, total) => setRecording({ done, total }),
        abort.signal,
      );
      const name = scheduleVideoFileName(doc.name, settings);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportNote(
        `Video recorded: ${name}, ${frames.ticks.length} frames (${settings.from} to ${settings.to}).`,
      );
      setVideo(undefined);
    } catch (e) {
      if (abort.signal.aborted) setExportNote('The recording was cancelled.');
      else setError(`The video was not recorded: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      recordingNow.current = false;
      changed.current?.();
      recordAbort.current = undefined;
      setRecording(undefined);
      setDay(before);
    }
  };
  const exportChecks = () => {
    if (formsHeld()) return;
    // Checks still running would be missing from the file and read as clean.
    if ((bim && !world) || craneChecking)
      return setError(
        'The checks are still running (the building or the lifts): export them when they finish.',
      );
    const rows: CheckRow[] = [
      ...diagnosticRows('schedule', [...sourceProblems, ...(schedule?.diagnostics ?? [])]),
      ...diagnosticRows('site', [...siteProblems, ...buildingProblems]),
      ...diagnosticRows('crane', shownCraneProblems),
      ...(analysis
        ? diagnosticRows(
            'frame',
            [...analysis.stage.frame.notes, ...(analysis.completed?.frame.notes ?? [])],
            analysis.day,
          )
        : unsolved
          ? diagnosticRows('frame', unsolved.notes, unsolved.day)
          : []),
      ...(traffic
        ? [
            ...approachRows(traffic.approaches),
            ...diagnosticRows('traffic', traffic.gateNotes, traffic.day),
            ...liftOverflowRows(traffic.liftsPast),
          ]
        : []),
    ];
    download(`${doc.name || 'schedule'}-checks.csv`, writeChecksCsv(rows), 'text/csv');
    setExportNote(`Checks written: ${rows.length} row${rows.length === 1 ? '' : 's'}.`);
  };
  // Rooms (spaces) and openings are not built: the 4D view leaves them out.
  const unscheduled = bim
    ? unscheduledElements(doc, bim).filter((id) => {
        const kind = bim.elements.find((e) => e.id === id)?.kind;
        return kind && !hiddenKinds.has(kind);
      }).length
    : 0;

  // Play: one day a frame step, stopping at the end.
  useEffect(() => {
    if (!playing || !range) return;
    const timer = setInterval(() => {
      setDay((d) => {
        const next = addDays(d && d >= range.first && d < range.last ? d : range.first, 1);
        if (next >= range.last) setPlaying(false);
        return next;
      });
    }, 120);
    return () => clearInterval(timer);
  }, [playing, range?.first, range?.last]);

  return (
    <div className="construction-surface" aria-label="Construction schedule">
      <header className="construction-header">
        <div>
          <h2>{doc.name}</h2>
          <span className="construction-source">
            Building: {bim ? sourceLabel : `${sourceLabel} (not kept)`}
          </span>
        </div>
        {!readOnly && versions.length > 0 && switchVersion && (
          <label>
            Building version
            <select
              aria-label="Building version"
              value=""
              disabled={!!recording}
              onChange={async (e) => {
                // A recording draws one building throughout.
                if (recordingNow.current)
                  return setError(
                    'A video is being recorded: wait for it, or cancel it, before switching the building.',
                  );
                if (e.target.value) setError((await switchVersion(e.target.value)) ?? '');
              }}
            >
              <option value="">Switch to…</option>
              {versions.map((v) => (
                <option key={v.versionId} value={v.versionId}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {error && (
        <p className="construction-error" role="alert">
          {error}
        </p>
      )}
      <div className="construction-timeline">
        {range && shown ? (
          <>
            <button
              type="button"
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={!!recording}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            <input
              type="range"
              aria-label="Day"
              disabled={!!recording}
              min={dayIndex(range.first)}
              max={dayIndex(range.last)}
              value={dayIndex(shown)}
              onChange={(e) => {
                setPlaying(false);
                setDay(addDays(range.first, Number(e.target.value) - dayIndex(range.first)));
              }}
            />
            <input
              type="date"
              aria-label="Date"
              disabled={!!recording}
              value={shown}
              min={range.first}
              max={range.last}
              onChange={(e) => e.target.value && setDay(e.target.value)}
            />
            <label className="construction-check">
              <input type="checkbox" checked={ghost} onChange={(e) => setGhost(e.target.checked)} />
              Show unbuilt
            </label>
          </>
        ) : (
          <span>Fix the schedule's problems to see the plan.</span>
        )}
      </div>
      <div className="construction-summary" aria-label="Schedule summary">
        {schedule && (
          <span>
            {doc.tasks.length} tasks · {schedule.projectStart} – {schedule.projectFinish} ·{' '}
            {schedule.workingDays} working days
          </span>
        )}
        {site && (
          <span aria-label="Running tasks">
            Running:{' '}
            {site.running.length
              ? site.running.map((id) => doc.tasks.find((t) => t.id === id)?.name ?? id).join(', ')
              : 'none'}
          </span>
        )}
        <span className="construction-legend">
          <i style={{ background: stateLooks.building.color }} /> Building
          <i style={{ background: stateLooks.removing.color }} /> Removing
          <i style={{ background: stateLooks.temporary.color }} /> Temporary
        </span>
      </div>
      <div className="construction-actions" aria-label="Exports">
        <button type="button" disabled={!!exporting} onClick={exportIfc}>
          Export IFC
        </button>
        <button type="button" onClick={exportChecks}>
          Export checks
        </button>
        <button
          type="button"
          disabled={!!recording || !range}
          title="A path-traced still of the day in the 3D view"
          onClick={() => {
            const missing = viewHandle.current?.unavailable();
            if (missing) return setError(missing);
            if (!viewHandle.current?.ready())
              return setError(
                'The building is not drawn yet: render once its evaluation finishes.',
              );
            // Playback stops so the still shows the day (and time) its name gives.
            setPlaying(false);
            setPlay(undefined);
            setGait(undefined);
            setRendering(`${doc.name || 'schedule'}-${shown ?? ''}`);
          }}
        >
          Render image
        </button>
        <button
          type="button"
          disabled={!!recording || !range}
          aria-expanded={!!video}
          onClick={() =>
            setVideo((v) =>
              v || !range
                ? undefined
                : {
                    from: range.first,
                    to: range.last,
                    daysPerSecond: 5,
                    width: scheduleVideoSizes[0].width,
                    height: scheduleVideoSizes[0].height,
                  },
            )
          }
        >
          Record video
        </button>
        {recording && (
          <>
            <span className="construction-note" role="status" aria-label="Recording">
              Recording: {recording.done} of {recording.total} frames
            </span>
            <button type="button" onClick={() => recordAbort.current?.abort()}>
              Cancel recording
            </button>
          </>
        )}
        {exportNote && (
          <span className="construction-note" role="status" aria-label="Export status">
            {exportNote}
          </span>
        )}
      </div>
      {video && !recording && (
        <div className="construction-form" role="group" aria-label="Video">
          <Field label="From">
            <input
              type="date"
              aria-label="Video from"
              value={video.from}
              onChange={(e) => setVideo({ ...video, from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              aria-label="Video to"
              value={video.to}
              onChange={(e) => setVideo({ ...video, to: e.target.value })}
            />
          </Field>
          <Field label="Days a second">
            <select
              aria-label="Days a second"
              value={video.daysPerSecond}
              onChange={(e) => setVideo({ ...video, daysPerSecond: Number(e.target.value) })}
            >
              {scheduleVideoRates.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Size">
            <select
              aria-label="Video size"
              value={`${video.width}x${video.height}`}
              onChange={(e) => {
                const [width, height] = e.target.value.split('x').map(Number);
                setVideo({ ...video, width: width!, height: height! });
              }}
            >
              {scheduleVideoSizes.map((v) => (
                <option key={v.label} value={`${v.width}x${v.height}`}>
                  {v.label} ({v.width} × {v.height})
                </option>
              ))}
            </select>
          </Field>
          {videoProblems.map((p) => (
            <p key={p} className="construction-error">
              {p}
            </p>
          ))}
          <div className="construction-actions">
            <button
              type="button"
              disabled={videoProblems.length > 0}
              onClick={() => void recordVideo(video)}
            >
              Record
            </button>
            <button type="button" onClick={() => setVideo(undefined)}>
              Close
            </button>
          </div>
        </div>
      )}
      {(sourceProblems.length > 0 || (schedule?.diagnostics.length ?? 0) > 0) && (
        <ul className="construction-problems" aria-label="Schedule problems">
          {[...sourceProblems, ...(schedule?.diagnostics ?? [])].slice(0, 20).map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
      <div className="construction-main">
        <BuildingView
          bim={bim}
          kernel={kernel}
          look={(id) => {
            const p = playLook.get(id);
            if (p === 'lifted') return undefined;
            if (p === 'waiting') return stateLook('absent', ghost);
            const standing = site ? elementState(site, id) : undefined;
            // Coloured by the analysis: only the members that stand on the day.
            return analysedLook(
              standing,
              standing ? stateLook(standing, ghost) : undefined,
              ratioLook?.get(id),
            );
          }}
          revision={`${shown}|${ghost}|${site ? [...site.states].join() : ''}|${play ? play.index : ''}|${ratioLook ? analysis?.day : ''}`}
          site={siteWithCranes}
          moved={moved}
          onBodies={setBodies}
          boundary={boundary}
          onBuildingProblems={setBuildingProblems}
          handle={viewHandle}
          selection={picked.length || !task ? picked : task.elementIds}
          onPick={(id, add) => {
            // The site's own solids: a temporary work opens its form; the ground clears the selection.
            if (id?.startsWith(sitePickPrefix)) {
              const t = doc.site?.temporaries.find((x) => siteTemporaryId(x.id) === id);
              const c = doc.site?.cranes?.find((x) => siteCraneId(x.id) === id);
              const r = doc.site?.routes?.find((x) => siteRouteId(x.id) === id);
              const z = doc.site?.zones?.find((x) => siteHazardId(x.id) === id);
              if (t) selectSiteItem({ type: 'temporary', id: t.id });
              else if (c) selectCrane(c.id);
              else if (r) selectTraffic({ type: 'route', id: r.id });
              else if (z) selectTraffic({ type: 'zone', id: z.id });
              else if (!add) setPicked([]);
              return;
            }
            setPicked((p) =>
              !id ? [] : add ? (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]) : [id],
            );
          }}
        />
        <aside className="construction-side">
          <TaskTable
            doc={doc}
            schedule={schedule}
            selected={selectedTask}
            onSelect={(id) => select(id === selectedTask ? undefined : id)}
          />
          {!readOnly && (
            <div className="construction-actions">
              <button
                type="button"
                onClick={() => {
                  if (taskHeld()) return;
                  const id = freshConstructionId(doc, 'task');
                  const after = task ? [{ taskId: task.id, lagDays: 0 }] : [];
                  if (
                    run({
                      type: 'addTask',
                      task: {
                        id,
                        name: `Task ${doc.tasks.length + 1}`,
                        durationDays: 1,
                        predecessors: after,
                        action: 'construct',
                        elementIds: picked,
                      },
                    })
                  ) {
                    select(id);
                    setPicked([]);
                  }
                }}
              >
                Add task
              </button>
              <button
                type="button"
                disabled={!task}
                onClick={() =>
                  task && run({ type: 'removeTask', id: task.id }) && setSelectedTask(undefined)
                }
              >
                Remove task
              </button>
              <CsvButtons doc={doc} run={run} setError={setError} held={taskHeld} />
            </div>
          )}
          {task && (
            <TaskForm
              key={`${taskEpoch}|${task.id}|${JSON.stringify(task)}`}
              task={task}
              report={reportTask}
              discard={() => setTaskEpoch((n) => n + 1)}
              span={schedule?.byId.get(task.id) && taskSpan(task, schedule.byId.get(task.id)!)}
              picked={picked}
              readOnly={readOnly}
              // A save that normalizes to the stored task (`03` days) leaves the key as it was:
              // start the form again from the stored task so nothing stays pending.
              save={(t) =>
                run({ type: 'updateTask', task: t }) && (setTaskEpoch((n) => n + 1), true)
              }
            />
          )}
          <CalendarForm
            key={`${calendarEpoch}|${JSON.stringify([doc.startDate, doc.calendar])}`}
            doc={doc}
            report={reportCalendar}
            discard={() => setCalendarEpoch((n) => n + 1)}
            readOnly={readOnly}
            run={run}
          />
          <SitePanel
            doc={doc}
            volumes={volumes}
            works={works}
            day={shown}
            problems={[...siteProblems, ...buildingProblems]}
            readOnly={readOnly}
            run={run}
            setError={setError}
            selected={siteItem}
            onSelect={selectSiteItem}
            reportBoundary={reportBoundary}
            reportItem={reportSiteItem}
            boundaryEpoch={boundaryEpoch}
            itemEpoch={siteItemEpoch}
            discardBoundary={() => setBoundaryEpoch((n) => n + 1)}
            discardItem={() => setSiteItemEpoch((n) => n + 1)}
            held={siteHeld}
          />
          <CranePanel
            doc={doc}
            day={shown}
            standing={standingCranes}
            liftsToday={liftsToday}
            problems={shownCraneProblems}
            checking={craneChecking}
            readOnly={readOnly}
            run={run}
            setError={setError}
            selected={selectedCrane}
            onSelect={selectCrane}
            report={reportCrane}
            epoch={craneEpoch}
            discard={() => setCraneEpoch((n) => n + 1)}
            held={craneHeld}
            liftable={(id) => {
              const kind = bim?.elements.find((e) => e.id === id)?.kind;
              return !!kind && !hiddenKinds.has(kind);
            }}
            playing={!!play}
            onPlay={() =>
              // A recording holds the cranes still.
              recordingNow.current || setPlay((p) => (p ? undefined : { index: 0, u: 0 }))
            }
            playStatus={
              play && current
                ? `Lift ${play.index + 1} of ${liftsToday.length}: ${current.lift.elementId}`
                : ''
            }
          />
          <TrafficPanel
            doc={doc}
            day={shown}
            active={!!traffic}
            clock={clock}
            onClock={(t) => {
              if (recordingNow.current) return;
              setGait(undefined);
              setClock(t);
            }}
            playing={gait !== undefined}
            onPlay={() =>
              // A recording holds people and trucks still.
              recordingNow.current ||
              setGait((g) => (g === undefined ? performance.now() / 1000 : undefined))
            }
            approaches={traffic?.approaches ?? []}
            gates={traffic?.gates ?? []}
            notes={traffic?.notes ?? []}
            readOnly={readOnly}
            run={run}
            setError={setError}
            selected={trafficItem}
            onSelect={selectTraffic}
            report={reportTraffic}
            epoch={trafficEpoch}
            discard={() => setTrafficEpoch((n) => n + 1)}
            held={trafficHeld}
            reportHours={reportHours}
            hoursEpoch={hoursEpoch}
            discardHours={() => setHoursEpoch((n) => n + 1)}
          />
          <AnalysisPanel
            doc={doc}
            bim={bim}
            derived={derived}
            schedule={schedule}
            day={shown}
            solver={frameSolver}
            craneWorld={world}
            readOnly={readOnly}
            run={run}
            setError={setError}
            // What the view shows selected: the picked elements, or the open task's.
            picked={picked.length || !task ? picked : task.elementIds}
            onShow={setPicked}
            analysis={analysis}
            onAnalysis={setAnalysis}
            onUnsolved={setUnsolved}
            colour={colour}
            onColour={setColour}
            report={reportLoad}
            epoch={loadEpoch}
            discard={() => setLoadEpoch((n) => n + 1)}
            held={() => {
              if (!pending.current.has('site load')) return false;
              setError('Save or discard the site load form first.');
              return true;
            }}
          />
          <p className="construction-note">
            {picked.length} selected in the view · {unscheduled} elements stand throughout (no task)
          </p>
        </aside>
      </div>
      {rendering && (
        <PathRenderDialog
          name={rendering}
          // A building still being evaluated is not in the view: nothing to render yet.
          source={() =>
            viewHandle.current?.ready() && !viewHandle.current.unavailable()
              ? viewHandle.current.renderSource()
              : undefined
          }
          // A site stands outdoors: the sky and sun first, the studio on choice.
          defaultLighting="sky"
          onClose={() => setRendering(undefined)}
        />
      )}
    </div>
  );
}

/** CS6c: waits until `done` holds (`ms` at most), or the recording is cancelled. */
async function waitFor(done: () => boolean, signal: AbortSignal, ms: number, failure: string) {
  const until = Date.now() + ms;
  while (!done()) {
    if (signal.aborted) throw new Error('cancelled');
    if (Date.now() > until) throw new Error(failure);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function BuildingView({
  bim,
  kernel,
  look,
  revision,
  selection,
  onPick,
  site,
  boundary,
  onBuildingProblems,
  moved,
  onBodies,
  handle,
}: {
  bim: BimDocument | undefined;
  kernel: BimKernel | undefined;
  /** CS6c: filled with what a still or a video needs of the view while it is mounted. */
  handle?: { current: ViewHandle | undefined };
  look: (id: string) => ReturnType<typeof stateLook>;
  revision: string;
  /** CS2b: the site's solids on the day, drawn with the building. */
  site: { solids: ViewSolid[]; bounds: Bounds | undefined } | undefined;
  boundary: ConstructionSite['boundary'] | undefined;
  /** The building elements standing over the site boundary. */
  onBuildingProblems(problems: ConstructionDiagnostic[]): void;
  /** CS3b: an element drawn moved by an offset (the load on the hook). */
  moved?: { id: string; offset: Point3 };
  /** CS3b: each element's evaluated body (world bounds and triangles), for the crane checks. */
  onBodies?(
    bodies:
      | {
          bim: BimDocument;
          bodies: Map<string, LiftBody>;
          kernelQuantities: ReadonlyMap<string, Record<string, number>>;
        }
      | undefined,
  ): void;
  selection: readonly string[];
  onPick(id: string | undefined, add: boolean): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<BimViewport | undefined>(undefined);
  const pick = useRef(onPick);
  pick.current = onPick;
  const evaluator = useMemo(() => (kernel ? new BimEvaluator(kernel) : undefined), [kernel]);
  // Each result with the building it was evaluated from: a version switched to is not drawn
  // or checked with the previous version's bodies while its own evaluation runs (or fails).
  const [evaluated, setEvaluated] = useState<{
    bim: BimDocument;
    result: Extract<BimEvaluation, { status: 'ok' }>;
  }>();
  const evaluation = evaluated && evaluated.bim === bim ? evaluated.result : undefined;
  const [status, setStatus] = useState('');
  // CS6c: the revision drawn last, and whether the building is there to draw.
  const drawnRevision = useRef<string | undefined>(undefined);
  const waiting = useRef(false);
  waiting.current = !!bim && !!kernel && !evaluation;
  const noKernel = useRef(false);
  noKernel.current = !!bim && !kernel;
  useEffect(() => {
    if (!handle) return;
    handle.current = {
      renderSource: () => view.current?.renderSource(),
      drawn: () => drawnRevision.current,
      ready: () => !waiting.current,
      unavailable: () =>
        noKernel.current
          ? 'The building cannot be drawn: the geometry kernel is unavailable here.'
          : undefined,
      begin: (w, h) => {
        if (!view.current) throw new Error('The 3D view is not open.');
        view.current.beginCapture(w, h);
      },
      canvas: () => {
        if (!view.current) throw new Error('The 3D view is not open.');
        return view.current.captureCanvas();
      },
      end: () => view.current?.endCapture(),
    };
    return () => {
      handle.current = undefined;
    };
  }, [handle]);
  useEffect(() => {
    if (!host.current) return;
    const v = new BimViewport(host.current, {
      onPick: (id, add) => pick.current(id, add),
      onContextLost: () => setStatus('The 3D view was lost; reopen the schedule.'),
      isBackdrop: siteBackdrop,
    });
    view.current = v;
    return () => {
      v.dispose();
      view.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (!bim || !evaluator) return;
    let live = true;
    setStatus('Evaluating the building…');
    // One evaluator per kernel: a later call supersedes (and stops) the one still running.
    evaluator
      .evaluate(bim)
      .then((r) => {
        if (!live || r.status !== 'ok') return;
        setEvaluated({ bim, result: r });
        // Failed elements are left out of the view: say which, so the building is not read as
        // incomplete work.
        const failed = [...r.elements].flatMap(([id, e]) =>
          e.status === 'error' ? [`${id} (${e.code})`] : [],
        );
        setStatus(
          failed.length
            ? `${failed.length} element${failed.length === 1 ? '' : 's'} could not be built and ${failed.length === 1 ? 'is' : 'are'} not shown: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ' …' : ''}`
            : '',
        );
      })
      .catch((e) => live && setStatus(`The building could not be evaluated: ${String(e)}`));
    return () => {
      live = false;
    };
  }, [bim, evaluator]);
  const selected = selection.join('\u0000');
  const movedKey = moved ? `${moved.id}|${moved.offset.join()}` : '';
  const framed = useRef<string | undefined>(undefined);
  const buildingFramed = useRef(false);
  useEffect(() => {
    if (!view.current) return;
    const drawn =
      bim && evaluation
        ? bimViewSolids(bim, evaluation, { selection: new Set(selection), tint: look, hiddenKinds })
        : [];
    // The load on the hook: its instance moved with the hook.
    const building = moved
      ? drawn.map((s) =>
          s.instances.some((i) => i.path[0] === moved.id)
            ? {
                ...s,
                instances: s.instances.map((i) => {
                  if (i.path[0] !== moved.id) return i;
                  const m = [...i.matrix];
                  m[12] = m[12]! + moved.offset[0];
                  m[13] = m[13]! + moved.offset[1];
                  m[14] = m[14]! + moved.offset[2];
                  return { ...i, matrix: m };
                }),
                // Moved, its solid's bounds no longer hold: widen them by the move.
                bounds: [
                  s.bounds[0].map((x, k) => x + Math.min(0, moved.offset[k]!)),
                  s.bounds[1].map((x, k) => x + Math.max(0, moved.offset[k]!)),
                ] as Bounds,
              }
            : s,
        )
      : drawn;
    const own = bim && evaluation ? bimViewBounds(evaluation, bim) : undefined;
    const bounds = own && site?.bounds ? union(own, site.bounds) : (own ?? site?.bounds);
    // The site draws its own ground: the floor grid would show through it.
    view.current.showGrid(!site?.solids.length);
    view.current.show([...building, ...(site?.solids ?? [])], bounds);
    drawnRevision.current = revision;
    // A new boundary (the site laid out, or moved) frames the view on the whole plot again.
    const frame = JSON.stringify(boundary ?? null);
    if (framed.current !== undefined && framed.current !== frame && bounds)
      view.current.fit(bounds);
    framed.current = frame;
    // The building is evaluated after the site is first drawn: frame both once it arrives.
    if (evaluation && site?.solids.length && !buildingFramed.current && bounds) {
      view.current.fit(bounds);
      buildingFramed.current = true;
    }
    // `look` changes with `revision`.
    // `moved` is new every frame of a lift; its content is `movedKey`.
  }, [bim, evaluation, revision, selected, site, boundary, movedKey]);
  // Building elements over the boundary, from the evaluated bodies (every element as built).
  const problems = useRef(onBuildingProblems);
  problems.current = onBuildingProblems;
  const geometry = useMemo(
    () =>
      bim && evaluation
        ? elementGeometry(bimViewSolids(bim, evaluation, { selection: new Set(), hiddenKinds }))
        : undefined,
    [bim, evaluation],
  );
  useEffect(() => {
    if (!bim || !geometry || !boundary?.length) return problems.current([]);
    problems.current(
      checkBuildingInSite(
        { boundary, terrain: [], earthworks: [], temporaries: [] },
        footprints(bim, geometry),
      ),
    );
  }, [bim, geometry, boundary]);
  const bodiesOut = useRef(onBodies);
  bodiesOut.current = onBodies;
  useEffect(() => {
    if (!bim || !geometry || !evaluation) return bodiesOut.current?.(undefined);
    const bodies = new Map<string, LiftBody>();
    for (const [id, g] of geometry) bodies.set(id, { bounds: g.bounds, triangles: g.triangles });
    bodiesOut.current?.({ bim, bodies, kernelQuantities: evaluation.kernelQuantities });
  }, [bim, geometry, evaluation]);
  return (
    <div className="construction-view">
      <div ref={host} className="construction-canvas" />
      {(status || !kernel) && (
        <p className="construction-status" role="status">
          {status || 'No kernel build: the 3D view is unavailable.'}
        </p>
      )}
    </div>
  );
}

type Bounds = [[number, number, number], [number, number, number]];

interface ElementGeometry {
  /** World corners of every triangle, 9 numbers each. */
  triangles: Float64Array;
  bounds: Bounds;
}

/**
 * Each element's evaluated body in world coordinates: its meshes placed by its instances (a box
 * for a solid without meshes).
 */
function elementGeometry(solids: ViewSolid[]): Map<string, ElementGeometry> {
  const tris = new Map<string, number[]>();
  const place = (m: number[], x: number, y: number, z: number, out: number[]) =>
    out.push(
      m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
      m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
      m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    );
  for (const s of solids)
    for (const inst of s.instances) {
      const id = inst.path[0];
      if (!id) continue;
      let t = tris.get(id);
      if (!t) tris.set(id, (t = []));
      const m = inst.matrix;
      if (s.meshes?.length)
        for (const { mesh } of s.meshes) {
          const [ox, oy, oz] = mesh.origin;
          const p = mesh.positions;
          const ix = mesh.indices;
          for (let k = 0; k + 2 < ix.length; k += 3)
            for (let j = 0; j < 3; j++) {
              const v = ix[k + j]! * 3;
              place(m, ox + p[v]!, oy + p[v + 1]!, oz + p[v + 2]!, t);
            }
        }
      else {
        // A box: its 12 triangles.
        const [lo, hi] = s.bounds;
        const c = (i: number) =>
          [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]] as const;
        for (const f of [
          [0, 1, 3, 2],
          [4, 6, 7, 5],
          [0, 4, 5, 1],
          [2, 3, 7, 6],
          [0, 2, 6, 4],
          [1, 5, 7, 3],
        ])
          for (const k of [f[0]!, f[1]!, f[2]!, f[0]!, f[2]!, f[3]!]) place(m, ...c(k), t);
      }
    }
  const out = new Map<string, ElementGeometry>();
  for (const [id, t] of tris) {
    if (!t.length) continue;
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < t.length; k += 3)
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i]!, t[k + i]!);
        hi[i] = Math.max(hi[i]!, t[k + i]!);
      }
    out.set(id, { triangles: new Float64Array(t), bounds: [lo, hi] });
  }
  return out;
}

/** Each element's plan points and edges: its triangles' corners and sides, projected. */
function footprints(bim: BimDocument, geometry: Map<string, ElementGeometry>): SiteFootprint[] {
  type P = [number, number];
  return [...geometry].map(([id, g]) => {
    const points: P[] = [];
    const edges: [P, P][] = [];
    const t = g.triangles;
    for (let k = 0; k + 8 < t.length; k += 9) {
      const c: P[] = [
        [t[k]!, t[k + 1]!],
        [t[k + 3]!, t[k + 4]!],
        [t[k + 6]!, t[k + 7]!],
      ];
      points.push(...c);
      edges.push([c[0]!, c[1]!], [c[1]!, c[2]!], [c[2]!, c[0]!]);
    }
    return { id, name: bim.elements.find((e) => e.id === id)?.name, points, edges };
  });
}

function TaskTable({
  doc,
  schedule,
  selected,
  onSelect,
}: {
  doc: ConstructionDocument;
  schedule: ReturnType<typeof scheduleConstruction> | undefined;
  selected: string | undefined;
  onSelect(id: string): void;
}) {
  return (
    <div className="construction-table-wrap">
      <table className="construction-table" aria-label="Tasks">
        <thead>
          <tr>
            <th>Task</th>
            <th>Days</th>
            <th>Start</th>
            <th>Finish</th>
            <th>Float</th>
            <th>Elements</th>
          </tr>
        </thead>
        <tbody>
          {doc.tasks.map((t) => {
            const s = schedule?.byId.get(t.id);
            return (
              <tr
                key={t.id}
                className={`${s?.critical ? 'critical' : ''} ${t.id === selected ? 'selected' : ''}`}
                aria-selected={t.id === selected}
                onClick={() => onSelect(t.id)}
              >
                <td>
                  <button type="button" className="construction-link">
                    {t.name || t.id}
                  </button>
                </td>
                <td>{t.durationDays}</td>
                <td>{s?.start ?? '—'}</td>
                <td>{s?.finish ?? '—'}</td>
                <td>{s ? (s.critical ? 'critical' : s.totalFloat) : '—'}</td>
                <td>
                  {t.elementIds.length}
                  {t.action !== 'construct' ? ` ${actionLabels[t.action].toLowerCase()}` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="construction-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TaskForm({
  task,
  span,
  picked,
  readOnly,
  save,
  report,
  discard,
}: {
  report(dirty: boolean): void;
  discard(): void;
  task: ConstructionTask;
  span: { start: string; finish: string } | undefined;
  picked: string[];
  readOnly: boolean;
  save(task: ConstructionTask): boolean;
}) {
  const [name, setName] = useState(task.name);
  const [days, setDays] = useState(String(task.durationDays));
  const [links, setLinks] = useState(formatLinks(task.predecessors));
  const [action, setAction] = useState(task.action);
  const [elements, setElements] = useState(task.elementIds);
  const [actualStart, setActualStart] = useState(task.actual?.start ?? '');
  const [actualFinish, setActualFinish] = useState(task.actual?.finish ?? '');
  const [percent, setPercent] = useState(task.actual?.percent?.toString() ?? '');
  const [problem, setProblem] = useState('');
  const dirty =
    name !== task.name ||
    days !== String(task.durationDays) ||
    links !== formatLinks(task.predecessors) ||
    action !== task.action ||
    elements.join('\u0000') !== task.elementIds.join('\u0000') ||
    actualStart !== (task.actual?.start ?? '') ||
    actualFinish !== (task.actual?.finish ?? '') ||
    percent !== (task.actual?.percent?.toString() ?? '');
  useDirty(report, dirty);
  const submit = () => {
    // Unchanged links are kept as they are: an ID like `a(2)` would read back as a lag.
    const predecessors =
      links === formatLinks(task.predecessors) ? task.predecessors : parseLinks(links);
    if (typeof predecessors === 'string') return setProblem(predecessors);
    if (!/^\d+$/.test(days.trim())) return setProblem('Days must be a whole number');
    if (percent.trim() && !(Number(percent) >= 0 && Number(percent) <= 100))
      return setProblem('Percent must be 0–100');
    const actual = {
      ...(actualStart ? { start: actualStart } : {}),
      ...(actualFinish ? { finish: actualFinish } : {}),
      ...(percent.trim() ? { percent: Number(percent) } : {}),
    };
    setProblem('');
    save({
      id: task.id,
      name,
      durationDays: Number(days),
      predecessors,
      action,
      elementIds: elements,
      ...(Object.keys(actual).length ? { actual } : {}),
    });
  };
  return (
    <form
      className="construction-form"
      aria-label="Task"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>
        {task.id}
        {span && (
          <small>
            {' '}
            {span.start} – {span.finish}
          </small>
        )}
      </h3>
      <fieldset disabled={readOnly}>
        <Field label="Name">
          <input aria-label="Task name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Days">
          <input
            aria-label="Days"
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </Field>
        <Field label="After">
          <input
            aria-label="Predecessors"
            placeholder="a; b(2)"
            value={links}
            onChange={(e) => setLinks(e.target.value)}
          />
        </Field>
        <Field label="Action">
          <select
            aria-label="Action"
            value={action}
            onChange={(e) => setAction(e.target.value as ConstructionAction)}
          >
            {constructionActions.map((a) => (
              <option key={a} value={a}>
                {actionLabels[a]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Elements">
          <span className="construction-elements">
            {elements.length} elements
            <button type="button" disabled={!picked.length} onClick={() => setElements(picked)}>
              Use selection ({picked.length})
            </button>
            <button
              type="button"
              disabled={!picked.length}
              onClick={() =>
                setElements([...elements, ...picked.filter((p) => !elements.includes(p))])
              }
            >
              Add selection
            </button>
            <button type="button" disabled={!elements.length} onClick={() => setElements([])}>
              Clear
            </button>
          </span>
        </Field>
        <Field label="Actual start">
          <input
            aria-label="Actual start"
            type="date"
            value={actualStart}
            onChange={(e) => setActualStart(e.target.value)}
          />
        </Field>
        <Field label="Actual finish">
          <input
            aria-label="Actual finish"
            type="date"
            value={actualFinish}
            onChange={(e) => setActualFinish(e.target.value)}
          />
        </Field>
        <Field label="Percent">
          <input
            aria-label="Percent"
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
        </Field>
        {problem && <p role="alert">{problem}</p>}
        <button type="submit" className="primary">
          Save task
        </button>
        <button type="button" disabled={!dirty} onClick={discard}>
          Discard
        </button>
      </fieldset>
    </form>
  );
}

function CalendarForm({
  doc,
  readOnly,
  run,
  report,
  discard,
}: {
  doc: ConstructionDocument;
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  report(dirty: boolean): void;
  discard(): void;
}) {
  const [start, setStart] = useState(doc.startDate);
  const [weekdays, setWeekdays] = useState(doc.calendar.workWeekdays);
  const [holidays, setHolidays] = useState(doc.calendar.holidays.join('\n'));
  const dirty =
    start !== doc.startDate ||
    weekdays.join() !== doc.calendar.workWeekdays.join() ||
    holidays !== doc.calendar.holidays.join('\n');
  useDirty(report, dirty);
  return (
    <details className="construction-calendar">
      <summary>Calendar</summary>
      <form
        aria-label="Calendar"
        onSubmit={(e) => {
          e.preventDefault();
          const list = [...new Set(holidays.split(/\s+/).filter(Boolean))].sort();
          // Restart from the stored calendar, also when the input only normalizes to it.
          if (
            run([
              { type: 'setStartDate', startDate: start },
              { type: 'setCalendar', calendar: { workWeekdays: weekdays, holidays: list } },
            ])
          )
            discard();
        }}
      >
        <fieldset disabled={readOnly}>
          <Field label="Start">
            <input
              aria-label="Start date"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <div className="construction-weekdays" role="group" aria-label="Working days">
            {weekdayNames.map((n, d) => (
              <label key={n}>
                <input
                  type="checkbox"
                  checked={weekdays.includes(d)}
                  onChange={(e) =>
                    setWeekdays((w) =>
                      e.target.checked ? [...w, d].sort() : w.filter((x) => x !== d),
                    )
                  }
                />
                {n}
              </label>
            ))}
          </div>
          <Field label="Holidays">
            <textarea
              aria-label="Holidays"
              rows={3}
              placeholder="2027-05-03"
              value={holidays}
              onChange={(e) => setHolidays(e.target.value)}
            />
          </Field>
          <button type="submit">Set calendar</button>
          <button type="button" disabled={!dirty} onClick={discard}>
            Discard
          </button>
        </fieldset>
      </form>
    </details>
  );
}

function CsvButtons({
  doc,
  run,
  setError,
  held,
}: {
  doc: ConstructionDocument;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  setError(e: string): void;
  /** True (and says so) while an unsaved task form would be replaced or left out. */
  held(): boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => held() || input.current?.click()}>
        Import CSV
      </button>
      <input
        ref={input}
        hidden
        type="file"
        accept=".csv,text/csv"
        aria-label="Task CSV"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file || held()) return;
          const text = await file.text();
          if (held()) return;
          const r = readConstructionCsv(text);
          if (r.diagnostics.length)
            return setError(
              `The CSV was not imported: ${r.diagnostics
                .slice(0, 5)
                .map((d) => `${d.path}: ${d.message}`)
                .join('; ')}`,
            );
          run({ type: 'replaceTasks', tasks: r.tasks });
        }}
      />
      <button
        type="button"
        onClick={() => {
          // The file would leave out what the open task form shows.
          if (held()) return;
          let text: string;
          try {
            text = writeConstructionCsv(doc.tasks);
          } catch {
            return setError('A task or element ID holds ";" and cannot be written as CSV.');
          }
          const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = `${doc.name || 'schedule'}.csv`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Export CSV
      </button>
    </>
  );
}

function markPending(set: Set<string>, form: string, dirty: boolean, changed?: () => void) {
  if (set.has(form) === dirty) return;
  if (dirty) set.add(form);
  else set.delete(form);
  changed?.();
}
