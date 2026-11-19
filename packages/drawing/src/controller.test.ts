import { describe, expect, it } from 'vitest';
import {
  drawingStarter,
  type DrawingDocument,
  type DrawingViewState,
} from '@editor-platform/drawing-core';
import { EditorSession } from '@editor-platform/editor-core';
import { DrawingController } from './controller';

// Codex on #1203: a derivation started for an edit since undone never replaces the graphics of
// the state undone back to.
describe('DrawingController views', () => {
  it('drops a running derivation whose key is no longer current', async () => {
    const doc: DrawingDocument = {
      ...drawingStarter(),
      sources: [
        { id: 's', kind: 'cad', artifactId: 'a', versionId: 'v', contentHash: 'h', name: 'A' },
      ],
      views: [
        {
          id: 'v1',
          sheetId: 'sheet-1',
          sourceId: 's',
          kind: 'cad-projection',
          name: 'Front',
          at: [100, 100],
          scale: '1:1',
          label: true,
          direction: 'front',
          only: [],
          hiddenLines: true,
          centerLines: true,
        },
      ],
    };
    const session = new EditorSession<DrawingDocument>(doc);
    const waiting = new Map<string, (s: DrawingViewState) => void>();
    const ready = (dir: string): DrawingViewState => ({
      status: 'ready',
      graphics: {
        items: [{ type: 'text', at: [0, 0], text: dir, heightMm: 3.5, anchor: 'start' }],
        bounds: [
          [0, 0],
          [1, 1],
        ],
      },
    });
    const controller = new DrawingController({
      session,
      canEdit: () => true,
      derive: {
        key: (_, v) => (v.kind === 'cad-projection' ? v.direction : v.id),
        run: (_, v) =>
          new Promise((r) => waiting.set(v.kind === 'cad-projection' ? v.direction : v.id, r)),
      },
    });
    waiting.get('front')!(ready('front'));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.state.views.get('v1')).toEqual(ready('front'));
    const v1 = doc.views[0]!;
    if (v1.kind !== 'cad-projection') throw new Error('fixture');
    controller.updateView({ ...v1, direction: 'top' });
    expect(controller.state.views.get('v1')).toEqual({ status: 'pending' });
    session.undo();
    controller.sync();
    expect(controller.state.views.get('v1')).toEqual(ready('front'));
    // The superseded derivation ends: nothing changes.
    waiting.get('top')!(ready('top'));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.state.views.get('v1')).toEqual(ready('front'));
  });
});
