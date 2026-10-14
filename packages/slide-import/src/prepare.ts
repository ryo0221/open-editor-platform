import { clone } from '@editor-platform/artifact-core';
import { shapePath, unionBounds, type ShapeKind } from '@editor-platform/editor-core';
import {
  isDeck,
  type Slide,
  type SlideContent,
  type SlideObject,
} from '@editor-platform/slide/model';
import { imageDataUri, inspectOfficeImage } from '@editor-platform/office-adapters';
import {
  attribute as attr,
  child,
  children,
  descendants,
  namespaces as ns,
  ImportError,
  ImportReportBuilder,
  checkImportAbort,
  importLimits,
  importNativeId,
  hashImportBytes,
  inspectOfficePackage,
  ownOfficeImportPlan,
  requiredChild,
  validateDisplayLink,
  type XmlNode,
  type OfficeSourceAddress,
  type ImportMapping,
} from '@editor-platform/office-import-core';
import { identity, multiply, numeric, transform, worldBox, type Matrix } from './geometry';
import { fillFrom, makeTheme, resolveColor } from './style';
import { importText, plainText } from './text';
import { auditSlideVocabulary } from './audit';
import type { SlideImportAdapters, SlideImportOptions, SlideImportPlan } from './types';
export const slideImporterVersion = '1.0.1';
const shapeKinds: Record<string, ShapeKind> = {
  rect: 'rectangle',
  roundRect: 'rounded-rectangle',
  ellipse: 'ellipse',
  triangle: 'triangle',
  diamond: 'diamond',
  line: 'line',
  straightConnector1: 'line',
  rightArrow: 'arrow-right',
  leftArrow: 'arrow-left',
  upArrow: 'arrow-up',
  downArrow: 'arrow-down',
  leftRightArrow: 'arrow-both',
};
const pchild = (n: XmlNode | undefined, name: string) => child(n, name, ns.p);
const achild = (n: XmlNode | undefined, name: string) => child(n, name, ns.a);
const nv = (n: XmlNode) => n.children.find((c) => c.uri === ns.p && c.local.startsWith('nv'));
const drawingHidden = (n: XmlNode) =>
  ['1', 'true'].includes(attr(pchild(nv(n), 'cNvPr'), 'hidden') ?? '');
