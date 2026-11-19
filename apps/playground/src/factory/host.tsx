import { useEffect, useMemo, useRef, useState } from 'react';
import { WorkerBimKernel } from '@editor-platform/bim';
import KernelWorker from '@editor-platform/bim/worker?worker';
import { bimContentHash } from '@editor-platform/bim-core';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  FactoryController,
  FactorySurface,
  factoryExperimentWorkerRunner,
  factoryWorkerRunner,
  type FactoryBuildingBinding,
  type FactoryLookView,
  type FactoryLooksBinding,
} from '@editor-platform/factory';
import { cadContentHash, type CadDocument } from '@editor-platform/cad-core';
import '@editor-platform/factory/style.css';
import '@editor-platform/ladder/style.css';
import type { FactoryDocument } from '@editor-platform/factory-core';
import type { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { cadKernel, type StoredArtifact } from '../model';
import { factorySourceChoices, factorySourceOf, stageFactorySource } from './source';
import { factoryLookChoices, stageFactoryLook } from './looks';
import { CharacterPropEvaluation } from '../character/props';

/**
 * Playground binding for the factory Surface (FT2). An edit is one session command applied at
 * once; the Host saves the draft afterwards and owns Undo/Redo.
 */
export default function FactoryHost({
  artifact,
  session,
  readOnly,
  inputs,
  record,
  records,
  persist,
  persistRecord,
}: {
  artifact: StoredArtifact;
  session: EditorSession<FactoryDocument>;
  readOnly: boolean;
  inputs: EditorInputs;
  record(): StoredArtifact | undefined;
  /** Every stored record: names the Building versions the factory may stand in (FT4a). */
  records(): StoredArtifact[];
  persist(content: FactoryDocument): void;
  /** Saves the whole record (a Building version is kept before the edit names it). */
  persistRecord(record: StoredArtifact): Promise<boolean>;
}) {
  const [, setTick] = useState(0);
  // The latest Building choice: one still being kept when another is made is dropped.
  const choosing = useRef(0);
  // A Building version still being kept with the record: export and switch wait for it.
  const keeping = useRef(false);
  // FT4c: the latest look choice per object, and the looks still being kept (by object).
  const lookTurns = useRef(new Map<string, number>());
  const lookKeeping = useRef(new Set<string>());
  const closed = useRef(false);
  const access = useRef(readOnly);
  access.current = readOnly;
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const applied = useRef<string | undefined>(undefined);
  const controller = useMemo(
    () =>
      new FactoryController({
        session,
        canEdit: () => !access.current,
        runner: factoryWorkerRunner,
        experimentRunner: factoryExperimentWorkerRunner,
        onApplied: (content) => {
          applied.current = canonicalJson(session.revision);
          persistRef.current(content);
        },
      }),
    // One controller per artifact: the Surface is keyed by it (editor-surfaces).
    [session],
  );
  useEffect(() => controller.accessChanged(), [controller, readOnly]);
  // Edits apply at once, so nothing is pending for the Host's export and switch boundaries.
  useEffect(
    () =>
      inputs.register({
        label: 'Factory',
        read: () => ({
          dirty: keeping.current || lookKeeping.current.size > 0,
          composing: false,
          settles: true,
        }),
        prepare: () => {
          if (keeping.current)
            throw new Error('The Building version is still being kept with this factory.');
          if (lookKeeping.current.size)
            throw new Error('A CAD version is still being kept with this factory.');
          return () => {};
        },
        focus: () => {},
      }),
    [inputs],
  );
  // A choice still being kept when the factory closes never applies afterwards.
  useEffect(
    () => () => {
      choosing.current++;
      keeping.current = false;
      closed.current = true;
      lookKeeping.current.clear();
    },
    [],
  );
  // Host Undo/Redo or restore changed the session: show it.
  const revision = canonicalJson(session.revision);
  useEffect(() => {
    if (revision !== applied.current) controller.sync();
  }, [controller, revision]);
  // FT4b: the building's own BIM kernel Worker (the Host's build), started when first drawn.
  const kernel = useMemo(
    () =>
      cadKernel
        ? new WorkerBimKernel({ spawn: () => new KernelWorker() as never, build: cadKernel })
        : undefined,
    [],
  );
  useEffect(() => () => kernel?.dispose(), [kernel]);
  const doc = session.content;
  const choices = factorySourceChoices(records());
  const key = (artifactId: string, versionId: string) => `${artifactId}:${versionId}`;
  const current = doc.building
    ? choices.find(
        (c) =>
          key(c.artifactId, c.versionId) === key(doc.building!.artifactId, doc.building!.versionId),
      )
    : undefined;
  const building: FactoryBuildingBinding = {
    bim: factorySourceOf(record(), doc),
    kernel,
    label: doc.building ? (current?.label ?? 'A saved Building version') : undefined,
    // The version set now shows as the current option, not again among the others.
    choices: choices
      .filter((c) => c !== current)
      .map((c) => ({ key: key(c.artifactId, c.versionId), label: c.label })),
    async choose(k) {
      if (readOnly) return 'This factory is read-only.';
      const turn = ++choosing.current;
      // An earlier choice still being kept no longer holds export back: this one stands.
      if (keeping.current) {
        keeping.current = false;
        inputs.changed();
      }
      if (!k) {
        return doc.building ? controller.apply({ type: 'setBuilding', building: null }) : undefined;
      }
      const c = choices.find((x) => key(x.artifactId, x.versionId) === k);
      const latest = record();
      if (!c || !latest) return 'That Building version is no longer stored.';
      const staged = stageFactorySource(latest, c.content);
      if (staged !== latest) {
        keeping.current = true;
        inputs.changed();
        let kept: boolean;
        try {
          kept = await persistRecord(staged);
        } finally {
          if (turn === choosing.current) {
            keeping.current = false;
            inputs.changed();
          }
        }
        if (!kept)
          return turn === choosing.current
            ? 'The Building version could not be kept with this factory.'
            : undefined;
      }
      // Another choice was made while this version was being kept: that one stands.
      if (turn !== choosing.current) return undefined;
      const failed = controller.apply({
        type: 'setBuilding',
        building: {
          artifactId: c.artifactId,
          versionId: c.versionId,
          contentHash: bimContentHash(c.content),
        },
      });
      setTick((t) => t + 1);
      return failed;
    },
  };
  // FT4c: one read-only CAD evaluation per look version placed, released when none places it.
  const evaluations = useRef(new Map<string, CharacterPropEvaluation>());
  const lookViews = useRef(new Map<string, { revision: number; view: FactoryLookView }>());
  const [lookRevision, setLookRevision] = useState(0);
  const placedLooks = [
    ...new Set(doc.objects.flatMap((o) => (o.look ? [o.look.contentHash] : []))),
  ].join(',');
  useEffect(() => {
    const live = evaluations.current;
    const want = new Set(placedLooks ? placedLooks.split(',') : []);
    for (const [hash, e] of live)
      if (!want.has(hash)) {
        e.dispose();
        live.delete(hash);
        // Its drawn meshes go with it.
        lookViews.current.delete(hash);
      }
    const kept = (h: string) => record()?.factoryLooks?.find((p) => p.contentHash === h)?.content;
    for (const hash of want) {
      if (live.has(hash)) continue;
      const content = kept(hash);
      if (content)
        live.set(
          hash,
          new CharacterPropEvaluation(content, kept, () => setLookRevision((n) => n + 1)),
        );
    }
    setLookRevision((n) => n + 1);
    // `record` reads the latest stored record.
  }, [placedLooks]);
  useEffect(
    () => () => {
      for (const e of evaluations.current.values()) e.dispose();
      evaluations.current.clear();
    },
    [],
  );
  const lookChoices = factoryLookChoices(records());
  const looks: FactoryLooksBinding = {
    choices: lookChoices.map((c) => ({ key: key(c.artifactId, c.versionId), label: c.label })),
    label: (look) =>
      lookChoices.find((c) => c.artifactId === look.artifactId && c.versionId === look.versionId)
        ?.label,
    revision: lookRevision,
    view(hash) {
      const e = evaluations.current.get(hash);
      if (!e) return { status: 'failed', message: 'look-missing' };
      const cached = lookViews.current.get(hash);
      if (cached?.revision === lookRevision) return cached.view;
      const v = e.view;
      const view: FactoryLookView =
        v.status === 'ready'
          ? {
              status: 'ready',
              meshes: v.draw(new Map()).map((i) => ({
                positions: i.mesh.positions,
                normals: i.mesh.normals,
                indices: i.mesh.indices,
                color: i.mesh.color,
                opacity: i.mesh.opacity,
                ...(i.mesh.sheet ? { sheet: true } : {}),
                matrix: i.matrix,
              })),
            }
          : v;
      lookViews.current.set(hash, { revision: lookRevision, view });
      return view;
    },
    async choose(objectId, k) {
      if (readOnly) return 'This factory is read-only.';
      // The latest choice for this object stands: one still being kept when another is made is
      // dropped (and no longer holds export back).
      const turn = (lookTurns.current.get(objectId) ?? 0) + 1;
      lookTurns.current.set(objectId, turn);
      if (lookKeeping.current.delete(objectId)) inputs.changed();
      const current = () => !closed.current && lookTurns.current.get(objectId) === turn;
      const o = session.content.objects.find((x) => x.id === objectId);
      if (!o) return 'That object is no longer in the factory.';
      if (!k) {
        if (!o.look) return undefined;
        const { look: _, ...rest } = o;
        return controller.updateObject(rest);
      }
      const c = lookChoices.find((x) => key(x.artifactId, x.versionId) === k);
      const source = records().find((r) => r.id === c?.artifactId);
      const latest = record();
      if (!c || !source || !latest) return 'That CAD version is no longer stored.';
      let staged;
      try {
        staged = stageFactoryLook(latest, source, c.content as CadDocument);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      if (staged !== latest) {
        lookKeeping.current.add(objectId);
        inputs.changed();
        let kept: boolean;
        try {
          kept = await persistRecord(staged);
        } finally {
          if (current()) {
            lookKeeping.current.delete(objectId);
            inputs.changed();
          }
        }
        if (!current()) return undefined;
        if (!kept) return 'The CAD version could not be kept with this factory.';
      }
      const now = session.content.objects.find((x) => x.id === objectId);
      if (!now) return 'That object is no longer in the factory.';
      return controller.updateObject({
        ...now,
        look: {
          artifactId: c.artifactId,
          versionId: c.versionId,
          contentHash: cadContentHash(c.content as CadDocument),
        },
      });
    },
  };
  return (
    <FactorySurface
      controller={controller}
      hostHistory
      name={artifact.name}
      building={building}
      looks={looks}
    />
  );
}
