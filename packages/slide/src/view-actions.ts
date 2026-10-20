import { newId } from '@editor-platform/artifact-core';
import { readImage } from '@editor-platform/canvas-ui';
import { flushSync } from 'react-dom';
import { command, unionBounds, type Bounds, type EditorInputs } from '@editor-platform/editor-core';
import {
  arrangeObjects,
  copiedObjects,
  insertObject,
  insertSlideLayout,
  pasteObjects,
  transformObjects,
  type SlideContent,
  type SlideInsertType,
  type SlideLayout,
  type SlideObject,
} from './model';
import type { SlideEditing } from './view-shared';
import type { SlideObjectPatch } from './view-toolbar';
/** Insert, clipboard, arrange and geometry actions on the current slide's selection. */
export function objectActions(
  editing: SlideEditing,
  chosen: SlideObject[],
  clipboard: { current: SlideObject[] },
) {
  const { content, slide, ids, readOnly, apply, choose, setError } = editing;
  function add(type: SlideInsertType, patch: SlideObjectPatch = {}) {
    if (!slide || readOnly) return;
    const id = newId('object');
    apply(
      insertObject(slide.id, type, {
        id,
        bounds: {
          x: content.width / 2 - 130,
          y: content.height / 2 - 80,
          width: 260,
          height: type === 'text' ? 80 : 160,
        },
        ...patch,
      }),
    );
    choose([id]);
  }
  async function image(file: File, bounds?: Bounds) {
    try {
      add('image', { src: await readImage(file), alt: file.name, ...(bounds ? { bounds } : {}) });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function action(action: string, value?: number) {
    if (!slide) return;
    if (action === 'copy' || action === 'cut') {
      // Copy pastes offset once; cut pastes back in place.
      clipboard.current = copiedObjects(slide, ids, action === 'cut' ? 0 : 20);
      if (action === 'cut') apply(arrangeObjects(slide.id, ids, 'delete'));
      return;
    }
    if (action === 'paste') {
      if (!clipboard.current.length) {
        setError('Copy elements in this editor first.');
        return;
      }
      apply(pasteObjects(slide.id, clipboard.current));
      return;
    }
    apply(arrangeObjects(slide.id, ids, action, value));
  }
  function geometry(patch: Partial<Bounds>) {
    if (!slide) return;
    const box = unionBounds(chosen.map((o) => o.bounds));
    apply(
      transformObjects(slide.id, ids, {
        dx: patch.x === undefined ? 0 : patch.x - box.x,
        dy: patch.y === undefined ? 0 : patch.y - box.y,
        dw: patch.width === undefined ? 0 : patch.width - box.width,
        dh: patch.height === undefined ? 0 : patch.height - box.height,
      }),
    );
  }
  return { add, image, action, geometry };
}
/** Input flushing, slide navigation and slide insertion. */
export function pageActions(
  editing: SlideEditing,
  inputs: EditorInputs | undefined,
  currentContent: () => SlideContent,
  setActiveId: (id: string) => void,
) {
  const { content, readOnly, apply, choose, setError } = editing;
  function flushSlideInputs() {
    try {
      inputs?.flush();
      return true;
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
      return false;
    }
  }
  function navigate(n: number) {
    if (!flushSlideInputs()) return false;
    const target = content.slides[Math.max(0, Math.min(content.slides.length - 1, n))];
    if (target) {
      setActiveId(target.id);
      choose([]);
      document.getElementById(`thumb-${target.id}`)?.scrollIntoView({ block: 'nearest' });
    }
    return !!target;
  }
  function addSlide(layout: SlideLayout) {
    let ready = false;
    flushSync(() => {
      ready = flushSlideInputs();
    });
    if (!ready || readOnly) return;
    const added = insertSlideLayout(layout).apply(currentContent()).slides.at(-1)!;
    if (
      apply(
        command(layout === 'blank' ? 'slide.insert' : 'slide.layout', 'Add slide', (content) => ({
          ...content,
          slides: [...content.slides, added],
        })),
      )
    ) {
      setActiveId(added.id);
      choose([]);
    }
  }
  return { flushSlideInputs, navigate, addSlide };
}
