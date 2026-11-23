import { canonicalJson } from '@editor-platform/artifact-core';
import {
  projectLiveFigure,
  referenceManifest,
  type ReferenceResolver,
} from '@editor-platform/artifact-references';
import type { LiveReferenceConnection } from '@editor-platform/artifact-references/react';
import type { EditorInputs } from '@editor-platform/editor-core';
import { exportPages, type PdfExportLifecycle } from '@editor-platform/canvas-ui';
import {
  defaultSlidePdfPageMode,
  exportSlideSvg,
  slideLiveReference,
  slidePaintOrder,
  slidePlaybackPages,
  type Slide,
  type SlideContent,
  type SlideExportSettings,
  type SlideObject,
  type SlidePdfPageMode,
} from './model';
import {
  planSlideMp4,
  sampledVideoPoses,
  slideMp4Refusal,
  slidePdfPoses,
  visiblePoseObjects,
} from './export-playback';
import { slideExportRenderer } from './export-drawing';
import { slideAnimationPoster } from './animation-poster';

export interface SlideExportState {
  content: SlideContent;
  slide: Slide | undefined;
  pages: string[];
  references?: ReferenceResolver;
  liveReferences?: LiveReferenceConnection;
}
type ExportState = { readonly current: SlideExportState };
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
export type SlideOutput =
  | { format: 'svg' | 'png'; scope: string; scale: number }
  | { format: 'pdf'; pageMode?: SlidePdfPageMode; scale?: number }
  | { format: 'mp4'; settings?: SlideExportSettings['mp4'] };

function assertCurrent(state: ExportState, initial: SlideExportState, inputs?: EditorInputs) {
  if (
    state.current.references !== initial.references ||
    state.current.liveReferences !== initial.liveReferences
  )
    throw Error('書き出し中に参照接続が変わりました。再実行してください。');
  if (
    state.current.content !== initial.content ||
    inputs?.getSnapshot().dirty ||
    inputs?.getSnapshot().composing
  )
    throw Error('書き出し中に入力が変わりました。再実行してください。');
}

function exportManifest(deck: SlideContent, objects: SlideObject[], includeLive: boolean) {
  const references = referenceManifest(objects);
  const quotes = includeLive
    ? objects.flatMap(({ liveQuote }) => {
        if (!liveQuote) return [];
        const { source, mode, snapshot } = slideLiveReference(deck, liveQuote);
        const { versionId, revision, contentHash, dependencies } = snapshot;
        return [
          {
            source,
            mode,
            versionId,
            revision,
            contentHash,
            dependencies: dependencies.map(({ id, contentHash }) => ({ id, contentHash })),
          },
        ];
      })
    : [];
  const sources = [...(references?.sources ?? []), ...quotes];
  return sources.length ? canonicalJson({ schemaVersion: 1, sources }) : undefined;
}

/** The rasterized SVG needs self-contained images. Load remote images through CORS once. */
async function inlineImage(src: string, signal?: AbortSignal) {
  const response = await fetch(src, { credentials: 'omit', signal });
  if (!response.ok) throw Error('画像を取得できません。');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw Error('画像形式を確認できません。');
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(Error('画像を読み込めません。'));
    reader.readAsDataURL(blob);
  });
}

async function captureObjects(
  objects: ReadonlySet<SlideObject>,
  initial: SlideExportState,
  raster: boolean,
  signal?: AbortSignal,
) {
  const embedded = [...objects].filter(({ reference }) => reference);
  if (embedded.length && !initial.references) throw Error('参照付きの出力には参照接続が必要です。');
  const captured = embedded.length ? await initial.references!.capture(embedded) : [];
  const replacements = new Map(embedded.map((object, index) => [object, captured[index]]));
  if (!raster) return replacements;
  const images = new Map<string, string>();
  for (const object of objects) {
    signal?.throwIfAborted();
    let drawing = replacements.get(object) ?? object;
    const quote = object.liveQuote && slideLiveReference(initial.content, object.liveQuote);
    if (quote?.presentation.kind === 'figure') {
      try {
        const connection = initial.liveReferences;
        if (!connection) throw Error('固定版の図の参照接続がありません。');
        drawing = {
          ...drawing,
          src: await projectLiveFigure(
            quote,
            connection.provider,
            connection.destinationArtifactId,
          ),
          alt: quote.presentation.label,
        };
      } catch (error) {
        throw Error(
          `${quote.presentation.label}（${quote.source.artifactId} / ${quote.snapshot.versionId}）の固定版の図を取得できません。 ${errorMessage(error)}`,
        );
      }
    }
    if (drawing.type === 'animation' && drawing.animation) {
      const poster = slideAnimationPoster(drawing.animation);
      if (poster.status !== 'ready')
        throw Error(`${drawing.animation.label} の静止画を描画できません。 ${poster.message}`);
      drawing = {
        ...drawing,
        type: 'image',
        animation: undefined,
        src: poster.src,
        imageFit: 'fit',
      };
    }
    const { src } = drawing;
    if (src && drawing.type === 'image' && !src.startsWith('data:')) {
      try {
        let inline = images.get(src);
        if (!inline) {
          inline = await inlineImage(src, signal);
          images.set(src, inline);
        }
        drawing = { ...drawing, src: inline };
      } catch (error) {
        signal?.throwIfAborted();
        throw Error(`${drawing.alt || drawing.id} の画像を取得できません。 ${errorMessage(error)}`);
      }
    }
    if (drawing !== object) replacements.set(object, drawing);
  }
  return replacements;
}

