import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type { CanvasTarget } from './index';
import { stageDrag, type StageDragContext } from './stage-input';
import { canObjectTransform, createDrag, selectionHandles } from './stage-model';

class Capture {
  captured = new Set<number>();
  setPointerCapture = vi.fn((id: number) => this.captured.add(id));
  hasPointerCapture = (id: number) => this.captured.has(id);
  releasePointerCapture = vi.fn((id: number) => this.captured.delete(id));
  closest = () => null;
  focus = vi.fn();
}
beforeEach(() => vi.stubGlobal('Element', Capture));
afterEach(() => vi.unstubAllGlobals());
const target = (id = 'a'): CanvasTarget => ({
  id,
  label: id,
  bounds: { x: 10, y: 10, width: 100, height: 80 },
});
function harness() {
  const capture = new Capture();
  let context: StageDragContext = {
    drag: { current: null },
    svg: { current: capture as unknown as SVGSVGElement },
    spatial: { current: undefined },
    readOnly: false,
    inputOwner: 'object',
    targets: [target()],
    selected: ['a'],
    view: { zoom: 1, pan: { x: 0, y: 0 }, fit: false, panMode: false, snap: false, grid: false },
    world: (e) => ({ x: e.clientX, y: e.clientY }),
    setView: vi.fn(),
    setPreview: vi.fn(),
    setMarquee: vi.fn(),
    setGuides: vi.fn(),
    setPath: vi.fn(),
    onSelect: vi.fn(),
    onTransform: vi.fn(),
  };
  const lifecycle = stageDrag(() => context);
  let stamp = 0;
  const event = (x = 110, y = 90, id = 1) =>
    ({
      clientX: x,
      clientY: y,
      pointerId: id,
      timeStamp: ++stamp,
      shiftKey: false,
      altKey: false,
      target: capture,
      currentTarget: capture,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }) as unknown as React.PointerEvent;
  return {
    capture,
    lifecycle,
    event,
    get c() {
      return context;
    },
    update: (values: Partial<StageDragContext>) => {
      context = { ...context, ...values };
    },
    begin: (mode = 'resize', handle = 'se') => lifecycle.begin(event(), mode, ['a'], handle),
  };
}

describe('whole-selection object capabilities', () => {
  it('requires all IDs to resolve, and applies only the actual mode capability', () => {
    const a = target(),
      b = { ...target('b'), resizable: false };
    for (const ids of [[], ['missing'], ['a', 'missing'], ['a', 'b']])
      expect(canObjectTransform([a, b], ids, 'resize')).toBe(false);
    expect(canObjectTransform([a, b], ['a'], 'resize')).toBe(true);
    for (const resizable of [undefined, true, false])
      for (const rotatable of [true, false]) {
        const t = { ...a, resizable, rotatable };
        expect(canObjectTransform([t], ['a'], 'resize')).toBe(resizable !== false);
        expect(canObjectTransform([t], ['a'], 'rotate')).toBe(rotatable);
        expect(canObjectTransform([t], ['a'], 'move')).toBe(true);
      }
    expect(
      canObjectTransform(
        [
          { ...a, resizable: true },
          { ...b, resizable: true },
        ],
        ['a', 'b'],
        'resize',
      ),
    ).toBe(true);
  });
  it('uses selectedRoots for bounds but checks every selected ID; ignores unselected descendants', () => {
    const parent = {
      ...target('parent'),
      bounds: { x: 0, y: 0, width: 200, height: 200 },
      container: true,
    };
    const child = { ...target('child'), parentId: 'parent', resizable: false };
    expect(canObjectTransform([parent, child], ['parent'], 'resize')).toBe(true);
    expect(canObjectTransform([parent, child], ['parent', 'child'], 'resize')).toBe(false);
    const d = createDrag([parent, { ...child, resizable: true }], {
      mode: 'resize',
      ids: ['parent', 'child'],
      handle: 'e',
      client: { x: 200, y: 100 },
      point: { x: 200, y: 100 },
      view: harness().c.view,
      shift: false,
    });
    expect(d.box).toEqual(parent.bounds);
    expect(canObjectTransform([{ ...parent, resizable: false }, child], ['parent'], 'resize')).toBe(
      false,
    );
  });
});

