import { describe, expect, it } from 'vitest';
import { bimDrawingLimits } from '@editor-platform/bim-core';
import type { DrawingBimFraming } from '@editor-platform/drawing-core';
import { bimDrawingState } from './bim-limits';

// DW5b (Codex on #1238): a framing plan, frame or elevation made by the Host keeps the building
// editor's drawing limits. ST-711, TS-2436.
const view: DrawingBimFraming = {
  id: 'view-1',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  kind: 'bim-framing',
  name: '2F 伏図',
  at: [0, 0],
  scale: '1:100',
  label: true,
  levelId: 'l-2f',
};
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    type: 'line' as const,
    a: [i, 0] as [number, number],
    b: [i, 1] as [number, number],
    cls: 'member',
  }));

describe('building drawings made by the Host', () => {
  it('refuses one past the building editor’s limit', () => {
    const d = (n: number) => ({
      viewId: 'f',
      kind: 'plan' as const,
      name: 'f',
      scale: 100 as const,
      items: lines(n),
      failed: [],
    });
    expect(bimDrawingState(view, d(10)).status).toBe('ready');
    expect(bimDrawingState(view, d(bimDrawingLimits.primitives + 1))).toEqual({
      status: 'failed',
      code: 'drawing-too-large',
    });
  });
});
