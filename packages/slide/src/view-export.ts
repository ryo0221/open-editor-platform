import { referenceExportManifest } from '@editor-platform/artifact-references';
import type { ReferenceResolver } from '@editor-platform/artifact-references';
import type { EditorInputs } from '@editor-platform/editor-core';
import { exportPages } from '@editor-platform/canvas-ui';
import { exportSlideSvg, slidePaintOrder, type Slide, type SlideContent } from './model';
/** The surface state an export starts from; re-read after asynchronous reference capture. */
export interface SlideExportState {
  content: SlideContent;
  slide: Slide | undefined;
  pages: string[];
  references?: ReferenceResolver;
}
function exportScope(initial: SlideExportState, format: string, scope: string) {
  const { content, pages } = initial;
  if (format === 'pdf' || scope === 'all') return content.slides;
  if (scope === 'selected') return content.slides.filter((s) => pages.includes(s.id));
  return content.slides.filter((s) => s.id === initial.slide?.id);
}
/** Replaces visible referenced objects with captured snapshots, failing if inputs changed meanwhile. */
async function captureReferences(
  state: { readonly current: SlideExportState },
  initial: SlideExportState,
  references: ReferenceResolver | undefined,
  inputs: EditorInputs | undefined,
  slides: Slide[],
  visibleByPage: Map<string, Set<string>>,
  visible: Slide['objects'],
) {
  if (!references) throw new Error('参照付きの出力には参照接続が必要です。');
  const exported = await references.capture(visible);
  if (state.current.references !== references)
    throw new Error('取得中に参照接続が変わりました。再実行してください。');
  if (
    state.current.content !== initial.content ||
    inputs?.getSnapshot().dirty ||
    inputs?.getSnapshot().composing
  )
    throw new Error('取得中に入力が変わりました。再実行してください。');
  let offset = 0;
  return {
    exported,
    slides: slides.map((s) => ({
      ...s,
      objects: s.objects.map((o) => (visibleByPage.get(s.id)!.has(o.id) ? exported[offset++] : o)),
    })),
  };
}
/** Exports the chosen slides' visible objects as SVG, PNG or PDF pages. */
export async function exportSlides(
  state: { readonly current: SlideExportState },
  references: ReferenceResolver | undefined,
  inputs: EditorInputs | undefined,
  format: 'svg' | 'png' | 'pdf',
  scope: string,
  scale: number,
) {
  const initial = state.current;
  const { content } = initial;
  let slides = exportScope(initial, format, scope);
  const visibleByPage = new Map(
    slides.map((s) => [
      s.id,
      new Set(
        slidePaintOrder(s)
          .filter((o) => !o.hidden)
          .map((o) => o.id),
      ),
    ]),
  );
  let exported = slides.flatMap((s) => s.objects.filter((o) => visibleByPage.get(s.id)!.has(o.id)));
  if (exported.some((o) => o.reference))
    ({ exported, slides } = await captureReferences(
      state,
      initial,
      references,
      inputs,
      slides,
      visibleByPage,
      exported,
    ));
  await exportPages(
    slides.filter(Boolean).map((s) => ({
      name: s.title,
      width: content.width,
      height: content.height,
      svg: exportSlideSvg(content, s),
    })),
    format,
    scale,
    'slide-deck',
    referenceExportManifest(exported),
  );
}
