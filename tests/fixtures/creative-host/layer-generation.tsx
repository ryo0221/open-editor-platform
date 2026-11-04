import { createRoot } from 'react-dom/client';
import { IndexedDBStorage, type Artifact } from '@editor-platform/artifact-core';
import {
  CreativeHost,
  CreativeProject,
  characterMode,
  type CreativeLayerRequest,
} from '@editor-platform/reference-artifact-host/creative';
import { settingMode } from '@editor-platform/reference-artifact-host/creative/setting';
import { generatedPng } from './generated-png';
import type { DesignContent } from '@editor-platform/design/model';

declare global {
  interface Window {
    layerGenerationFixture: {
      snapshot(): {
        content: DesignContent;
        mapping: unknown;
        proposalCount: number;
        revision: unknown;
        canUndo: boolean;
        canRedo: boolean;
      };
      holdProvider(value: boolean): void;
      releaseProvider(index: number, outcome: 'resolve' | 'reject'): void;
      readonly settled: number;
      requests: CreativeLayerRequest[];
    };
  }
}
async function mount() {
  const artifacts = new IndexedDBStorage<Artifact<unknown>>();
  const isSetting = new URLSearchParams(location.search).has('setting');
  const mode = isSetting ? settingMode : characterMode;
  const storage = {
    artifacts,
    readMapping: async () => {
      const s = localStorage.getItem(`layer-fixture:${mode.id}`);
      return s ? JSON.parse(s) : undefined;
    },
    writeMapping: async (v: unknown) => {
      localStorage.setItem(`layer-fixture:${mode.id}`, JSON.stringify(v));
    },
  };
  // Branches keep native Data and Document generic types distinct.
  const initial = !(await storage.readMapping());
  const project = isSetting
    ? await CreativeProject.open(settingMode, storage)
    : await CreativeProject.open(characterMode, storage);
  const card = project.cards[0];
  await project.ensureDesign(card);
  if (initial) await project.save();
  const requests: CreativeLayerRequest[] = [];
  let hold = false,
    settled = 0;
  const pending = new Map<number, { resolve(): void; reject(): void }>();
  window.layerGenerationFixture = {
    snapshot: () => ({
      content: project.editor(card)!.content,
      mapping: project.mapping,
      proposalCount: project.editor(card)!.proposals.length,
      revision: project.editor(card)!.revision,
      canUndo: project.editor(card)!.canUndo,
      canRedo: project.editor(card)!.canRedo,
    }),
    holdProvider: (value) => {
      hold = value;
    },
    releaseProvider(index, outcome) {
      const entry = pending.get(index);
      if (!entry) throw Error('No pending provider call');
      pending.delete(index);
      entry[outcome]();
    },
    get settled() {
      return settled;
    },
    requests,
  };
  const generation = {
    provider: {
      async generate(request: Readonly<CreativeLayerRequest>, signal: AbortSignal) {
        if (signal.aborted) throw Error('aborted');
        const attempt = requests.length;
        requests.push(structuredClone(request));
        const value = {
          requestId: request.id,
          src: generatedPng(
            request.target.pixelWidth,
            request.target.pixelHeight,
            !request.target.transparent,
          ),
          source: `Deterministic E2E fixture (not production AI) / run-${attempt + 1}`,
          license: 'Test-only image',
        };
        try {
          // Intentionally ignore the signal: local cancellation must not depend on this Host.
          if (hold)
            return await new Promise<typeof value>((resolve, reject) =>
              pending.set(attempt, {
                resolve: () => resolve(value),
                reject: () => reject(Error('Late provider rejection')),
              }),
            );
          return value;
        } finally {
          settled++;
        }
      },
    },
  };
  const root = createRoot(document.getElementById('root')!);
  // Mode only chooses an existing consuming Host, with no new runtime or model.
  if (project.mode.id === 'setting')
    root.render(
      <CreativeHost
        project={project as CreativeProject<ReturnType<typeof settingMode.seed>>}
        generation={generation}
      />,
    );
  else
    root.render(
      <CreativeHost
        project={project as CreativeProject<ReturnType<typeof characterMode.seed>>}
        generation={generation}
      />,
    );
}
void mount();