function visualPages(initial: SlideExportState, scope: string) {
  if (scope === 'all') return initial.content.slides;
  if (scope === 'selected')
    return initial.content.slides.filter(({ id }) => initial.pages.includes(id));
  return initial.content.slides.filter(({ id }) => id === initial.slide?.id);
}

export async function exportSlides(
  state: ExportState,
  inputs: EditorInputs | undefined,
  output: SlideOutput,
  lifecycle: PdfExportLifecycle = {},
) {
  const initial = state.current;
  const { content } = initial;
  const { format } = output;
  const check = () => {
    lifecycle.signal?.throwIfAborted();
    assertCurrent(state, initial, inputs);
  };
  const beforeDownload = () => {
    check();
    lifecycle.beforeDownload?.();
  };
  check();

  const raster = format === 'pdf' || format === 'mp4';
  const poses =
    format === 'pdf'
      ? slidePdfPoses(
          content,
          output.pageMode ?? content.exportSettings?.pdf?.pageMode ?? defaultSlidePdfPageMode,
        )
      : undefined;
  const video =
    format === 'mp4'
      ? planSlideMp4(content, output.settings ?? content.exportSettings?.mp4)
      : undefined;
  if (video) {
    const reason = slideMp4Refusal(video);
    if (reason) throw Error(reason);
  }
  const pages =
    output.format === 'svg' || output.format === 'png'
      ? visualPages(initial, output.scope)
      : slidePlaybackPages(content).map(({ page }) => page);
  const visible = new Set<SlideObject>();
  const renderPoses = video ? sampledVideoPoses(video) : poses;
  if (renderPoses) {
    for (const pose of renderPoses)
      for (const object of visiblePoseObjects(content, pose)) visible.add(object);
  } else {
    for (const page of pages)
      for (const object of slidePaintOrder(page)) if (!object.hidden) visible.add(object);
  }
  const replacements = await captureObjects(visible, initial, raster, lifecycle.signal);
  check();
  const slides = pages.map((page) => ({
    ...page,
    objects: page.objects.map((object) => replacements.get(object) ?? object),
  }));
  const manifest = exportManifest(
    initial.content,
    [...visible].map((object) => replacements.get(object) ?? object),
    raster,
  );
  const deck = { ...content, slides };
  const captured = new Map(slides.map((page) => [page.id, page]));
  if (format === 'mp4' && video) {
    const replacePage = <T extends { page: Slide }>(pose: T): T => ({
      ...pose,
      page: captured.get(pose.page.id)!,
    });
    const segments = video.segments.map((segment) => ({
      ...segment,
      pose: replacePage(segment.pose),
      ...(segment.kind === 'transition' ? { from: replacePage(segment.from) } : {}),
    }));
    const { exportSlideMp4 } = await import('./view-export-mp4');
    await exportSlideMp4(deck, { ...video, segments }, manifest, { ...lifecycle, beforeDownload });
  } else if (format === 'pdf' && poses) {
    const renderer = slideExportRenderer(deck);
    await exportPages(
      poses.map((pose) => ({
        name: pose.page.title,
        width: deck.width,
        height: deck.height,
        get svg() {
          return renderer.pdf({ ...pose, page: captured.get(pose.page.id)! });
        },
      })),
      'pdf',
      output.scale ?? 1,
      'slide-deck',
      manifest,
      { ...lifecycle, beforeDownload },
    );
  } else if (format === 'svg' || format === 'png') {
    await exportPages(
      slides.map((page) => ({
        name: page.title,
        width: deck.width,
        height: deck.height,
        svg: exportSlideSvg(deck, page),
      })),
      format,
      output.scale,
      'slide-deck',
      manifest,
    );
  }
}
