import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contentHash } from '@editor-platform/artifact-core';
import type { LiveReference } from '@editor-platform/artifact-references';
import {
  normalizeDocumentLiveSnapshots,
  type BlockType,
  type DocumentBlock,
  type DocumentContent,
} from '@editor-platform/document/model';
import { EditorSession } from '@editor-platform/editor-core';
import { slideExportRenderer } from './export-drawing';
import { slidePdfPoses } from './export-playback';
import { slideUnknownFields } from './fields';
import { prepareSlideDocument } from './from-document';
import { SlideObjectDrawing } from './live-references';
import {
  createDeck,
  isDeck,
  slideLiveReference,
  slideMotionCommand,
  slideMotionState,
  type SlideEffect,
} from './model';

const block = (
  id: string,
  type: BlockType,
  text = '',
  extra: Partial<DocumentBlock> = {},
): DocumentBlock => ({ id, type, text, ...extra });
const doc = (...blocks: DocumentBlock[]): DocumentContent => ({ schemaVersion: 2, blocks });
const heading = block('h', 'heading', 'Plan');
async function quote(
  kind: 'value' | 'figure',
  format: Extract<LiveReference['presentation'], { kind: 'value' }>['format'] = {
    style: 'decimal',
    digits: 1,
    unit: '円',
    scale: 3,
  },
): Promise<LiveReference> {
  const content = { value: 1500 };
  return {
    schemaVersion: 2,
    mode: 'fixed',
    source: {
      artifactId: 'source',
      domain: 'test',
      target:
        kind === 'value'
          ? { kind, targetId: 'row', metricId: 'value' }
          : { kind, figureId: 'chart' },
    },
    snapshot: {
      artifactId: 'source',
      domain: 'test',
      versionId: 'saved',
      revision: 1,
      content,
      contentHash: await contentHash(content),
      dependencies: [],
    },
    presentation: kind === 'value' ? { kind, value: 1500, format } : { kind, label: 'Sales chart' },
  };
}

