import {
  createDesign,
  insertElement,
  updateElement,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  insertDesignPage,
  insertDesignPanel,
  setDesignPagination,
} from '@editor-platform/design/pagination';
import { contentToNode, nodeToContent } from '@editor-platform/document/engine';
import type { DocumentContent } from '@editor-platform/document/model';
export const chapterSeed = (n: number): DocumentContent => {
  const d: DocumentContent = {
    schemaVersion: 2,
    blocks: [
      { id: 'chapter-title', type: 'heading', level: 1, text: `第${n}章` },
      { id: 'scene-morning', type: 'paragraph', text: `朝の場面。第${n}章の主人公が歩く。` },
      { id: 'scene-night', type: 'paragraph', text: `夜の場面。第${n}章の物語が続く。` },
    ],
  };
  return nodeToContent(contentToNode(d), d);
};
export const authoringImage =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
export function comicSeed(): DesignContent {
  let d = createDesign();
  for (let p = 1; p <= 4; p++) {
    const x = (p - 1) * 650;
    d = insertDesignPage({ x, y: 0, width: 600, height: 800 }, `page-${p}`).apply(d);
    for (let i = 1; i <= 2; i++) {
      const y = 20 + (i - 1) * 380;
      d = insertDesignPanel(
        `page-${p}`,
        { x: x + 20, y, width: 560, height: 350 },
        `panel-${p}-${i}`,
      ).apply(d);
      d = updateElement(`panel-${p}-${i}`, { stroke: '#111111', strokeWidth: 2 }).apply(d);
      d = insertElement('shape', {
        id: `balloon-${p}-${i}`,
        parentId: `panel-${p}-${i}`,
        bounds: { x: x + 40, y: y + 25, width: 350, height: 100 },
      }).apply(d);
      d = updateElement(`balloon-${p}-${i}`, {
        shape: 'ellipse',
        fill: '#ffffff',
        stroke: '#111111',
        strokeWidth: 2,
      }).apply(d);
      d = insertElement('text', {
        id: `dialogue-${p}-${i}`,
        parentId: `panel-${p}-${i}`,
        bounds: { x: x + 70, y: y + 45, width: 300, height: 60 },
      }).apply(d);
      d = updateElement(`dialogue-${p}-${i}`, {
        text: `Page ${p}, panel ${i}`,
        fill: '#111111',
      }).apply(d);
    }
  }
  d = insertElement('image', {
    id: 'material',
    src: authoringImage,
    parentId: 'panel-1-1',
    bounds: { x: 60, y: 180, width: 140, height: 120 },
  }).apply(d);
  return setDesignPagination({
    ...d.pagination!,
    images: [
      { elementId: 'material', source: 'Locally authored one-pixel fixture', license: 'CC0-1.0' },
    ],
  }).apply(d);
}
