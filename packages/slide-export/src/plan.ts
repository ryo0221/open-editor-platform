import { clone, contentHash, deepFreeze } from '@editor-platform/artifact-core';
import { isDeck, hasSlideAnimations, type SlideContent } from '@editor-platform/slide/model';
import {
  captureExportSnapshot,
  checkExportAbort,
  exportDiagnostic,
  validExportBasis,
  type CaptureBasis,
  type SlideExportAddress,
} from '@editor-platform/export-core';
import {
  slidePptxCapabilities,
  type OwnedPptxPlan,
  type PptxAdapters,
  type PptxRepresentation,
  type SlideExportSnapshot,
  type SlidePptxOptions,
  type SlidePptxPlan,
  type SlidePptxReport,
} from './types';
import { PptxPlanner } from './planner';
import { planSlide } from './plan-page';

export const slidePptxExporterVersion = '1.2.0';
const plans = new WeakMap<SlidePptxPlan, OwnedPptxPlan>();
/** Package-private: consumers cannot manufacture or replace an encoding plan via JSON. */
export function ownedSlidePptxPlan(plan: SlidePptxPlan): OwnedPptxPlan | undefined {
  return plans.get(plan);
}
export const captureSlideExportSnapshot = (content: SlideContent, basis: CaptureBasis) =>
  captureExportSnapshot(content, basis);

const validOptions = (settings: SlidePptxOptions) =>
  !!settings &&
  ['reject', 'element-png'].includes(settings.fallback) &&
  typeof settings.includeHiddenSlides === 'boolean' &&
  typeof settings.includeNotes === 'boolean' &&
  typeof settings.fontProfileId === 'string' &&
  !!settings.fontProfileId;