const sourceAddress = (part: string, n: XmlNode): OfficeSourceAddress => ({
  part,
  path: n.path,
  ...(attr(pchild(nv(n), 'cNvPr'), 'id') ? { elementId: attr(pchild(nv(n), 'cNvPr'), 'id') } : {}),
});
const placeholder = (n: XmlNode) => pchild(pchild(nv(n), 'nvPr'), 'ph');
function inheritedPlaceholder(n: XmlNode, root: XmlNode | undefined) {
  const ph = placeholder(n);
  if (!ph || !root) return undefined;
  const candidates = descendants(root, 'sp', ns.p).filter((s) => placeholder(s));
  const idx = attr(ph, 'idx'),
    type = attr(ph, 'type') ?? 'obj';
  return (
    candidates.find((s) => idx !== undefined && attr(placeholder(s), 'idx') === idx) ??
    candidates.find((s) => (attr(placeholder(s), 'type') ?? 'obj') === type)
  );
}
function pick(nodes: (XmlNode | undefined)[], name: string, uri: string) {
  return nodes.map((n) => child(n, name, uri)).find(Boolean);
}
function mergeProperties(nodes: (XmlNode | undefined)[]): XmlNode | undefined {
  const present = nodes.filter((n): n is XmlNode => !!n);
  if (!present.length) return undefined;
  const merged = new Map<string, XmlNode>(),
    attributes = new Map<string, XmlNode['attributes'][number]>();
  const fills = ['noFill', 'solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill'];
  for (const n of [...present].reverse()) {
    for (const a of n.attributes) attributes.set(`${a.uri}#${a.local}`, a);
    for (const c of n.children) {
      if (c.uri === ns.a && fills.includes(c.local))
        for (const f of fills) merged.delete(`${ns.a}#${f}`);
      merged.set(`${c.uri}#${c.local}`, c);
    }
  }
  return { ...present[0], attributes: [...attributes.values()], children: [...merged.values()] };
}
function customShape(geometry: XmlNode, width: number, height: number): ShapeKind | undefined {
  // Recognize only the exact finite M/L/Z polygons used by our 13 native output shapes.
  const paths = children(achild(geometry, 'pathLst'), 'path', ns.a);
  if (paths.length !== 1) return undefined;
  const path = paths[0],
    w = numeric(path, 'w', width * 9525),
    h = numeric(path, 'h', height * 9525);
  if (w <= 0 || h <= 0) return undefined;
  const tokens: (number | string)[] = [];
  for (const c of path.children) {
    if (c.uri !== ns.a) return undefined;
    if (c.local === 'close') tokens.push('Z');
    else if (c.local === 'moveTo' || c.local === 'lnTo') {
      const p = achild(c, 'pt');
      const x = Number(attr(p, 'x')),
        y = Number(attr(p, 'y'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
      tokens.push(c.local === 'moveTo' ? 'M' : 'L', (x / w) * width, (y / h) * height);
    } else return undefined;
  }
  const kinds: ShapeKind[] = [
    'triangle',
    'diamond',
    'arrow-right',
    'arrow-left',
    'arrow-up',
    'arrow-down',
    'arrow-both',
    'line',
    'arrow',
    'double-arrow',
  ];
  for (const kind of kinds) {
    let pathString = ['line', 'arrow', 'double-arrow'].includes(kind)
      ? `M0 ${height / 2} L${width} ${height / 2}`
      : shapePath(kind, width, height);
    if (kind === 'arrow' || kind === 'double-arrow')
      pathString += ` M${width - 10} ${height / 2 - 6} L${width} ${height / 2} L${width - 10} ${height / 2 + 6}`;
    if (kind === 'double-arrow')
      pathString += ` M10 ${height / 2 - 6} L0 ${height / 2} L10 ${height / 2 + 6}`;
    const expected = (pathString.match(/[MLZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? []).map(
      (v) => (/^[MLZ]$/.test(v) ? v : Number(v)),
    );
    if (
      expected.length === tokens.length &&
      expected.every((v, i) =>
        typeof v === 'string'
          ? v === tokens[i]
          : typeof tokens[i] === 'number' && Math.abs(v - (tokens[i] as number)) < 0.002,
      )
    )
      return kind;
  }
  return undefined;
}
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
  const pkg = await inspectOfficePackage(source, signal),
    builder = new ImportReportBuilder(opts),
    mapping: ImportMapping[] = [];
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
  const pageParts = new Set<string>();
  const selected = opts.pages === 'all' ? pageEntries.map((_, i) => i + 1) : [...opts.pages];
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((n) => !Number.isInteger(n) || n < 1 || n > pageEntries.length)
  )
    throw new ImportError('PAGE_SELECTION', 'Invalid slide selection');
  let count = 0,
    nextId = 0,
    totalImages = 0,
    nativeAssetCharacters = 0,
    textCharacters = 0;
  const id = (prefix = 'object') => importNativeId(requestId, ++nextId, prefix);
  const assets = new Map<string, { src: string; width: number; height: number }>();
  const assetsByHash = new Map<string, { src: string; width: number; height: number }>();
  async function imageAsset(part: string, address: OfficeSourceAddress) {
    const existing = assets.get(part);
    if (existing) return existing;
    if (!decoder) {
      builder.unsupported(
        'IMAGE_DECODER',
        address,
        'A verified byte-only image decoder is required.',
      );
      return undefined;
    }
    const raw = pkg.bytes(part);
    if (!((raw[0] === 0x89 && raw[1] === 0x50) || (raw[0] === 0xff && raw[1] === 0xd8))) {
      builder.unsupported(
        'IMAGE_FORMAT',
        address,
        'This import profile supports static PNG/JPEG only.',
      );
      return undefined;
    }
    const inspected = inspectOfficeImage(raw),
      hash = await hashImportBytes(raw);
    const cached = assetsByHash.get(hash);
    if (cached) {
      assets.set(part, cached);
      return cached;
    }
    totalImages += raw.length;
    if (totalImages > importLimits.totalImageBytes)
      throw new ImportError('IMAGE_TOTAL_LIMIT', 'Unique embedded images exceed 64 MiB');
    const decoded = await decoder(raw.slice(), signal);
    checkImportAbort(signal);
    // A validator may not replace or mutate a source asset unnoticed.
    if (
      decoded.mime !== inspected.mime ||
      decoded.width !== inspected.width ||
      decoded.height !== inspected.height ||
      decoded.bytes.length !== raw.length ||
      decoded.bytes.some((v, i) => v !== raw[i])
    )
      throw new ImportError('IMAGE_ADAPTER', 'Image validator changed source bytes or dimensions');
    const result = {
      src: imageDataUri(inspected),
      width: inspected.width,
      height: inspected.height,
    };
    assets.set(part, result);
    assetsByHash.set(hash, result);
    return result;
  }
  function unknownChildren(n: XmlNode, allowed: readonly string[], uri: string, part: string) {
    for (const c of n.children)
      if (
        !(
          (c.uri === uri && allowed.includes(c.local)) ||
          (c.uri === ns.a && allowed.includes(`a:${c.local}`))
        )
      )
        builder.unsupported(
          'UNSUPPORTED_ELEMENT',
          { part, path: c.path },
          `Unsupported ${c.local} in ${n.local}. Explicit exclusion removes this feature.`,
        );
  }
  function validateIds(part: string) {
    const ids = new Set<string>();
    const tree = pchild(pchild(pkg.xml(part), 'cSld'), 'spTree');
    // The spTree container has no native element identity. Only actual drawings
    // participate in source-ID uniqueness (including nested groups/placeholders).
    for (const n of (tree?.children ?? [])
      .filter((n) => n.local !== 'nvGrpSpPr')
      .flatMap((n) => descendants(n, 'cNvPr', ns.p))) {
      const source = attr(n, 'id');
      if (!source || ids.has(source))
        throw new ImportError('DUPLICATE_SOURCE_ID', `${part}: invalid or duplicate drawing ID`);
      ids.add(source);
    }
  }
  function metadataAndLinks(n: XmlNode, part: string) {
    for (const h of [
      ...descendants(n, 'hlinkClick', ns.a),
      ...descendants(n, 'hlinkMouseOver', ns.a),
    ]) {
      const relation = attr(h, 'id', ns.rel);
      if (relation) {
        const r = pkg.relationship(part, relation);
        if (r.external) validateDisplayLink(r.target);
      }
      builder.add(
        'HYPERLINK',
        'approximation',
        { part, path: h.path },
        'Office object/text hyperlinks are not retained in native Slide content.',
        true,
      );
    }
  }
  unknownChildren(
    root,
    [
      'sldMasterIdLst',
      'notesMasterIdLst',
      'handoutMasterIdLst',
      'sldIdLst',
      'sldSz',
      'notesSz',
      'defaultTextStyle',
    ],
    ns.p,
    pkg.mainPart,
  );
  const slides: Slide[] = [];
  for (const [pageIndex, pageEntry] of pageEntries.entries()) {
    checkImportAbort(signal);
    const relation = pkg.relationship(pkg.mainPart, attr(pageEntry, 'id', ns.rel) ?? '', 'slide');
    if (relation.external) throw new ImportError('EXTERNAL_SLIDE', 'Slide must be embedded');
    if (pageParts.has(relation.target))
      throw new ImportError('DUPLICATE_SLIDE_PART', relation.target);
    pageParts.add(relation.target);
    const part = relation.target,
      page = pkg.xml(part);
    if (page.local !== 'sld' || page.uri !== ns.p) throw new ImportError('INVALID_SLIDE', part);
    const address = { part, path: page.path },
      hidden = ['0', 'false'].includes(attr(page, 'show') ?? '1');
    if (!selected.includes(pageIndex + 1) || (hidden && !opts.includeHidden)) {
      builder.add(
        'SLIDE_EXCLUDED',
        'excluded',
        address,
        `Slide ${pageIndex + 1}${hidden ? ' (hidden)' : ''} is excluded by the selected page scope.`,
      );
      continue;
    }
    if (hidden)
      builder.add(
        'HIDDEN_SLIDE',
        'resolved',
        address,
        'Hidden slide included and remains marked hidden.',
      );
    const layoutPart = pkg.related(part, 'slideLayout'),
      layout = layoutPart ? pkg.xml(layoutPart) : undefined,
      masterPart = layoutPart ? pkg.related(layoutPart, 'slideMaster') : undefined,
      master = masterPart ? pkg.xml(masterPart) : undefined;
    const themePart =
        (masterPart ? pkg.related(masterPart, 'theme') : undefined) ??
        pkg.related(pkg.mainPart, 'theme'),
      theme = themePart ? pkg.xml(themePart) : undefined;
    const context = makeTheme(
      theme,
      master,
      pchild(page, 'clrMapOvr') ?? pchild(layout, 'clrMapOvr'),
      builder,
    );
    for (const p of [part, layoutPart, masterPart].filter((v): v is string => !!v)) validateIds(p);
    builder.add(
      'INHERITANCE_FLATTENED',
      'resolved',
      address,
      'Master, layout and theme references are resolved into editable page values; Office inheritance is not retained.',
      true,
    );
    const background = pick(
      [pchild(page, 'cSld'), pchild(layout, 'cSld'), pchild(master, 'cSld')],
      'bg',
      ns.p,
    );
    let backgroundColor = '#ffffff';
    if (background) {
      const props = pchild(background, 'bgPr'),
        ref = pchild(background, 'bgRef');
      if (props) backgroundColor = fillFrom(props, context, address, '#ffffff');
      else if (ref) {
        const index = numeric(ref, 'idx', 1001) - 1001,
          colors = resolveColor(ref, context, address);
        const fills = descendants(theme, 'bgFillStyleLst', ns.a)[0]?.children ?? [];
        const selectedFill = fills[index];
        if (!selectedFill) throw new ImportError('UNRESOLVED_BACKGROUND', part);
        backgroundColor = fillFrom(
          { ...selectedFill, children: [selectedFill] },
          context,
          address,
          '#ffffff',
          colors?.slice(1),
        );
      }
    }
    const slide: Slide = {
      id: id('slide'),
      title: `Slide ${pageIndex + 1}`,
      background: backgroundColor,
      objects: [],
      ...(hidden ? { hidden: true } : {}),
    };
    slides.push(slide);
    mapping.push({ source: address, nativeIds: [slide.id] });
    unknownChildren(page, ['cSld', 'clrMapOvr', 'transition', 'timing', 'extLst'], ns.p, part);
    for (const sourceRoot of [page, layout, master]) {
      if (!sourceRoot) continue;
      const common = pchild(sourceRoot, 'cSld');
      if (common) {
        unknownChildren(common, ['bg', 'spTree', 'extLst'], ns.p, common.part);
        const extensions = pchild(common, 'extLst');
        if (extensions) auditSlideVocabulary(extensions, extensions.part, builder);
      }
      if (sourceRoot !== page) {
        unknownChildren(
          sourceRoot,
          [
            'cSld',
            'clrMap',
            'clrMapOvr',
            'sldLayoutIdLst',
            'txStyles',
            'hf',
            'transition',
            'timing',
            'extLst',
          ],
          ns.p,
          sourceRoot.part,
        );
        for (const feature of sourceRoot.children.filter((n) =>
          ['transition', 'timing'].includes(n.local),
        ))
          builder.unsupported(
            'INHERITED_SLIDE_FEATURE',
            { part: feature.part, path: feature.path },
            `${feature.local} on the layout/master is not retained by a static native slide.`,
          );
        const extensions = pchild(sourceRoot, 'extLst');
        if (extensions) auditSlideVocabulary(extensions, extensions.part, builder);
      }
    }
    const pageExtensions = pchild(page, 'extLst');
    if (pageExtensions) auditSlideVocabulary(pageExtensions, part, builder);
    for (const name of ['transition', 'timing']) {
      const feature = pchild(page, name);
      if (feature)
        builder.unsupported(
          name === 'timing' ? 'ANIMATION' : 'SLIDE_FEATURE',
          { part, path: feature.path },
          `${name} is not retained by a static native slide.`,
        );
    }
    const notesPart = pkg.related(part, 'notesSlide');
    if (notesPart) {
      const notes = pkg.xml(notesPart);
      const noteAddress = { part: notesPart, path: notes.path };
      if (opts.notes === 'include') {
        const text = descendants(notes, 'sp', ns.p)
          .filter((n) => attr(placeholder(n), 'type') === 'body')
          .map((n) => plainText(pchild(n, 'txBody')))
          .join('\n');
        slide.notes = text;
        builder.add(
          'NOTES_INCLUDED',
          'resolved',
          noteAddress,
          'Speaker notes are included as plain text; note formatting/objects are excluded.',
          true,
        );
      } else
        builder.add(
          'NOTES_EXCLUDED',
          'excluded',
          noteAddress,
          'Speaker notes are excluded by the selected scope.',
        );
    }
    async function addObject(
      node: XmlNode,
      sourcePart: string,
      parent: Matrix,
      groupId?: string,
      inherited = false,
    ): Promise<void> {
      if (++count > importLimits.objects)
        throw new ImportError(
          'OBJECT_LIMIT',
          'More than 10,000 selected objects including inherited objects',
        );
      const address = sourceAddress(sourcePart, node);
      if (
        node.uri !== ns.p ||
        !['sp', 'cxnSp', 'pic', 'graphicFrame', 'grpSp'].includes(node.local)
      ) {
        builder.unsupported(
          'DRAWING_UNSUPPORTED',
          address,
          `Drawing ${node.local} cannot be converted. A verified element image is unavailable; explicitly exclude the element or stop.`,
        );
        return;
      }
      metadataAndLinks(node, sourcePart);
      const lp = sourcePart === part ? inheritedPlaceholder(node, layout) : undefined,
        mp = inheritedPlaceholder(lp ?? node, master),
        chain = [node, lp, mp];
      const style = mergeProperties(chain.map((n) => pchild(n, 'style')));
      const props = mergeProperties(
        chain.map((n) => pchild(n, node.local === 'grpSp' ? 'grpSpPr' : 'spPr')),
      );
      const xfrm =
        node.local === 'graphicFrame'
          ? pchild(node, 'xfrm')
          : pick(
              chain.map((n) => pchild(n, 'spPr')),
              'xfrm',
              ns.a,
            );
      if (node.local === 'grpSp') {
        const groupProperties = pchild(node, 'grpSpPr'),
          xf = achild(groupProperties, 'xfrm');
        if (!xf)
          throw new ImportError('INVALID_GEOMETRY', `${sourcePart}: missing group transform`);
        if (groupProperties) unknownChildren(groupProperties, ['xfrm'], ns.a, sourcePart);
        auditSlideVocabulary(
          {
            ...node,
            children: node.children.filter((n) => ['nvGrpSpPr', 'grpSpPr'].includes(n.local)),
          },
          sourcePart,
          builder,
        );
        const group = id('group'),
          start = slide.objects.length;
        const groupObject: SlideObject = {
          id: group,
          type: 'group',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          fill: 'none',
          text: '',
          ...(drawingHidden(node) ? { hidden: true } : {}),
          ...(groupId ? { groupId } : {}),
        };
        slide.objects.push(groupObject);
        const groupMatrix = multiply(parent, transform(xf, true).matrix);
        for (const c of node.children)
          if (!['nvGrpSpPr', 'grpSpPr'].includes(c.local))
            await addObject(c, sourcePart, groupMatrix, group, inherited);
        const members = slide.objects.slice(start + 1);
        if (members.length) groupObject.bounds = unionBounds(members.map((o) => o.bounds));
        mapping.push({ source: address, nativeIds: [group] });
        builder.add(
          'GROUP_WORLD_COORDINATES',
          'resolved',
          address,
          'Group child coordinates and stacking order are flattened into native world coordinates. Group membership remains editable.',
        );
        return;
      }
      if (!xfrm)
        throw new ImportError(
          'UNRESOLVED_GEOMETRY',
          `${sourcePart}${node.path}: no local/layout/master transform`,
        );
      const t = transform(xfrm),
        world = worldBox(multiply(parent, t.matrix), t.width, t.height);
      if (!world) {
        builder.unsupported(
          'SKEWED_GROUP',
          address,
          'Combined group transforms require skew, which native Slide does not represent.',
        );
        return;
      }
      const object: SlideObject = {
        id: id(),
        type: 'shape',
        bounds: world.bounds,
        rotation: world.rotation,
        flipY: world.flipY,
        text: '',
        fill: 'none',
        ...(drawingHidden(node) ? { hidden: true } : {}),
        ...(groupId ? { groupId } : {}),
      };
      if (node.local === 'pic') {
        const fill = pchild(node, 'blipFill'),
          blip = achild(fill, 'blip');
        const rel = attr(blip, 'embed', ns.rel) ?? attr(blip, 'link', ns.rel);
        if (!rel)
          throw new ImportError('INVALID_IMAGE', `${sourcePart}: missing image relationship`);
        const relation = pkg.relationship(sourcePart, rel, 'image');
        if (relation.external) {
          builder.unsupported(
            'EXTERNAL_IMAGE',
            address,
            'External images are never fetched. Supply an embedded PNG/JPEG copy or exclude this image.',
          );
          return;
        }
        const asset = await imageAsset(relation.target, address);
        if (!asset) return;
        object.type = 'image';
        nativeAssetCharacters += asset.src.length;
        if (nativeAssetCharacters > importLimits.nativeAssetCharacters)
          throw new ImportError(
            'NATIVE_ASSET_LIMIT',
            'Repeated inline images exceed 128 MiB of native data URI text',
          );
        object.src = asset.src;
        object.alt = attr(pchild(nv(node), 'cNvPr'), 'descr') ?? '';
        object.imageFit = 'fit';
        const crop = achild(fill, 'srcRect'),
          l = numeric(crop, 'l', 0) / 1e5,
          r = numeric(crop, 'r', 0) / 1e5,
          top = numeric(crop, 't', 0) / 1e5,
          bottom = numeric(crop, 'b', 0) / 1e5;
        if ([l, r, top, bottom].some((v) => v < 0 || v >= 1) || l + r >= 1 || top + bottom >= 1)
          throw new ImportError(
            'INVALID_CROP',
            'Crop is outside the supported positive source rectangle',
          );
        const fullW = world.bounds.width / (1 - l - r),
          fullH = world.bounds.height / (1 - top - bottom),
          ratio = asset.width / asset.height;
        if (Math.abs(fullW / fullH / ratio - 1) > 0.002) {
          builder.add(
            'IMAGE_STRETCH',
            'approximation',
            address,
            'Office stretches this image non-uniformly. Native image placement preserves its aspect ratio; inspect crop and framing.',
            true,
          );
        }
        const containW = Math.min(world.bounds.width, world.bounds.height * ratio),
          containH = containW / ratio,
          scale = Math.max(fullW / containW, fullH / containH);
        object.crop = {
          scale,
          x: -l * containW * scale - (world.bounds.width * scale - containW * scale) / 2,
          y: -top * containH * scale - (world.bounds.height * scale - containH * scale) / 2,
        };
        if (fill) unknownChildren(fill, ['blip', 'srcRect', 'stretch'], ns.a, sourcePart);
        if (blip) {
          unknownChildren(blip, ['alphaModFix'], ns.a, sourcePart);
          for (const alpha of children(blip, 'alphaModFix', ns.a)) {
            const value = numeric(alpha, 'amt', 100000) / 100000;
            if (value < 0 || value > 1)
              throw new ImportError('IMAGE_ALPHA', 'Image opacity is outside the native range');
            object.opacity = (object.opacity ?? 1) * value;
          }
        }
        const stretch = achild(fill, 'stretch');
        if (stretch && achild(stretch, 'fillRect')?.attributes.length)
          builder.unsupported(
            'IMAGE_FILL_RECT',
            { part: sourcePart, path: stretch.path },
            'Non-default image fillRect is not supported.',
          );
      } else if (node.local === 'graphicFrame') {
        const graphic = achild(node, 'graphic'),
          data = achild(graphic, 'graphicData'),
          table = achild(data, 'tbl');
        if (
          !data ||
          attr(data, 'uri') !== 'http://schemas.openxmlformats.org/drawingml/2006/table' ||
          !table
        ) {
          builder.unsupported(
            'GRAPHIC_UNSUPPORTED',
            address,
            'Charts, SmartArt and other graphic frames need a verified element renderer or explicit exclusion.',
          );
          return;
        }
        const rows = children(table, 'tr', ns.a),
          grid = children(achild(table, 'tblGrid'), 'gridCol', ns.a);
        if (!rows.length || !grid.length || rows.length * grid.length > importLimits.cells)
          throw new ImportError('TABLE_LIMIT', 'Invalid or oversized slide table');
        const cells = rows.map((row) => children(row, 'tc', ns.a));
        if (
          cells.some((row) => row.length !== grid.length) ||
          cells
            .flat()
            .some(
              (c) =>
                ['rowSpan', 'gridSpan', 'hMerge', 'vMerge'].some(
                  (k) => attr(c, k) !== undefined && attr(c, k) !== '1' && attr(c, k) !== '0',
                ) ||
                attr(c, 'hMerge') === '1' ||
                attr(c, 'vMerge') === '1',
            )
        ) {
          builder.unsupported(
            'MERGED_SLIDE_TABLE',
            address,
            'Merged presentation tables are outside this native import profile.',
          );
          return;
        }
        const widths = grid.map((c) => (numeric(c, 'w') / 9525) * world.scaleX),
          heights = rows.map((c) => (numeric(c, 'h') / 9525) * world.scaleY);
        if (widths.some((v) => v <= 0) || heights.some((v) => v < 0))
          throw new ImportError('INVALID_TABLE', 'Non-positive table geometry');
        if (heights.some((v) => v === 0)) {
          builder.add(
            'TABLE_AUTO_HEIGHT',
            'approximation',
            address,
            'Office automatic row heights use a native minimum of 32 CSS pixels.',
            true,
          );
          heights.forEach((v, i) => {
            if (!v) heights[i] = 32 * world.scaleY;
          });
        }
        object.type = 'table';
        object.table = {
          rows: cells.map((row) => row.map((c) => plainText(achild(c, 'txBody')))),
          columnWidths: widths,
          rowHeights: heights,
          header: attr(achild(table, 'tblPr'), 'firstRow') !== '0',
        };
        object.typography = { fontFamily: context.font, fontSize: 16, padding: 8 };
        builder.add(
          'TABLE_STYLE',
          'approximation',
          address,
          'Table cells and dimensions stay editable. Native tables use a uniform text/cell style; Office per-cell rich formatting and theme styling are not retained.',
          true,
        );
        unknownChildren(table, ['tblPr', 'tblGrid', 'tr'], ns.a, sourcePart);
        for (const row of cells)
          for (const cell of row) {
            unknownChildren(cell, ['txBody', 'tcPr'], ns.a, sourcePart);
            for (const text of descendants(cell, 'hlinkClick', ns.a))
              metadataAndLinks(text, sourcePart);
          }
      } else {
        const geom = pick(
            chain.map((n) => pchild(n, 'spPr')),
            'prstGeom',
            ns.a,
          ),
          custom = pick(
            chain.map((n) => pchild(n, 'spPr')),
            'custGeom',
            ns.a,
          );
        let shape = geom
          ? shapeKinds[attr(geom, 'prst') ?? '']
          : custom
            ? customShape(custom, t.width, t.height)
            : undefined;
        const txBox =
          attr(pchild(nv(node), node.local === 'cxnSp' ? 'cNvCxnSpPr' : 'cNvSpPr'), 'txBox') ===
            '1' ||
          (!!placeholder(node) && !geom && !custom);
        if (!shape && (!txBox || !!geom || !!custom)) {
          builder.unsupported(
            'SHAPE_UNSUPPORTED',
            address,
            `Shape ${attr(geom, 'prst') ?? 'custom geometry'} has no supported native representation. Explicitly exclude it or stop.`,
          );
          return;
        }
        const fillRef = achild(style, 'fillRef'),
          lineRef = achild(style, 'lnRef');
        const fillIndex = fillRef ? numeric(fillRef, 'idx', 0) : 0,
          lineIndex = lineRef ? numeric(lineRef, 'idx', 0) : 0;
        const fills = descendants(theme, 'fillStyleLst', ns.a)[0]?.children ?? [],
          lines = descendants(theme, 'lnStyleLst', ns.a)[0]?.children ?? [];
        const themeFill = fillIndex ? fills[fillIndex - 1] : undefined,
          themeLine = lineIndex ? lines[lineIndex - 1] : undefined;
        if ((fillIndex && !themeFill) || (lineIndex && !themeLine))
          throw new ImportError('UNRESOLVED_STYLE', 'Invalid theme style reference');
        const hasLocalFill = props?.children.some(
          (n) =>
            n.uri === ns.a &&
            ['noFill', 'solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill'].includes(
              n.local,
            ),
        );
        const resolvedFill =
          themeFill && !hasLocalFill
            ? fillFrom(
                { ...themeFill, children: [themeFill] },
                context,
                address,
                'none',
                resolveColor(fillRef, context, address)?.slice(1),
              )
            : 'none';
        object.fill = fillFrom(props, context, address, resolvedFill);
        const line = mergeProperties([achild(props, 'ln'), themeLine]);
        object.stroke = fillFrom(
          line,
          context,
          address,
          'none',
          resolveColor(lineRef, context, address)?.slice(1),
        );
        object.strokeWidth = (numeric(line, 'w', 0) / 9525) * world.scaleX;
        const head = attr(achild(line, 'headEnd'), 'type'),
          tail = attr(achild(line, 'tailEnd'), 'type');
        if (shape === 'line')
          shape =
            head && head !== 'none'
              ? tail && tail !== 'none'
                ? 'double-arrow'
                : 'arrow'
              : tail && tail !== 'none'
                ? 'arrow'
                : 'line';
        object.shape = shape ?? 'rectangle';
        if (geom && ['line', 'straightConnector1'].includes(attr(geom, 'prst') ?? '')) {
          const matrix = multiply(parent, t.matrix);
          let ax = matrix[4],
            ay = matrix[5],
            bx = matrix[0] * t.width + matrix[2] * t.height + matrix[4],
            by = matrix[1] * t.width + matrix[3] * t.height + matrix[5];
          if (head && head !== 'none' && (!tail || tail === 'none'))
            [ax, ay, bx, by] = [bx, by, ax, ay];
          const length = Math.hypot(bx - ax, by - ay),
            thickness = Math.max(1, object.strokeWidth! * 2);
          if (!length) throw new ImportError('INVALID_GEOMETRY', 'A line needs distinct endpoints');
          object.bounds = {
            x: (ax + bx - length) / 2,
            y: (ay + by - thickness) / 2,
            width: length,
            height: thickness,
          };
          object.rotation = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
          object.flipY = false;
          if (shape !== 'line')
            builder.add(
              'LINE_ARROWHEAD',
              'approximation',
              address,
              'Arrow endpoints are retained; arrowhead dimensions use the native marker.',
              true,
            );
        }

        if (object.shape === 'rounded-rectangle') {
          const adjustment = children(achild(geom, 'avLst'), 'gd', ns.a).find(
            (g) => attr(g, 'name') === 'adj',
          );
          const formula = attr(adjustment, 'fmla');
          object.radius =
            Math.min(world.bounds.width, world.bounds.height) *
            (formula?.match(/^val (\d+)$/) ? Number(formula.slice(4)) / 1e5 : 0.16667);
        }
        if (
          geom &&
          object.shape !== 'rounded-rectangle' &&
          children(achild(geom, 'avLst'), 'gd', ns.a).length
        )
          builder.add(
            'SHAPE_ADJUSTMENT',
            'approximation',
            address,
            'Custom shape adjustments use the native preset geometry.',
            true,
          );
        if (shape?.startsWith('arrow-'))
          builder.add(
            'ARROW_GEOMETRY',
            'approximation',
            address,
            'Arrow remains a native editable preset; shaft/head proportions use the native preset.',
            true,
          );
        if (line) {
          const dash = achild(line, 'prstDash');
          if (dash && attr(dash, 'val') !== 'solid')
            builder.add(
              'LINE_DASH',
              'approximation',
              { ...address, part: dash.part, path: dash.path },
              'Office dash pattern uses the native solid stroke.',
              true,
            );
          unknownChildren(
            line,
            [
              'noFill',
              'solidFill',
              'prstDash',
              'custDash',
              'round',
              'bevel',
              'miter',
              'headEnd',
              'tailEnd',
            ],
            ns.a,
            sourcePart,
          );
          if (achild(line, 'custDash'))
            builder.add(
              'LINE_DASH',
              'approximation',
              address,
              'Custom dash pattern uses the native solid stroke.',
              true,
            );
        }
        const body = pchild(node, 'txBody'),
          inheritedBodies = [pchild(mp, 'txBody'), pchild(lp, 'txBody')].filter(
            (v): v is XmlNode => !!v,
          ),
          ph = placeholder(node),
          masterStyles = pchild(master, 'txStyles');
        const styleName = ['title', 'ctrTitle'].includes(attr(ph, 'type') ?? '')
          ? 'titleStyle'
          : attr(ph, 'type') === 'body'
            ? 'bodyStyle'
            : 'otherStyle';
        if (body) {
          const text = importText(
            body,
            inheritedBodies,
            pchild(masterStyles, styleName),
            pchild(root, 'defaultTextStyle'),
            context,
            address,
            world.scaleY,
            achild(style, 'fontRef'),
          );
          object.text = text.text;
          object.runs = text.runs;
          object.typography = text.typography;
          if (txBox && object.fill === 'none' && object.strokeWidth === 0) {
            object.type = 'text';
            object.fill = text.typography.color ?? '#000000';
          }
          if (world.scaleX !== world.scaleY && object.text)
            builder.add(
              'TEXT_SCALE',
              'approximation',
              address,
              'Non-uniform group scaling uses vertical scaling for native font metrics.',
              true,
            );
        }
        if (props) {
          unknownChildren(
            props,
            [
              'xfrm',
              'prstGeom',
              'custGeom',
              'noFill',
              'solidFill',
              'gradFill',
              'pattFill',
              'blipFill',
              'grpFill',
              'ln',
              'effectLst',
            ],
            ns.a,
            sourcePart,
          );
        }
      }
      // A local (even empty) effect list overrides the referenced theme effects.
      // Inspect only the selected style; unused theme decoration has no visual effect.
      let effects = achild(props, 'effectLst');
      if (!effects && !achild(props, 'effectDag')) {
        const effectRef = achild(style, 'effectRef'),
          index = effectRef ? numeric(effectRef, 'idx', 0) : 0;
        if (!Number.isInteger(index) || index < 0)
          throw new ImportError('UNRESOLVED_STYLE', 'Invalid theme effect reference');
        if (index) {
          const themeEffect = children(
            descendants(theme, 'effectStyleLst', ns.a)[0],
            'effectStyle',
            ns.a,
          )[index - 1];
          if (!themeEffect)
            throw new ImportError('UNRESOLVED_STYLE', 'Invalid theme effect reference');
          unknownChildren(themeEffect, ['effectLst'], ns.a, themeEffect.part);
          for (const c of themeEffect.children) auditSlideVocabulary(c, c.part, builder);
          effects = achild(themeEffect, 'effectLst');
        }
      }
      if (effects?.children.length)
        builder.unsupported(
          'SHAPE_EFFECT',
          {
            part: effects.part,
            path: effects.path,
            ...(effects.part === address.part && address.elementId
              ? { elementId: address.elementId }
              : {}),
          },
          'Shadows and other shape effects are not retained. Explicitly exclude these effects or stop.',
        );
      unknownChildren(
        node,
        [
          'nvSpPr',
          'nvCxnSpPr',
          'nvPicPr',
          'nvGraphicFramePr',
          'spPr',
          'txBody',
          'style',
          'blipFill',
          'xfrm',
          'a:graphic',
        ],
        ns.p,
        sourcePart,
      );
      if (Math.abs(world.scaleX - world.scaleY) > 1e-8)
        builder.add(
          'NONUNIFORM_STYLE_METRICS',
          'approximation',
          address,
          'World geometry is retained; native stroke/corner and font metrics use one scale instead of anisotropic Office styling.',
          true,
        );
      textCharacters +=
        object.text.length +
        (object.table?.rows.flat().reduce((n, cell) => n + cell.length, 0) ?? 0);
      if (textCharacters > importLimits.textCharacters)
        throw new ImportError('TEXT_LIMIT', 'More than 1,000,000 imported text characters');
      auditSlideVocabulary(node, sourcePart, builder);
      slide.objects.push(object);
      mapping.push({ source: address, nativeIds: [object.id] });
      builder.add(
        'NATIVE_ELEMENT',
        inherited ? 'resolved' : 'native',
        address,
        `${object.type} is an editable native element.`,
      );
    }
    const masterVisible =
      !['0', 'false'].includes(attr(page, 'showMasterSp') ?? '1') &&
      !['0', 'false'].includes(attr(layout, 'showMasterSp') ?? '1');
    for (const [sourcePart, sourceRoot, inherited] of [
      [masterPart, master, true],
      [layoutPart, layout, true],
      [part, page, false],
    ] as const) {
      if (!sourcePart || !sourceRoot) continue;
      if (sourcePart === masterPart && !masterVisible) continue;
      if (sourcePart === layoutPart && ['0', 'false'].includes(attr(page, 'showMasterSp') ?? '1'))
        continue;
      const tree = pchild(pchild(sourceRoot, 'cSld'), 'spTree');
      if (!tree) throw new ImportError('INVALID_SLIDE', `${sourcePart}: missing shape tree`);
      for (const node of tree.children) {
        if (node.uri === ns.p && ['nvGrpSpPr', 'grpSpPr'].includes(node.local)) continue;
        // Placeholder sample text on layouts/masters is not slide content. Its values are resolved for the actual slide placeholder above.
        if (inherited && placeholder(node)) continue;
        await addObject(node, sourcePart, identity, undefined, inherited);
      }
    }
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
      mapping,
    },
    opts,
    signal,
  );
}
