import { describe, expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import {
  createDesign,
  designDrawingProjector,
  designPaintOrder,
  makeDesignElement,
  type DesignComponent,
  type DesignContent,
  type DesignElement,
} from './model';
import { diagnoseDesignPrototype, startDesignPrototype } from './prototype';
import { collectScopedTexts } from './view-panels';

/** About 110 frames, 20k elements, 89 part components and 31 flows in a large screen fixture. */
function largeDesign(): DesignContent {
  const frames = 110,
    leaves = 165,
    instances = 15;
  const styles = Array.from({ length: 20 }, (_, i) => ({
    id: `style-${i}`,
    name: `Style ${i}`,
    appearance: { fill: `#${(i * 99999).toString(16).padStart(6, '0').slice(0, 6)}` },
  }));
  const components: DesignComponent[] = Array.from({ length: 89 }, (_, i) => ({
    id: `component-${i}`,
    name: `Component ${i}`,
    width: 160,
    height: 48,
    template: { type: 'rectangle', text: '', fill: '#eeeeee' },
    elements: [
      { ...makeDesignElement('group'), id: 'root', name: 'Root', bounds: box(0, 0, 160, 48) },
      {
        ...makeDesignElement('rectangle'),
        id: 'surface',
        name: 'Surface',
        parentId: 'root',
        styleId: `style-${i % 20}`,
        bounds: box(0, 0, 160, 48),
      },
      {
        ...makeDesignElement('text'),
        id: 'label',
        name: 'Label',
        parentId: 'root',
        text: `Label ${i}`,
        bounds: box(8, 8, 144, 32),
      },
    ],
  }));
  const elements: DesignElement[] = [];
  for (let f = 0; f < frames; f++) {
    const id = `frame-${f}`;
    elements.push({
      ...makeDesignElement('frame'),
      id,
      name: id,
      bounds: box(f * 1400, 0, 1280, 800),
      clipContent: true,
    });
    for (let l = 0; l < leaves; l++)
      elements.push({
        ...makeDesignElement(l % 3 ? 'rectangle' : 'text'),
        id: `${id}/leaf-${l}`,
        name: `Leaf ${l}`,
        parentId: id,
        styleId: l % 4 ? undefined : `style-${l % 20}`,
        bounds: box(f * 1400 + (l % 15) * 80, Math.floor(l / 15) * 60, 72, 48),
      });
    for (let n = 0; n < instances; n++)
      elements.push({
        ...makeDesignElement('rectangle'),
        type: 'instance',
        text: '',
        id: `${id}/instance-${n}`,
        name: `Instance ${n}`,
        parentId: id,
        componentId: `component-${(f + n) % 89}`,
        bounds: box(f * 1400 + n * 80, 700, 160, 48),
        interactions:
          n === 0 && f + 1 < frames
            ? [{ trigger: 'click', action: { type: 'navigate', frameId: `frame-${f + 1}` } }]
            : undefined,
      });
  }
  const flows = Array.from({ length: 31 }, (_, i) => ({
    id: `flow-${i}`,
    name: `Flow ${i}`,
    frameIds: [0, 1, 2, 3].map((step) => `frame-${i * 3 + step}`),
  }));
  return {
    ...createDesign(),
    elements,
    components,
    styles,
    prototyping: { schemaVersion: 1, flows },
  };
}
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe('large Design (#384)', () => {
  it('diagnoses prototype flows and projects component text without re-reading the document', () => {
    const content = deepFreeze(largeDesign());
    expect(content.elements.length).toBeGreaterThan(19000);
    const started = performance.now();
    const diagnostics = diagnoseDesignPrototype(content);
    const texts = collectScopedTexts(content, designDrawingProjector(content));
    const elapsed = performance.now() - started;
    expect(diagnostics).toEqual([]);
    expect(texts.size).toBe(110 * 15 * 2);
    // Before #384 this took about 50 s here (a paint traversal per frame lookup
    // and per instance); with per-content lookups it takes well under 1 s.
    expect(elapsed).toBeLessThan(3000);
  });

  it('reads mutable Host content again while frozen content shares one paint order', () => {
    const mutable = largeDesign();
    const frame = mutable.elements.find((e) => e.id === 'frame-5')!;
    expect(designPaintOrder(mutable).find((e) => e.id === 'frame-5')?.hidden).toBeFalsy();
    expect(startDesignPrototype(mutable, { frameId: 'frame-5' }).frameId).toBe('frame-5');
    frame.styleId = 'hidden';
    mutable.styles!.push({ id: 'hidden', name: 'Hidden', appearance: { hidden: true } });
    expect(designPaintOrder(mutable).find((e) => e.id === 'frame-5')?.hidden).toBe(true);
    expect(() => startDesignPrototype(mutable, { frameId: 'frame-5' })).toThrow(/visible/);
    expect(diagnoseDesignPrototype(mutable)).toContainEqual(
      expect.objectContaining({
        code: 'missing-frame',
        message: expect.stringContaining('frame-5'),
      }),
    );

    const frozen = deepFreeze(largeDesign());
    expect(designPaintOrder(frozen)).toBe(designPaintOrder(frozen));
    expect(Object.isFrozen(designPaintOrder(frozen))).toBe(true);
    expect(designPaintOrder({ ...frozen })).toEqual(designPaintOrder(frozen));
  });
});
