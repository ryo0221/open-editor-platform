import { describe, expect, it } from 'vitest';
import {
  cosimLedSchematic,
  cosimSelfHoldBindings,
  cosimStarter,
  type CosimDocument,
  type CosimSourceRef,
} from '@editor-platform/cosim-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  ladderBlinkExample,
  ladderSelfHoldExample,
  type LadderDocument,
} from '@editor-platform/ladder-core';
import type { SchematicDocument } from '@editor-platform/schematic-core';
import { CosimController, type CosimSource } from './controller';

function source<T>(id: string, docs: T[]): CosimSource<T> {
  return {
    async list() {
      return [
        {
          artifactId: id,
          name: id,
          versions: docs.map((_, i) => ({
            versionId: `v${i + 1}`,
            label: `v${i + 1}`,
            contentHash: `h${i + 1}`,
          })),
        },
      ];
    },
    async document(ref: CosimSourceRef) {
      const d = docs[Number(ref.versionId.slice(1)) - 1];
      if (ref.artifactId !== id || !d || ref.contentHash !== `h${ref.versionId.slice(1)}`)
        throw new Error('source-missing');
      return structuredClone(d);
    },
  };
}
const ref = (artifactId: string, n: number) => ({
  artifactId,
  versionId: `v${n}`,
  contentHash: `h${n}`,
});
function make(doc: CosimDocument = cosimStarter(), canEdit = () => true) {
  const session = new EditorSession<CosimDocument>(doc);
  const ticks: (() => void)[] = [];
  const controller = new CosimController({
    session,
    canEdit,
    sources: {
      schematics: source<SchematicDocument>('sch', [
        cosimLedSchematic(330),
        cosimLedSchematic(1000),
      ]),
      ladders: source<LadderDocument>('lad', [ladderSelfHoldExample(), ladderBlinkExample()]),
    },
    every: (_ms, run) => {
      ticks.push(run);
      return () => void ticks.splice(0);
    },
  });
  const tick = (n: number) => {
    for (let k = 0; k < n; k++) ticks[0]?.();
  };
  return { session, controller, tick };
}
const led = (c: CosimController) => c.state.run.frame?.currents.d1 ?? 0;

// TS-2118: the co-simulation Surface's controller.
describe('cosim controller (TS-2118)', () => {
  it('chooses sources, binds, and runs: the button latches the LED, STOP drops it', async () => {
    const { controller, session } = make();
    expect(controller.setSource('schematic', ref('sch', 1))).toBeUndefined();
    expect(controller.setSource('ladder', ref('lad', 1))).toBeUndefined();
    await controller.load();
    expect(controller.state.loaded.nets).toEqual(expect.arrayContaining(['GPIO17', 'GPIO27']));
    // The first free input (START) and output (LAMP), each on a free net.
    expect(controller.addBinding('input')).toBeUndefined();
    expect(controller.addBinding('output')).toBeUndefined();
    const [start, lamp] = cosimSelfHoldBindings();
    // A net bound twice is refused; swap through a free net.
    expect(controller.updateBinding(0, start)).toBe('binding-duplicate');
    const spare = controller.state.loaded.nets.find((n) => !n.startsWith('GPIO'))!;
    expect(controller.updateBinding(1, { ...lamp, net: spare })).toBeUndefined();
    expect(controller.updateBinding(0, start)).toBeUndefined();
    expect(controller.updateBinding(1, lamp)).toBeUndefined();
    expect(session.content.bindings).toEqual(cosimSelfHoldBindings());
    controller.step();
    expect(led(controller)).toBeLessThan(1e-5);
    controller.press('sw1', true);
    controller.press('sw1', false);
    for (let k = 0; k < 4; k++) controller.step();
    expect(led(controller)).toBeGreaterThan(1e-3);
    expect(controller.ladderState()?.values.LAMP).toBe(true);
    // STOP is not bound: it is set by hand.
    controller.setInput('STOP', true);
    controller.step();
    controller.step();
    expect(led(controller)).toBeLessThan(1e-5);
    expect(controller.setInput('START', true)).toBe('input-value');
  });

  it('refuses edits while running or read only, and a bigger resistor gives less current', async () => {
    const doc: CosimDocument = {
      ...cosimStarter(),
      schematic: ref('sch', 1),
      ladder: ref('lad', 1),
      bindings: cosimSelfHoldBindings(),
    };
    const { controller, tick } = make(doc);
    await controller.load();
    controller.press('sw1', true);
    expect(controller.start()).toBeUndefined();
    tick(5);
    const bright = led(controller);
    expect(bright).toBeGreaterThan(1e-3);
    expect(controller.deleteBinding(0)).toBe('running');
    controller.stop();
    controller.setSource('schematic', ref('sch', 2));
    await controller.load();
    expect(controller.state.run.frame).toBeUndefined();
    controller.press('sw1', true);
    for (let k = 0; k < 5; k++) controller.step();
    expect(led(controller)).toBeGreaterThan(1e-4);
    expect(led(controller)).toBeLessThan(bright / 2);

    const ro = make(doc, () => false).controller;
    expect(ro.setName('x')).toBe('permission-denied');
  });

  it('says why it cannot run: missing versions and bad bindings', async () => {
    const { controller } = make({
      ...cosimStarter(),
      schematic: ref('sch', 9),
      ladder: ref('lad', 1),
      bindings: [{ variable: 'LAMP', net: 'GPIO27', kind: 'input' }],
    });
    await controller.load();
    expect(controller.state.loaded.errors.schematic).toBe('source-missing');
    expect(controller.step()).toBe('sources-missing');
    controller.setSource('schematic', ref('sch', 1));
    // Until the chosen version is read, nothing runs on the previous one.
    expect(controller.state.loaded.schematic).toBeUndefined();
    expect(controller.step()).toBe('loading');
    await controller.load();
    expect(controller.step()).toBe('cosim-variable');
    expect(controller.state.notice).toEqual({ code: 'cosim-variable', variable: 'LAMP' });
  });
});