function validDeck(input: SlideExportSnapshot | undefined) {
  try {
    return isDeck(input?.content) && validExportBasis(input?.basis);
  } catch {
    return false; // Invalid native input.
  }
}
/** Content-level diagnostics that do not depend on the page selection. */
function auditDeck(p: PptxPlanner, deck: SlideContent) {
  if (deck.slides.some((s) => s.objects.some((o) => o.reference)))
    p.add(
      'REFERENCE_EXPORT_UNSUPPORTED',
      'error',
      '参照埋め込みのPPTX出力は未対応です。SVG／PNG／PDFまたは参照付きnative JSONを使ってください。',
      { domain: 'slide' },
    );
  if (deck.reuse && (deck.reuse.instances.length || deck.reuse.artifactMode))
    p.add(
      'REUSABLE_LINKS_RESOLVED',
      'warning',
      'Exports the adopted native appearance. Library links, token modes, variant controls and typed slots are not retained in PPTX or restored by Office import.',
      { domain: 'slide' },
      'editability',
    );
}
/** The selected slides in deck order; selection, page-size and limit errors are diagnosed. */
function selectSlides(p: PptxPlanner, deck: SlideContent, settings: SlidePptxOptions) {
  const chosen = settings.pageIds === 'all' ? deck.slides.map((s) => s.id) : settings.pageIds;
  if (
    !Array.isArray(chosen) ||
    !chosen.length ||
    new Set(chosen).size !== chosen.length ||
    chosen.some((id) => typeof id !== 'string' || !deck.slides.some((s) => s.id === id))
  )
    p.add('INVALID_PAGE_SELECTION', 'error', 'Choose distinct existing pages');
  if (
    [deck.width, deck.height].some(
      (n) => n < slidePptxCapabilities.minPageSide || n > slidePptxCapabilities.maxPageSide,
    )
  )
    p.add('PAGE_SIZE_UNSUPPORTED', 'error', 'Page sides must be between 100 and 3840 CSS pixels');
  const selected = Array.isArray(chosen) ? deck.slides.filter((s) => chosen.includes(s.id)) : [];
  if (
    selected.length > slidePptxCapabilities.slides ||
    selected.reduce((n, s) => n + s.objects.length, 0) > slidePptxCapabilities.objects
  )
    p.add('LIMIT_EXCEEDED', 'error', 'At most 100 slides and 10,000 objects can be exported');
  return selected;
}
const blockingSelection = ['INVALID_PAGE_SELECTION', 'PAGE_SIZE_UNSUPPORTED', 'LIMIT_EXCEEDED'];
export async function prepareSlidePptx(
  snapshot: SlideExportSnapshot,
  options: SlidePptxOptions,
  adapters: PptxAdapters,
  signal?: AbortSignal,
): Promise<SlidePptxPlan> {
  checkExportAbort(signal);
  // Copy every caller-controlled synchronous input before awaiting either hashes or adapters.
  let input: SlideExportSnapshot, settings: SlidePptxOptions;
  try {
    input = deepFreeze(clone(snapshot));
    settings = deepFreeze(clone(options));
  } catch {
    return invalidPlan('Input must be serializable domain data');
  }
  const p = new PptxPlanner(settings, adapters, signal);
  if (!validDeck(input)) return invalidPlan('Invalid Slide content or export basis', input?.basis);
  const deck = input.content as SlideContent;
  if (hasSlideAnimations(deck))
    return invalidPlan(
      'Animation を含む Slide の PPTX 出力は未対応です。native JSON で保存してください。',
      input.basis,
    );
  auditDeck(p, deck);
  if ((await contentHash(deck)) !== input.basis.contentHash)
    p.add('SNAPSHOT_HASH_MISMATCH', 'error', 'Captured content does not match its declared hash');
  checkExportAbort(signal);
  if (!validOptions(settings)) return invalidPlan('Invalid export options', input.basis);
  const selected = selectSlides(p, deck, settings);
  await p.resolveFont();
  if (!p.hasDiagnostic(blockingSelection))
    for (const slide of selected) {
      checkExportAbort(signal);
      await planSlide(p, deck, slide);
    }
  if (!p.pages.length && !p.diagnostics.some((d) => d.severity === 'error'))
    p.add('INVALID_PAGE_SELECTION', 'error', 'No visible selected page remains');
  return finishPlan(p, input, deck);
}
const countKeys: Record<PptxRepresentation, keyof SlidePptxReport['counts']> = {
  native: 'native',
  'native-approximation': 'approximated',
  png: 'rasterized',
  omitted: 'omitted',
};
async function finishPlan(p: PptxPlanner, input: SlideExportSnapshot, deck: SlideContent) {
  const { diagnostics, pages, assets, font, settings } = p;
  const counts = { native: 0, approximated: 0, rasterized: 0, omitted: 0 };
  for (const e of p.reportElements) if (e.counted) counts[countKeys[e.representation]]++;
  const planHash = await contentHash({
    exporterVersion: slidePptxExporterVersion,
    basis: input.basis,
    options: settings,
    font,
    pages,
    assets: [...assets].map(([key, a]) => ({
      key,
      hash: a.hash,
      mime: a.mime,
      width: a.width,
      height: a.height,
    })),
    diagnostics: diagnostics.map(({ id, code, severity, effect, requiresAcceptance }) => ({
      id,
      code,
      severity,
      effect,
      requiresAcceptance,
    })),
  });
  checkExportAbort(p.signal);
  const report: SlidePptxReport = {
    schemaVersion: 1,
    exporterVersion: slidePptxExporterVersion,
    planHash,
    basis: clone(input.basis),
    selectedPageIds: pages.map((page) => page.id),
    diagnostics,
    elements: p.reportElements,
    counts,
  };
  return register({
    report: deepFreeze(report),
    width: deck.width,
    height: deck.height,
    options: settings,
    pages: deepFreeze(pages),
    font,
    assets,
  });
}
function register(state: OwnedPptxPlan): SlidePptxPlan {
  const handle = Object.freeze({ report: state.report }) as SlidePptxPlan;
  plans.set(handle, state);
  return handle;
}
async function invalidPlan(
  message: string,
  origin?: SlideExportSnapshot['basis'],
): Promise<SlidePptxPlan> {
  const basis = validExportBasis(origin as never)
    ? clone(origin!)
    : {
        kind: 'local-draft' as const,
        artifactId: 'invalid-input',
        contentHash: await contentHash(null),
      };
  const diagnostics = [exportDiagnostic<SlideExportAddress>('INVALID_CONTENT', 'error', message)];
  const report: SlidePptxReport = {
    schemaVersion: 1,
    exporterVersion: slidePptxExporterVersion,
    basis,
    planHash: await contentHash({ basis, code: 'INVALID_CONTENT' }),
    diagnostics,
    selectedPageIds: [],
    elements: [],
    counts: { native: 0, approximated: 0, rasterized: 0, omitted: 0 },
  };
  return register({
    report: deepFreeze(report),
    width: 0,
    height: 0,
    pages: [],
    assets: new Map(),
    options: {
      pageIds: 'all',
      includeHiddenSlides: false,
      includeNotes: false,
      fontProfileId: '',
      fallback: 'reject',
    },
  });
}