describe('Document to Slide', () => {
  it('keeps visible heading order, text runs, list marks and exact fixed quotations', async () => {
    const value = await quote('value');
    const figure = await quote('figure');
    const source = doc(
      block('skip', 'paragraph', 'hidden', { hidden: true }),
      block('h', 'heading', 'ignored', { rich: [{ text: 'Plan' }, { text: ' A', bold: true }] }),
      block('p', 'paragraph', '', {
        rich: [
          { text: 'Before ' },
          { text: 'the quote: ' },
          { text: '1.5円', liveQuote: { id: 'q', reference: value } },
          { text: ' after' },
        ],
      }),
      block('list', 'numbered-list', 'ignored', {
        start: 3,
        items: [
          {
            id: 'one',
            rich: [{ text: 'Third' }],
            childLists: [
              {
                id: 'nested',
                type: 'bullet_list',
                check: true,
                items: [{ id: 'sub', checked: true, rich: [{ text: 'Checked' }] }],
              },
            ],
          },
          { id: 'two', rich: [{ text: 'Fourth' }] },
        ],
      }),
      block('figure', 'image', '', { liveFigure: figure }),
      block('hidden-heading', 'heading', 'Ignore', { hidden: true }),
      block('h2', 'heading', 'Later', { level: 3 }),
      block('legacy', 'bulleted-list', 'Alpha\nBeta'),
    );
    const result = prepareSlideDocument(source);
    expect(isDeck(result.content)).toBe(true);
    expect(result.content).toMatchObject({ width: 960, height: 540 });
    expect(result.pages.map((page) => page.title)).toEqual(['Plan A', 'Later']);
    const [first, second] = result.pages;
    expect(first.objects.map(({ text }) => text)).toEqual([
      'Plan A',
      'Before the quote: ',
      '1.5円',
      ' after',
      '3. Third',
      '☑ Checked',
      '4. Fourth',
      '',
    ]);
    expect(first.objects[5].bounds.x).toBeGreaterThan(first.objects[4].bounds.x);
    expect(first.objects[2]).toMatchObject({ type: 'text', liveQuote: value });
    expect(first.objects[7]).toMatchObject({ type: 'image', liveQuote: figure });
    expect(second.objects.map(({ text }) => text)).toEqual(['Later', '• Alpha', '• Beta']);
    expect(result.pages.every((page) => !page.steps && !page.transition)).toBe(true);
  });

  it('reads citations a document stores packed and stores the new deck packed', async () => {
    const value = { ...(await quote('value')), schemaVersion: 3 as const };
    const figure = { ...(await quote('figure')), schemaVersion: 3 as const };
    const packed = normalizeDocumentLiveSnapshots(
      doc(
        heading,
        block('p', 'paragraph', '', {
          rich: [{ text: '1.5円', liveQuote: { id: 'q', reference: value } }],
        }),
        block('figure', 'image', '', { liveFigure: figure }),
      ),
    );
    expect(Object.keys(packed.liveSnapshots ?? {})).toHaveLength(1);
    const result = prepareSlideDocument(packed);
    const [page] = result.pages;
    expect(page.objects[1]).toMatchObject({ type: 'text', text: '1.5円', liveQuote: value });
    expect(page.objects[2]).toMatchObject({ type: 'image', liveQuote: figure });
    expect(Object.keys(result.content.liveSnapshots ?? {})).toHaveLength(1);
    const [stored] = result.content.slides;
    expect(slideLiveReference(result.content, stored.objects[1].liveQuote!)).toEqual(value);
    expect(slideLiveReference(result.content, stored.objects[2].liveQuote!)).toEqual(figure);
  });

  it('preserves a fixed value format through conversion, presentation drawing and PDF rendering', async () => {
    const reference = await quote('value', { style: 'decimal', digits: 1, unit: '' });
    const result = prepareSlideDocument(
      doc(
        heading,
        block('p', 'paragraph', '', {
          rich: [{ text: '1500.0', liveQuote: { id: 'q', reference } }],
        }),
      ),
    );
    const [page] = result.pages;
    const quotation = page.objects[1];
    expect(quotation).toMatchObject({ type: 'text', text: '1500.0', liveQuote: reference });

    const format = { style: 'decimal', digits: 0, grouping: true, unit: '億' };
    const effect = {
      id: 'effect',
      targetId: quotation.id,
      phase: 'enter',
      effect: 'fade',
      trigger: 'on-click',
      durationMs: 200,
      delayMs: 0,
      format,
    } satisfies SlideEffect & { format: typeof format };
    const animatedPage = { ...page, steps: [{ id: 'step', effects: [effect] }] };
    const content = {
      ...result.content,
      schemaVersion: 3 as const,
      slides: [animatedPage],
      exportSettings: {
        pdf: { pageMode: 'steps' as const, format },
        mp4: { defaultHoldSeconds: 1, format },
      },
    };
    expect(slideUnknownFields(content).map(({ path }) => path)).toEqual([
      'exportSettings.pdf.format',
      'exportSettings.mp4.format',
      'slides[0].steps[0].effects[0].format',
    ]);
    expect(slideMotionState(content, animatedPage, 1).get(quotation.id)?.visible).toBe(true);
    const presentation = renderToStaticMarkup(
      createElement(
        'svg',
        null,
        createElement(SlideObjectDrawing, {
          object: quotation,
          editing: {
            content,
            slide: animatedPage,
            ids: [],
            readOnly: true,
            apply: () => false,
            choose: () => {},
            setError: () => {},
          },
        }),
      ),
    );
    expect(presentation).toContain('>1500.0<');
    expect(presentation).not.toContain('1,500億');

    const [before, after] = slidePdfPoses(content, content.exportSettings.pdf.pageMode).map(
      slideExportRenderer(content).pdf,
    );
    expect(before).not.toContain('>1500.0<');
    expect(after).toContain('>1500.0<');
    expect(after).not.toContain('1,500億');
  });

  it('appends every page once and restores the same IDs through one Undo and Redo', () => {
    const deck = slideMotionCommand({
      type: 'slide.export.pdf.page-mode',
      pageMode: 'steps',
    }).apply(createDeck());
    const custom = { ...deck, width: 800 };
    const plan = prepareSlideDocument(doc(heading, block('h2', 'heading', 'Second')), custom);
    const session = new EditorSession(custom);
    expect(session.execute(plan.append!)).toEqual(plan.content);
    expect(session.content).toMatchObject({
      width: 800,
      schemaVersion: 3,
      exportSettings: deck.exportSettings,
    });
    expect(session.content.slides[0]).toEqual(deck.slides[0]);
    expect(() => session.execute(plan.append!)).toThrow('追加先');
    expect(session.undo()).toEqual(custom);
    expect(session.redo()).toEqual(plan.content);
    expect(() => plan.append!.apply({ ...custom, height: 400 })).toThrow('内容が変わりました');
  });

  it('reports the source location and rejects the whole conversion for invalid or excessive content', () => {
    const table = block('table', 'table', '', { cells: [['Data']] });
    expect(() => prepareSlideDocument({ schemaVersion: 3, blocks: [] })).toThrow('Document の版');
    expect(() =>
      prepareSlideDocument(doc(block('hidden', 'heading', '', { hidden: true }))),
    ).toThrow('見出しがありません');
    expect(() => prepareSlideDocument(doc(block('p', 'paragraph', 'Preamble'), heading))).toThrow(
      '1 件目',
    );
    expect(() => prepareSlideDocument(doc(heading, table))).toThrow(/2 件目.*変換できません/);
    expect(() =>
      prepareSlideDocument(
        doc(...Array.from({ length: 101 }, (_, i) => block(`h${i}`, 'heading', 'Title'))),
      ),
    ).toThrow(/101 件目.*100 枚/);
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `i${i}`,
      rich: [{ text: 'Item' }],
    }));
    expect(() =>
      prepareSlideDocument(doc(heading, block('list', 'bulleted-list', '', { items }))),
    ).toThrow(/2 件目.*100 件/);
    expect(() => prepareSlideDocument(doc(...Array(2001).fill(heading)))).toThrow('2,000 件');
    expect(() =>
      prepareSlideDocument(doc(heading, block('large', 'paragraph', '日'.repeat(2_796_203)))),
    ).toThrow('8 MiB');
  });
});
