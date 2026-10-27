import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { bimContentHash, f31BoxBuilding, type BimDocument } from '@editor-platform/bim-core';
import { EditorSession } from '@editor-platform/editor-core';
import type { OcModule } from '@editor-platform/geometry-kernel-occt';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { BimController } from './controller';
import { bimDirectKernel, type BimKernel } from './evaluate';
import { createBimKernelHost } from './kernel-host';
import type { BimWorkerResponse } from './protocol';
import { bimViewSolids } from './view';

/** The controller and the Worker's kernel host (R2c-3c), against the development build. */
const dist = process.env.CAD_OCCT_DIST;
const settled = (c: BimController) =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (!c.state.evaluating && c.state.evaluatedHash === c.state.hash) {
        stop();
        resolve();
      }
    };
    const stop = c.subscribe(check);
    check();
  });

describe('bim controller (R2c-3c)', () => {
  /** A kernel that never answers: the controller's edits must not wait for it. */
  const silent: BimKernel = { run: () => new Promise(() => {}) };

  it('applies an edit at once, saves it, and refuses one that breaks the building', () => {
    const session = new EditorSession<BimDocument>(f31BoxBuilding());
    const saved: BimDocument[] = [];
    const c = new BimController({
      session,
      kernel: silent,
      canEdit: () => true,
      onApplied: (d) => saved.push(d),
    });
    const wall = c.state.content.elements.find((e) => e.id === 'w-south')!;
    expect(c.updateElement({ ...wall, name: 'South' })).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(session.content.elements.find((e) => e.id === 'w-south')!.name).toBe('South');
    expect(c.state.hash).toBe(bimContentHash(session.content));
    // A window outside its wall: refused, named, nothing saved.
    const win = c.state.content.elements.find((e) => e.id === 'win-e1')!;
    expect(c.updateElement({ ...win, alongMm: 50_000 } as typeof win)).toBe('opening-outside-host');
    expect(c.state.notice).toMatchObject({ code: 'opening-outside-host', ids: ['win-e1'] });
    expect(saved).toHaveLength(1);
    // A delete something depends on names the dependents.
    expect(c.apply({ type: 'delete', ids: ['w-east'], cascade: false })).toBe('in-use');
    expect(c.state.notice!.ids).toContain('win-e1');
    // The refusal names what it refused on which content; another selection drops it.
    expect(c.state.notice!.delete).toEqual({ ids: ['w-east'], hash: c.state.hash });
    c.select(['w-north']);
    expect(c.state.notice).toBeUndefined();
  });

  it('refuses every edit without authority and follows the Host history', () => {
    let editable = false;
    const session = new EditorSession<BimDocument>(f31BoxBuilding());
    const c = new BimController({ session, kernel: silent, canEdit: () => editable });
    expect(c.state.readOnly).toBe(true);
    const wall = c.state.content.elements.find((e) => e.id === 'w-south')!;
    expect(c.updateElement({ ...wall, name: 'x' })).toBe('permission-denied');
    editable = true;
    c.accessChanged();
    expect(c.state.readOnly).toBe(false);
    c.select(['w-south', 'missing']);
    expect(c.state.selection).toEqual(['w-south']);
    c.apply({ type: 'delete', ids: ['w-south'], cascade: true });
    expect(c.state.selection).toEqual([]);
    session.undo();
    c.sync();
    expect(c.state.content.elements.some((e) => e.id === 'w-south')).toBe(true);
  });
});

describe.skipIf(!dist)(
  'bim controller and Worker host with the kernel',
  { timeout: 60_000 },
  () => {
    let oc: OcModule;
    beforeAll(async () => {
      globalThis.require ??= createRequire(import.meta.url);
      const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
      oc = await factory({ wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`) });
    }, 120_000);

    it('evaluates after each edit and draws shared solids as instances', async () => {
      const session = new EditorSession<BimDocument>(f31BoxBuilding());
      const c = new BimController({ session, kernel: bimDirectKernel(oc), canEdit: () => true });
      await settled(c);
      const windows = c.state.content.elements.filter((e) => e.kind === 'window');
      const solids = bimViewSolids(c.state.content, c.state.evaluation, {
        selection: new Set(['win-n1']),
      });
      const shared = solids.find((s) => s.instances.some((i) => i.path[0] === 'win-n1'))!;
      expect(shared.instances).toHaveLength(windows.length);
      expect(shared.instances.find((i) => i.path[0] === 'win-n1')!.selected).toBe(true);
      const t = c.state.content.types.find((x) => x.id === 't-window-1800')!;
      c.apply({ type: 'update', collection: 'types', entity: { ...t, widthMm: 1200 } as typeof t });
      await settled(c);
      expect(c.state.evaluation!.sent.solids).toBe(3);
    });

    it('runs a batch in the Worker host and stops it on cancel', async () => {
      const posted: BimWorkerResponse[] = [];
      let release: (() => void) | undefined;
      const handle = createBimKernelHost({
        load: async () => oc,
        post: (m) => posted.push(m),
        yieldTask: () => new Promise<void>((r) => (release = r)),
      });
      await handle({
        type: 'init',
        build: { buildHash: 'sha256:00', moduleUrl: '', wasmUrl: '' },
      });
      expect(posted.at(-1)).toEqual({ type: 'ready', buildHash: 'sha256:00' });
      const graph = {
        nodes: {
          a: {
            op: 'prism' as const,
            frame: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] },
            outer: [
              [0, 0],
              [1000, 0],
              [1000, 1000],
              [0, 1000],
            ],
            holes: [],
            vector: [0, 0, 500],
          },
        },
      };
      const run = handle({
        type: 'run',
        requestId: 'r1',
        graph: graph as never,
        requests: [{ node: 'a', measure: true }],
        assets: {},
      });
      // The job waits at its first cancel point: a cancel there stops it.
      await new Promise((r) => setTimeout(r, 0));
      await handle({ type: 'cancel', requestId: 'r1' });
      release?.();
      await run;
      expect(posted.at(-1)).toEqual({ type: 'cancelled', requestId: 'r1' });
      // Without a cancel it answers with the measure.
      const again = handle({
        type: 'run',
        requestId: 'r2',
        graph: graph as never,
        requests: [{ node: 'a', measure: true }],
        assets: {},
      });
      for (let i = 0; i < 10 && posted.at(-1)?.type !== 'result'; i++) {
        await new Promise((r) => setTimeout(r, 0));
        release?.();
      }
      await again;
      const result = posted.at(-1)!;
      expect(result.type).toBe('result');
      if (result.type === 'result' && result.evaluation.status === 'ok') {
        const r = result.evaluation.results[0]!;
        expect(r.status === 'ok' && r.measure!.volumeMm3).toBeCloseTo(1000 * 1000 * 500, 3);
      } else throw new Error('expected a result');
    });
  },
);
