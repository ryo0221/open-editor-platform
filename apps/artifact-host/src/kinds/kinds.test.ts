import { describe, expect, it } from 'vitest';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bimSample, cadSample, referenceArtifacts } from '../model';
import { cadKernelProfile } from './kernel';
import { hostAdapters, hostDefinitions, kindLabel, readNativeArtifact } from './index';
import { surfaceFor } from './surfaces';

const local = { undo: true, nativeJson: true, shared: false };
const artifacts = [...referenceArtifacts(), cadSample(cadKernelProfile), bimSample()];

describe('Artifact Host kinds', () => {
  it('keeps the adapters this Host had before the shared definitions (capabilities, labels)', () => {
    const shape = Object.fromEntries(
      Object.entries(hostAdapters).map(([kind, adapter]) => [
        kind,
        {
          kind: adapter.kind,
          label: kindLabel(kind),
          capabilities: adapter.capabilities,
          preflight: !!adapter.preflight,
          export: !!adapter.export,
        },
      ]),
    );
    const office = (label: string | undefined, formats: string[], extra = {}) => ({
      label,
      capabilities: { ...local, formats, preview: 'none', ...extra },
      preflight: false,
      export: formats.length > 0,
    });
    expect(Object.keys(shape).sort()).toEqual([
      'analysis',
      'bim',
      'cad',
      'code',
      'data',
      'design',
      'estimate',
      'fiction-map',
      'slide',
      'whiteboard',
    ]);
    expect(shape.estimate).toMatchObject({
      ...office('見積・積算', [], { proposals: true }),
      preflight: true,
    });
    expect(shape.analysis).toMatchObject({
      ...office('計算・分析ノート', [], { proposals: true }),
      preflight: true,
    });
    expect(shape.slide).toMatchObject(office('Slide', ['svg']));
    expect(shape.whiteboard).toMatchObject(office('Whiteboard', ['svg']));
    expect(shape.design).toMatchObject(
      office('React / Design', ['react'], { preview: 'host-isolated' }),
    );
    expect(shape.code).toMatchObject(
      office('Code (Host拡張)', ['tsx'], { preview: 'host-isolated' }),
    );
    expect(shape.data).toMatchObject(office('Data / Kanban', ['csv']));
    expect(shape.cad).toMatchObject(office('3D CAD', []));
    expect(shape.bim).toMatchObject(office('Building', []));
    for (const [kind, entry] of Object.entries(shape)) expect(entry.kind).toBe(kind);
  });

  it('validates each sample with its own adapter only', () => {
    for (const artifact of artifacts)
      for (const [kind, adapter] of Object.entries(hostAdapters))
        expect(adapter.validate(artifact.draft.content), `${artifact.kind} as ${kind}`).toBe(
          kind === artifact.kind,
        );
  });

  it('refuses an unknown kind (animated decks: model.test.ts)', async () => {
    await expect(readNativeArtifact('unknown', '{}')).rejects.toThrow('Unknown artifact kind');
  });

  it('pairs one Surface with each definition and keeps Host behaviour on the kinds that had it', () => {
    const kinds = hostDefinitions.map((definition) => definition.kind);
    for (const kind of kinds)
      expect(surfaceFor(kind)?.definition).toBe(
        hostDefinitions.find((definition) => definition.kind === kind),
      );
    const having = (has: (kind: string) => boolean) => kinds.filter(has).sort();
    expect(having((kind) => !!surfaceFor(kind)?.history)).toEqual(['fiction-map']);
    expect(having((kind) => !!surfaceFor(kind)?.Tools)).toEqual(['design']);
    expect(having((kind) => !!surfaceFor(kind)?.reusable)).toEqual(['design']);
    expect(
      having((kind) => surfaceFor(kind)?.surfaceClass({ codeSurface: true }) !== 'host-surface'),
    ).toEqual(['code']);
    expect(surfaceFor('code')?.surfaceClass({ codeSurface: false })).toBe('host-surface');
    // Only a saved deck shows its first page in the list.
    const shown = (saved: boolean) =>
      artifacts
        .filter(
          (artifact) =>
            renderToStaticMarkup(
              createElement(
                Fragment,
                null,
                surfaceFor(artifact.kind)?.listPreview({
                  ...artifact,
                  versions: saved ? [{} as (typeof artifact.versions)[number]] : [],
                }),
              ),
            ) !== '',
        )
        .map((artifact) => artifact.kind);
    expect(shown(false)).toEqual([]);
    expect(shown(true)).toEqual(['slide']);
    const design = artifacts.find((artifact) => artifact.kind === 'design')!;
    expect(surfaceFor('design')?.reusePreview(design.draft.content)).toBeTruthy();
    expect(surfaceFor('design')?.reusePreview({})).toBeUndefined();
  });
});
