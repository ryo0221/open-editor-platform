import { clone } from '@editor-platform/artifact-core';
import { isDeck, type Slide, type SlideContent } from '@editor-platform/slide/model';
import {
  attribute as attr,
  children,
  descendants,
  namespaces as ns,
  ImportError,
  ImportReportBuilder,
  checkImportAbort,
  importLimits,
  inspectOfficePackage,
  ownOfficeImportPlan,
  requiredChild,
  type XmlNode,
  type OfficePackage,
  type OfficeSourceAddress,
} from '@editor-platform/office-import-core';
import { identity, numeric } from './geometry';
import { falsy, pchild, pick, placeholder } from './ooxml';
import { fillFrom, makeTheme, resolveColor, type ThemeContext } from './style';
import { plainText } from './text';
import { auditSlideVocabulary } from './audit';
import { addObject, type SlidePage } from './drawing';
import { SlideImportSession } from './session';
import type { SlideImportAdapters, SlideImportOptions, SlideImportPlan } from './types';
export const slideImporterVersion = '1.0.1';
function validateRequest(requestId: string, opts: SlideImportOptions, adapterVersion: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    throw new ImportError('REQUEST_ID', 'Invalid creation request ID');
  if (
    typeof opts.includeHidden !== 'boolean' ||
    !['include', 'exclude'].includes(opts.notes) ||
    !(opts.pages === 'all' || Array.isArray(opts.pages))
  )
    throw new ImportError('OPTIONS', 'Choose pages, hidden-page inclusion and speaker-note scope');
  if (typeof adapterVersion !== 'string' || !adapterVersion)
    throw new ImportError('ADAPTER_VERSION', 'Image adapter version is required');
}
/** Reads the presentation part: page size, slide entries and the validated page selection. */
function readPresentation(pkg: OfficePackage, opts: SlideImportOptions) {
  const root = pkg.xml(pkg.mainPart),
    size = requiredChild(root, 'sldSz', ns.p, pkg.mainPart),
    width = numeric(size, 'cx') / 9525,
    height = numeric(size, 'cy') / 9525;
  if ([width, height].some((n) => n < 100 || n > 6000))
    throw new ImportError('PAGE_LIMIT', 'Slide dimensions must be between 100 and 6000 CSS pixels');
  const pageEntries = children(requiredChild(root, 'sldIdLst', ns.p, pkg.mainPart), 'sldId', ns.p);
  if (!pageEntries.length || pageEntries.length > importLimits.slides)
    throw new ImportError('SLIDE_LIMIT', 'PPTX must have 1–100 slides');
  const pageIds = pageEntries.map((n) => attr(n, 'id'));
  if (pageIds.some((n) => !n || !/^\d+$/.test(n)) || new Set(pageIds).size !== pageIds.length)
    throw new ImportError('DUPLICATE_SLIDE_ID', 'Invalid or repeated presentation slide ID');
  const selected = opts.pages === 'all' ? pageEntries.map((_, i) => i + 1) : [...opts.pages];
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((n) => !Number.isInteger(n) || n < 1 || n > pageEntries.length)
  )
    throw new ImportError('PAGE_SELECTION', 'Invalid slide selection');
  return { root, width, height, pageEntries, selected };
}
const presentationChildren = [
  'sldMasterIdLst',
  'notesMasterIdLst',
  'handoutMasterIdLst',
  'sldIdLst',
  'sldSz',
  'notesSz',
  'defaultTextStyle',
];
export async function prepareSlideImport(
  source: { bytes: Uint8Array; format: 'pptx' },
  options: SlideImportOptions,
  requestId: string,
  adapters: SlideImportAdapters = { version: 'no-image-decoder' },
  signal?: AbortSignal,
): Promise<SlideImportPlan> {
  // Snapshot all caller-owned options/adapters before inspection awaits.
  const opts = clone(options),
    decoder = adapters.decodeImage,
    adapterVersion = adapters.version;
  validateRequest(requestId, opts, adapterVersion);
  const pkg = await inspectOfficePackage(source, signal),
    builder = new ImportReportBuilder(opts);
  const { root, width, height, pageEntries, selected } = readPresentation(pkg, opts);
  const s = new SlideImportSession(pkg, builder, root, requestId, decoder, signal);
  s.unknownChildren(root, presentationChildren, ns.p, pkg.mainPart);
  const slides: Slide[] = [];
  for (const [pageIndex, pageEntry] of pageEntries.entries()) {
    checkImportAbort(signal);
    const slide = await importPage(s, opts, pageEntry, pageIndex, selected);
    if (slide) slides.push(slide);
  }
  if (!slides.length)
    throw new ImportError('EMPTY_SELECTION', 'No slides remain in the selected scope');
  for (const part of pkg.parts)
    if (/(^docProps\/|comments?|authors?|person|revision|customXml\/)/i.test(part))
      builder.add(
        'PRIVATE_METADATA_EXCLUDED',
        'excluded',
        { part, path: '/' },
        'Office metadata, comments, history and actor information are excluded.',
      );
  builder.finalize();
  const content: SlideContent = {
    schemaVersion: 2,
    width,
    height,
    slides,
    theme: { fontFamily: 'Noto Sans CJK JP', color: '#304a39' },
  };
  if (!isDeck(content))
    throw new ImportError(
      'NATIVE_VALIDATION',
      'Converted slide content failed the native validator',
    );
  return ownOfficeImportPlan(
    content,
    {
      sourceHash: pkg.sourceHash,
      format: 'pptx',
      profile: 'ooxml-transitional',
      parser: {
        name: 'saxes',
        version: '6.0.0',
        adapterVersion: `${slideImporterVersion}/${adapterVersion}`,
      },
      domain: 'slide',
      requestId,
      diagnostics: builder.diagnostics,
      mapping: s.mapping,
    },
    opts,
    signal,
  );
}
/** Converts one presentation entry; undefined when the page scope excludes it. */
async function importPage(
  s: SlideImportSession,
  opts: SlideImportOptions,
  pageEntry: XmlNode,
  pageIndex: number,
  selected: readonly number[],
): Promise<Slide | undefined> {
  const { pkg, builder } = s;
  const relation = pkg.relationship(pkg.mainPart, attr(pageEntry, 'id', ns.rel) ?? '', 'slide');
  if (relation.external) throw new ImportError('EXTERNAL_SLIDE', 'Slide must be embedded');
  s.claimPagePart(relation.target);
  const part = relation.target,
    page = pkg.xml(part);
  if (page.local !== 'sld' || page.uri !== ns.p) throw new ImportError('INVALID_SLIDE', part);
  const address = { part, path: page.path },
    hidden = falsy(attr(page, 'show'));
  if (!selected.includes(pageIndex + 1) || (hidden && !opts.includeHidden)) {
    builder.add(
      'SLIDE_EXCLUDED',
      'excluded',
      address,
      `Slide ${pageIndex + 1}${hidden ? ' (hidden)' : ''} is excluded by the selected page scope.`,
    );
    return undefined;
  }
  if (hidden)
    builder.add(
      'HIDDEN_SLIDE',
      'resolved',
      address,
      'Hidden slide included and remains marked hidden.',
    );
  const sources = pageSources(pkg, part, page);
  const context = makeTheme(
    sources.theme,
    sources.master,
    pchild(page, 'clrMapOvr') ?? pchild(sources.layout, 'clrMapOvr'),
    builder,
  );
  for (const p of [part, sources.layoutPart, sources.masterPart].filter((v): v is string => !!v))
    s.validateIds(p);
  builder.add(
    'INHERITANCE_FLATTENED',
    'resolved',
    address,
    'Master, layout and theme references are resolved into editable page values; Office inheritance is not retained.',
    true,
  );
  const background = pageBackground(sources, context, address);
  const slide: Slide = {
    id: s.id('slide'),
    title: `Slide ${pageIndex + 1}`,
    background,
    objects: [],
    ...(hidden ? { hidden: true } : {}),
  };
  s.mapping.push({ source: address, nativeIds: [slide.id] });
  const target: SlidePage = { ...sources, context, slide };
  auditPageSources(s, target);
  importNotes(s, target, opts);
  await importDrawings(s, target);
  return slide;
}
function pageSources(pkg: OfficePackage, part: string, page: XmlNode) {
  const layoutPart = pkg.related(part, 'slideLayout'),
    layout = layoutPart ? pkg.xml(layoutPart) : undefined,
    masterPart = layoutPart ? pkg.related(layoutPart, 'slideMaster') : undefined,
    master = masterPart ? pkg.xml(masterPart) : undefined;
  const themePart =
    (masterPart ? pkg.related(masterPart, 'theme') : undefined) ??
    pkg.related(pkg.mainPart, 'theme');
  return {
    part,
    page,
    layoutPart,
    layout,
    masterPart,
    master,
    theme: themePart ? pkg.xml(themePart) : undefined,
  };
}
function pageBackground(
  sources: Omit<SlidePage, 'context' | 'slide'>,
  context: ThemeContext,
  address: OfficeSourceAddress,
) {
  const background = pick(
    [pchild(sources.page, 'cSld'), pchild(sources.layout, 'cSld'), pchild(sources.master, 'cSld')],
    'bg',
    ns.p,
  );
  const props = pchild(background, 'bgPr'),
    ref = pchild(background, 'bgRef');
  if (props) return fillFrom(props, context, address, '#ffffff');
  if (!ref) return '#ffffff';
  const index = numeric(ref, 'idx', 1001) - 1001,
    colors = resolveColor(ref, context, address);
  const fills = descendants(sources.theme, 'bgFillStyleLst', ns.a)[0]?.children ?? [];
  const selectedFill = fills[index];
  if (!selectedFill) throw new ImportError('UNRESOLVED_BACKGROUND', sources.part);
  return fillFrom(
    { ...selectedFill, children: [selectedFill] },
    context,
    address,
    '#ffffff',
    colors?.slice(1),
  );
}
const inheritedRootChildren = [
  'cSld',
  'clrMap',
  'clrMapOvr',
  'sldLayoutIdLst',
  'txStyles',
  'hf',
  'transition',
  'timing',
  'extLst',
];
/** Diagnoses page, layout and master features that a static native slide does not retain. */
function auditPageSources(s: SlideImportSession, p: SlidePage) {
  const { builder } = s;
  s.unknownChildren(p.page, ['cSld', 'clrMapOvr', 'transition', 'timing', 'extLst'], ns.p, p.part);
  for (const sourceRoot of [p.page, p.layout, p.master]) {
    if (!sourceRoot) continue;
    const common = pchild(sourceRoot, 'cSld');
    if (common) {
      s.unknownChildren(common, ['bg', 'spTree', 'extLst'], ns.p, common.part);
      const extensions = pchild(common, 'extLst');
      if (extensions) auditSlideVocabulary(extensions, extensions.part, builder);
    }
    if (sourceRoot !== p.page) auditInheritedRoot(s, sourceRoot);
  }
  const pageExtensions = pchild(p.page, 'extLst');
  if (pageExtensions) auditSlideVocabulary(pageExtensions, p.part, builder);
  for (const name of ['transition', 'timing']) {
    const feature = pchild(p.page, name);
    if (feature)
      builder.unsupported(
        name === 'timing' ? 'ANIMATION' : 'SLIDE_FEATURE',
        { part: p.part, path: feature.path },
        `${name} is not retained by a static native slide.`,
      );
  }
}
function auditInheritedRoot(s: SlideImportSession, sourceRoot: XmlNode) {
  s.unknownChildren(sourceRoot, inheritedRootChildren, ns.p, sourceRoot.part);
  for (const feature of sourceRoot.children.filter((n) =>
    ['transition', 'timing'].includes(n.local),
  ))
    s.builder.unsupported(
      'INHERITED_SLIDE_FEATURE',
      { part: feature.part, path: feature.path },
      `${feature.local} on the layout/master is not retained by a static native slide.`,
    );
  const extensions = pchild(sourceRoot, 'extLst');
  if (extensions) auditSlideVocabulary(extensions, extensions.part, s.builder);
}
function importNotes(s: SlideImportSession, p: SlidePage, opts: SlideImportOptions) {
  const notesPart = s.pkg.related(p.part, 'notesSlide');
  if (!notesPart) return;
  const notes = s.pkg.xml(notesPart);
  const noteAddress = { part: notesPart, path: notes.path };
  if (opts.notes !== 'include') {
    s.builder.add(
      'NOTES_EXCLUDED',
      'excluded',
      noteAddress,
      'Speaker notes are excluded by the selected scope.',
    );
    return;
  }
  p.slide.notes = descendants(notes, 'sp', ns.p)
    .filter((n) => attr(placeholder(n), 'type') === 'body')
    .map((n) => plainText(pchild(n, 'txBody')))
    .join('\n');
  s.builder.add(
    'NOTES_INCLUDED',
    'resolved',
    noteAddress,
    'Speaker notes are included as plain text; note formatting/objects are excluded.',
    true,
  );
}
/** Adds visible master, layout and page drawings in Office stacking order. */
async function importDrawings(s: SlideImportSession, p: SlidePage) {
  const pageHidesMaster = falsy(attr(p.page, 'showMasterSp')),
    masterVisible = !pageHidesMaster && !falsy(attr(p.layout, 'showMasterSp'));
  for (const [sourcePart, sourceRoot, inherited] of [
    [p.masterPart, p.master, true],
    [p.layoutPart, p.layout, true],
    [p.part, p.page, false],
  ] as const) {
    if (!sourcePart || !sourceRoot) continue;
    if (sourcePart === p.masterPart && !masterVisible) continue;
    if (sourcePart === p.layoutPart && pageHidesMaster) continue;
    const tree = pchild(pchild(sourceRoot, 'cSld'), 'spTree');
    if (!tree) throw new ImportError('INVALID_SLIDE', `${sourcePart}: missing shape tree`);
    for (const node of tree.children) {
      if (node.uri === ns.p && ['nvGrpSpPr', 'grpSpPr'].includes(node.local)) continue;
      // Placeholder sample text on layouts/masters is not slide content. Its values are resolved for the actual slide placeholder above.
      if (inherited && placeholder(node)) continue;
      await addObject(s, p, node, sourcePart, identity, undefined, inherited);
    }
  }
}