describe('shared object lifecycle / R2-a', () => {
  for (const handle of selectionHandles)
    it(`permits and commits ${handle}, rejects false in a fresh state`, () => {
      const h = harness();
      h.begin('resize', handle);
      h.lifecycle.move(h.event(140, 120));
      expect(h.c.setPreview).toHaveBeenCalled();
      h.lifecycle.move(h.event(140, 120), true);
      expect(h.c.onTransform).toHaveBeenCalledTimes(1);
      expect(h.capture.releasePointerCapture).toHaveBeenCalledTimes(1);
      const denied = harness();
      denied.c.targets[0].resizable = false;
      denied.begin('resize', handle);
      denied.lifecycle.move(denied.event(140, 120));
      denied.lifecycle.move(denied.event(140, 120), true);
      expect(denied.c.onTransform).not.toHaveBeenCalled();
      expect(denied.c.setPreview).not.toHaveBeenCalled();
      expect(denied.capture.setPointerCapture).not.toHaveBeenCalled();
    });
  it.each(['resizable', 'locked', 'readOnly', 'deleted', 'point', 'hidden'])(
    'cancels nonempty preview immediately on %s, once',
    (reason) => {
      const h = harness();
      h.begin();
      h.lifecycle.move(h.event(140, 120));
      expect(h.c.setPreview).toHaveBeenLastCalledWith(expect.any(Map));
      if (reason === 'resizable') h.c.targets[0].resizable = false;
      if (reason === 'locked') h.c.targets[0].locked = true;
      if (reason === 'hidden') h.c.targets[0].hidden = true;
      if (reason === 'readOnly') h.update({ readOnly: true });
      if (reason === 'deleted') h.update({ targets: [] });
      if (reason === 'point') h.update({ inputOwner: 'point' });
      h.lifecycle.invalidateObject();
      h.lifecycle.invalidateObject();
      expect(h.c.drag.current).toBeNull();
      expect(h.c.setPreview).toHaveBeenLastCalledWith(undefined);
      expect(h.capture.releasePointerCapture).toHaveBeenCalledTimes(1);
      h.update({ targets: [target()], readOnly: false, inputOwner: 'object' });
      h.lifecycle.move(h.event(150, 130));
      h.lifecycle.move(h.event(150, 130), true);
      expect(h.c.onTransform).not.toHaveBeenCalled();
    },
  );
  it('guards stale handlers at preview/commit without relying on an effect or nonzero dw/dh', () => {
    const h = harness();
    h.begin('resize', 'e');
    h.c.targets[0].resizable = false;
    h.lifecycle.move(h.event(110, 120)); // zero horizontal resize delta; still resize mode.
    expect(h.c.setPreview).toHaveBeenLastCalledWith(undefined);
    expect(h.c.drag.current).toBeNull();
    const next = harness();
    next.begin();
    next.lifecycle.move(next.event(140, 120));
    next.update({ readOnly: true });
    next.lifecycle.move(next.event(140, 120), true);
    expect(next.c.onTransform).not.toHaveBeenCalled();
  });
  it('checks after a reentrant preview callback before installing its stale map', () => {
    const h = harness();
    h.update({
      previewTransform: () => {
        h.update({ readOnly: true });
        return new Map([['a', { bounds: { x: 99, y: 99, width: 100, height: 80 }, rotation: 0 }]]);
      },
    });
    h.begin();
    h.lifecycle.move(h.event(140, 120));
    expect(h.c.setPreview).toHaveBeenCalledTimes(1);
    expect(h.c.setPreview).toHaveBeenCalledWith(undefined);
    expect(h.c.drag.current).toBeNull();
  });
  it('rechecks prerequisites and callbacks after capture release, and detaches before commit', () => {
    const h = harness();
    h.begin();
    h.capture.releasePointerCapture.mockImplementation((id) => {
      h.capture.captured.delete(id);
      h.update({ readOnly: true });
      return true;
    });
    h.lifecycle.move(h.event(140, 120), true);
    expect(h.c.onTransform).not.toHaveBeenCalled();
    const next = harness(),
      latest = vi.fn(() => expect(next.c.drag.current).toBeNull());
    next.begin();
    next.update({ onTransform: latest });
    next.lifecycle.move(next.event(140, 120), true);
    expect(latest).toHaveBeenCalledTimes(1);
    next.lifecycle.move(next.event(140, 120), true);
    expect(latest).toHaveBeenCalledTimes(1);
  });
  it('does not cancel a valid gesture for fresh targets or camera props, ignores another pointer', () => {
    const h = harness();
    h.begin();
    h.update({ targets: [target()], view: { ...h.c.view, pan: { x: 2, y: 4 } } });
    h.lifecycle.invalidateObject();
    h.lifecycle.move(h.event(140, 120, 2), true);
    expect(h.c.drag.current).not.toBeNull();
    h.lifecycle.move(h.event(140, 120), true);
    expect(h.c.onTransform).toHaveBeenCalledTimes(1);
  });
  it('disposes capture without callbacks/state updates and ignores a late lostcapture after reacquisition', () => {
    const h = harness();
    h.begin();
    h.lifecycle.lostCapture(h.event());
    expect(h.c.drag.current).not.toBeNull();
    h.lifecycle.dispose();
    expect(h.capture.releasePointerCapture).toHaveBeenCalledTimes(1);
    expect(h.c.setPreview).not.toHaveBeenCalled();
    h.lifecycle.move(h.event(140, 120), true);
    expect(h.c.onTransform).not.toHaveBeenCalled();
  });
});

describe('object revision / R2-b and combined invalidation', () => {
  it.each(['move', 'resize', 'rotate'])(
    'cancels nonempty %s preview before any further event',
    (mode) => {
      const h = harness();
      h.update({ objectRevision: 'session-1:0' });
      h.begin(mode);
      h.lifecycle.move(h.event(140, 120));
      expect(h.c.setPreview).toHaveBeenLastCalledWith(expect.any(Map));
      h.update({ objectRevision: 'session-2:0' });
      h.lifecycle.invalidateObject();
      expect(h.c.drag.current).toBeNull();
      expect(h.c.setPreview).toHaveBeenLastCalledWith(undefined);
      h.update({ objectRevision: 'session-1:0' });
      h.lifecycle.move(h.event(150, 130));
      h.lifecycle.move(h.event(150, 130), true);
      expect(h.c.onTransform).not.toHaveBeenCalled();
      expect(h.capture.releasePointerCapture).toHaveBeenCalledTimes(1);
    },
  );
  it.each([undefined, NaN, 'revision', 4])(
    'preserves Object.is stable token %s despite new targets/callbacks/camera',
    (token) => {
      const h = harness();
      h.update({ objectRevision: token });
      h.begin();
      h.lifecycle.move(h.event(130, 110));
      const commit = vi.fn();
      h.update({
        objectRevision: token,
        targets: [target()],
        onTransform: commit,
        view: { ...h.c.view, pan: { x: 9, y: 8 } },
      });
      h.lifecycle.invalidateObject();
      expect(h.c.drag.current).not.toBeNull();
      h.lifecycle.move(h.event(140, 120), true);
      expect(commit).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [undefined, 'new'],
    ['old', undefined],
    [-0, 0],
    [{ id: 1 }, { id: 1 }],
  ])('invalidates changed/withdrawn/reenabled opaque identity', (before, after) => {
    const h = harness();
    h.update({ objectRevision: before });
    h.begin();
    h.lifecycle.move(h.event(130, 110));
    h.update({ objectRevision: after });
    h.lifecycle.invalidateObject();
    h.update({ objectRevision: before });
    h.lifecycle.invalidateObject();
    h.lifecycle.move(h.event(140, 120), true);
    expect(h.c.onTransform).not.toHaveBeenCalled();
    expect(h.capture.releasePointerCapture).toHaveBeenCalledTimes(1);
  });
  it('rejects before preview/commit, after preview callback, and after capture release even without effects', () => {
    const h = harness();
    h.update({ objectRevision: 0 });
    h.begin();
    h.update({ objectRevision: 1 });
    h.lifecycle.move(h.event(140, 120), true);
    expect(h.c.onTransform).not.toHaveBeenCalled();
    const p = harness();
    p.update({
      objectRevision: 0,
      previewTransform: () => {
        p.update({ objectRevision: 1 });
        return new Map();
      },
    });
    p.begin();
    p.lifecycle.move(p.event(140, 120));
    expect(p.c.setPreview).toHaveBeenCalledTimes(1);
    expect(p.c.setPreview).toHaveBeenLastCalledWith(undefined);
    const r = harness();
    r.update({ objectRevision: 0 });
    r.begin();
    r.capture.releasePointerCapture.mockImplementation((id) => {
      r.capture.captured.delete(id);
      r.update({ objectRevision: 1 });
      return true;
    });
    r.lifecycle.move(r.event(140, 120), true);
    expect(r.c.onTransform).not.toHaveBeenCalled();
  });
  it.each(['simultaneous', 'cap-first', 'revision-first'])(
    'shares one cleanup on %s invalidation and reentrant rerender',
    (order) => {
      const h = harness();
      h.update({ objectRevision: 0 });
      h.begin();
      h.lifecycle.move(h.event(130, 110));
      const preview = vi.mocked(h.c.setPreview);
      preview.mockClear();
      preview.mockImplementationOnce(() => {
        h.update({ targets: [{ ...target(), resizable: false }], objectRevision: 2 });
        h.lifecycle.invalidateObject();
      });
      if (order !== 'revision-first') h.c.targets[0].resizable = false;
      if (order !== 'cap-first') h.update({ objectRevision: 1 });
      h.lifecycle.invalidateObject();
      h.update({ targets: [{ ...target(), resizable: false }], objectRevision: 2 });
      h.lifecycle.invalidateObject();
      expect(preview).toHaveBeenCalledTimes(1);
      expect(h.capture.releasePointerCapture).toHaveBeenCalledTimes(1);
      expect(h.c.onTransform).not.toHaveBeenCalled();
    },
  );
  it('detaches once before a successful command advances revision and retains a new gesture', () => {
    const h = harness();
    h.update({
      objectRevision: 0,
      onTransform: vi.fn(() => {
        h.update({ objectRevision: 1 });
        h.lifecycle.invalidateObject();
        h.begin('move');
      }),
    });
    h.begin();
    h.lifecycle.move(h.event(130, 110));
    h.lifecycle.move(h.event(140, 120), true);
    expect(h.c.onTransform).toHaveBeenCalledTimes(1);
    expect(h.c.drag.current?.mode).toBe('move');
    expect(h.capture.releasePointerCapture).toHaveBeenCalledTimes(1);
  });
  it('ignores a delayed old event after a new pointerdown, even with the same pointer ID', () => {
    const h = harness();
    h.update({ objectRevision: 0 });
    h.begin();
    const oldUp = h.event(140, 120);
    h.update({ objectRevision: 1 });
    h.lifecycle.invalidateObject();
    h.begin();
    h.lifecycle.move(oldUp, true);
    expect(h.c.drag.current).not.toBeNull();
    expect(h.c.onTransform).not.toHaveBeenCalled();
    h.lifecycle.move(h.event(145, 125), true);
    expect(h.c.onTransform).toHaveBeenCalledTimes(1);
  });
  it('does not broaden revision invalidation to pan, pen, marquee or insert', () => {
    for (const mode of ['pan', 'pen', 'marquee', 'insert']) {
      const h = harness();
      h.update({ objectRevision: 0 });
      h.lifecycle.begin(h.event(), mode, []);
      h.update({ objectRevision: 1 });
      h.lifecycle.invalidateObject();
      expect(h.c.drag.current?.mode).toBe(mode);
      h.lifecycle.dispose();
    }
  });
});

it('retains the existing recoverable gesture after a transient domain preview rejection', () => {
  const h = harness();
  const preview = vi
    .fn()
    .mockImplementationOnce(() => {
      throw Error('temporary domain constraint');
    })
    .mockReturnValue(new Map());
  h.update({ previewTransform: preview });
  h.begin();
  h.lifecycle.move(h.event(130, 110));
  expect(h.c.drag.current).not.toBeNull();
  h.lifecycle.move(h.event(140, 120));
  expect(preview).toHaveBeenCalledTimes(2);
  h.lifecycle.move(h.event(140, 120), true);
  expect(h.c.onTransform).toHaveBeenCalledTimes(1);
});

it('rechecks resize permission after releasing a replaced gesture at pointerdown', () => {
  const h = harness();
  h.begin('move');
  h.capture.releasePointerCapture.mockImplementation((id) => {
    h.capture.captured.delete(id);
    h.update({ targets: [{ ...target(), resizable: false }] });
    return true;
  });
  h.begin('resize');
  expect(h.c.drag.current).toBeNull();
  expect(h.capture.setPointerCapture).toHaveBeenCalledTimes(1);
  h.lifecycle.move(h.event(140, 120), true);
  expect(h.c.onTransform).not.toHaveBeenCalled();
});

it('snapshots the current token after replacing an old gesture', () => {
  const h = harness();
  h.update({ objectRevision: 0 });
  h.begin('move');
  h.capture.releasePointerCapture.mockImplementation((id) => {
    h.capture.captured.delete(id);
    h.update({ objectRevision: 1 });
    return true;
  });
  h.begin('resize');
  expect(h.c.drag.current?.objectRevision).toBe(1);
  h.lifecycle.invalidateObject();
  h.lifecycle.move(h.event(140, 120), true);
  expect(h.c.onTransform).toHaveBeenCalledTimes(1);
});

it('does not overwrite a new gesture begun by a reentrant capture-release callback', () => {
  const h = harness();
  h.begin('move');
  h.capture.releasePointerCapture.mockImplementationOnce((id) => {
    h.capture.captured.delete(id);
    h.begin('move');
    h.lifecycle.move(h.event(140, 120));
    return true;
  });
  h.begin('resize');
  expect(h.c.drag.current?.mode).toBe('move');
  expect(h.capture.setPointerCapture).toHaveBeenCalledTimes(2);
  expect(h.c.setPreview).toHaveBeenLastCalledWith(expect.any(Map));
});
