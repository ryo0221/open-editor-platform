import { unionBounds, type ShapeKind } from '@editor-platform/editor-core';
import type { Slide, SlideObject } from '@editor-platform/slide/model';
import {
  attribute as attr,
  children,
  descendants,
  namespaces as ns,
  ImportError,
  importLimits,
  type XmlNode,
  type OfficeSourceAddress,
} from '@editor-platform/office-import-core';
import { multiply, numeric, transform, worldBox, type Matrix } from './geometry';
import {
  achild,
  customShape,
  drawingHidden,
  fillElements,
  inheritedPlaceholder,
  mergeProperties,
  nv,
  pchild,
  pick,
  placeholder,
  sourceAddress,
} from './ooxml';
import { fillFrom, resolveColor, type ThemeContext } from './style';
import { importText, plainText } from './text';
import { auditSlideVocabulary } from './audit';
import type { SlideImportSession } from './session';
/** One selected source slide with its resolved layout, master and theme. */
export interface SlidePage {
  part: string;
  page: XmlNode;
  layoutPart?: string;
  layout?: XmlNode;
  masterPart?: string;
  master?: XmlNode;
  theme?: XmlNode;
  context: ThemeContext;
  slide: Slide;
}
/** A placed non-group drawing whose native object is being converted. */
interface Drawing {
  node: XmlNode;
  sourcePart: string;
  address: OfficeSourceAddress;
  parent: Matrix;
  lp?: XmlNode;
  mp?: XmlNode;
  style?: XmlNode;
  props?: XmlNode;
  geometrySources: (XmlNode | undefined)[];
  t: ReturnType<typeof transform>;
  world: NonNullable<ReturnType<typeof worldBox>>;
  object: SlideObject;
}
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
const drawingKinds = ['sp', 'cxnSp', 'pic', 'graphicFrame', 'grpSp'];
const groupProperties = ['nvGrpSpPr', 'grpSpPr'];
export async function addObject(
  s: SlideImportSession,
  page: SlidePage,
  node: XmlNode,
  sourcePart: string,
  parent: Matrix,
  groupId?: string,
  inherited = false,
): Promise<void> {
  s.countObject();
  const address = sourceAddress(sourcePart, node);
  if (node.uri !== ns.p || !drawingKinds.includes(node.local)) {
    s.builder.unsupported(
      'DRAWING_UNSUPPORTED',
      address,
      `Drawing ${node.local} cannot be converted. A verified element image is unavailable; explicitly exclude the element or stop.`,
    );
    return;
  }
  s.metadataAndLinks(node, sourcePart);
  if (node.local === 'grpSp')
    return addGroup(s, page, node, sourcePart, address, parent, groupId, inherited);
  const d = placeDrawing(s, page, node, sourcePart, address, parent, groupId);
  if (!d) return;
  const converted =
    node.local === 'pic'
      ? await convertPicture(s, d)
      : node.local === 'graphicFrame'
        ? convertTable(s, page, d)
        : convertShape(s, page, d);
  if (!converted) return;
  auditEffects(s, page, d);
  finishObject(s, page, d, inherited);
}
async function addGroup(
  s: SlideImportSession,
  page: SlidePage,
  node: XmlNode,
  sourcePart: string,
  address: OfficeSourceAddress,
  parent: Matrix,
  groupId: string | undefined,
  inherited: boolean,
) {
  const properties = pchild(node, 'grpSpPr'),
    xf = achild(properties, 'xfrm');
  if (!xf) throw new ImportError('INVALID_GEOMETRY', `${sourcePart}: missing group transform`);
  if (properties) s.unknownChildren(properties, ['xfrm'], ns.a, sourcePart);
  auditSlideVocabulary(
    { ...node, children: node.children.filter((n) => groupProperties.includes(n.local)) },
    sourcePart,
    s.builder,
  );
  const group = s.id('group'),
    start = page.slide.objects.length;
  const groupObject: SlideObject = {
    id: group,
    type: 'group',
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    fill: 'none',
    text: '',
    ...(drawingHidden(node) ? { hidden: true } : {}),
    ...(groupId ? { groupId } : {}),
  };
  page.slide.objects.push(groupObject);
  const groupMatrix = multiply(parent, transform(xf, true).matrix);
  for (const c of node.children)
    if (!groupProperties.includes(c.local))
      await addObject(s, page, c, sourcePart, groupMatrix, group, inherited);
  const members = page.slide.objects.slice(start + 1);
  if (members.length) groupObject.bounds = unionBounds(members.map((o) => o.bounds));
  s.mapping.push({ source: address, nativeIds: [group] });
  s.builder.add(
    'GROUP_WORLD_COORDINATES',
    'resolved',
    address,
    'Group child coordinates and stacking order are flattened into native world coordinates. Group membership remains editable.',
  );
}
/** Resolves placeholder inheritance and world geometry; undefined when the drawing is skipped. */
function placeDrawing(
  s: SlideImportSession,
  page: SlidePage,
  node: XmlNode,
  sourcePart: string,
  address: OfficeSourceAddress,
  parent: Matrix,
  groupId: string | undefined,
): Drawing | undefined {
  const lp = sourcePart === page.part ? inheritedPlaceholder(node, page.layout) : undefined,
    mp = inheritedPlaceholder(lp ?? node, page.master),
    chain = [node, lp, mp];
  const geometrySources = chain.map((n) => pchild(n, 'spPr'));
  const xfrm =
    node.local === 'graphicFrame' ? pchild(node, 'xfrm') : pick(geometrySources, 'xfrm', ns.a);
  if (!xfrm)
    throw new ImportError(
      'UNRESOLVED_GEOMETRY',
      `${sourcePart}${node.path}: no local/layout/master transform`,
    );
  const t = transform(xfrm),
    world = worldBox(multiply(parent, t.matrix), t.width, t.height);
  if (!world) {
    s.builder.unsupported(
      'SKEWED_GROUP',
      address,
      'Combined group transforms require skew, which native Slide does not represent.',
    );
    return undefined;
  }
  const object: SlideObject = {
    id: s.id(),
    type: 'shape',
    bounds: world.bounds,
    rotation: world.rotation,
    flipY: world.flipY,
    text: '',
    fill: 'none',
    ...(drawingHidden(node) ? { hidden: true } : {}),
    ...(groupId ? { groupId } : {}),
  };
  return {
    node,
    sourcePart,
    address,
    parent,
    lp,
    mp,
    style: mergeProperties(chain.map((n) => pchild(n, 'style'))),
    props: mergeProperties(geometrySources),
    geometrySources,
    t,
    world,
    object,
  };
}
async function convertPicture(s: SlideImportSession, d: Drawing) {
  const { node, sourcePart, address, object } = d;
  const fill = pchild(node, 'blipFill'),
    blip = achild(fill, 'blip');
  const rel = attr(blip, 'embed', ns.rel) ?? attr(blip, 'link', ns.rel);
  if (!rel) throw new ImportError('INVALID_IMAGE', `${sourcePart}: missing image relationship`);
  const relation = s.pkg.relationship(sourcePart, rel, 'image');
  if (relation.external) {
    s.builder.unsupported(
      'EXTERNAL_IMAGE',
      address,
      'External images are never fetched. Supply an embedded PNG/JPEG copy or exclude this image.',
    );
    return false;
  }
  const asset = await s.imageAsset(relation.target, address);
  if (!asset) return false;
  object.type = 'image';
  s.countNativeAsset(asset.src.length);
  object.src = asset.src;
  object.alt = attr(pchild(nv(node), 'cNvPr'), 'descr') ?? '';
  object.imageFit = 'fit';
  object.crop = imageCrop(s, d, achild(fill, 'srcRect'), asset.width / asset.height);
  auditPictureFill(s, d, fill, blip);
  return true;
}
function imageCrop(s: SlideImportSession, d: Drawing, crop: XmlNode | undefined, ratio: number) {
  const { bounds } = d.world;
  const l = numeric(crop, 'l', 0) / 1e5,
    r = numeric(crop, 'r', 0) / 1e5,
    top = numeric(crop, 't', 0) / 1e5,
    bottom = numeric(crop, 'b', 0) / 1e5;
  if ([l, r, top, bottom].some((v) => v < 0 || v >= 1) || l + r >= 1 || top + bottom >= 1)
    throw new ImportError(
      'INVALID_CROP',
      'Crop is outside the supported positive source rectangle',
    );
  const fullW = bounds.width / (1 - l - r),
    fullH = bounds.height / (1 - top - bottom);
  if (Math.abs(fullW / fullH / ratio - 1) > 0.002) {
    s.builder.add(
      'IMAGE_STRETCH',
      'approximation',
      d.address,
      'Office stretches this image non-uniformly. Native image placement preserves its aspect ratio; inspect crop and framing.',
      true,
    );
  }
  const containW = Math.min(bounds.width, bounds.height * ratio),
    containH = containW / ratio,
    scale = Math.max(fullW / containW, fullH / containH);
  return {
    scale,
    x: -l * containW * scale - (bounds.width * scale - containW * scale) / 2,
    y: -top * containH * scale - (bounds.height * scale - containH * scale) / 2,
  };
}
function auditPictureFill(
  s: SlideImportSession,
  d: Drawing,
  fill: XmlNode | undefined,
  blip: XmlNode | undefined,
) {
  const { sourcePart, object } = d;
  if (fill) s.unknownChildren(fill, ['blip', 'srcRect', 'stretch'], ns.a, sourcePart);
  if (blip) {
    s.unknownChildren(blip, ['alphaModFix'], ns.a, sourcePart);
    for (const alpha of children(blip, 'alphaModFix', ns.a)) {
      const value = numeric(alpha, 'amt', 100000) / 100000;
      if (value < 0 || value > 1)
        throw new ImportError('IMAGE_ALPHA', 'Image opacity is outside the native range');
      object.opacity = (object.opacity ?? 1) * value;
    }
  }
  const stretch = achild(fill, 'stretch');
  if (stretch && achild(stretch, 'fillRect')?.attributes.length)
    s.builder.unsupported(
      'IMAGE_FILL_RECT',
      { part: sourcePart, path: stretch.path },
      'Non-default image fillRect is not supported.',
    );
}
const tableUri = 'http://schemas.openxmlformats.org/drawingml/2006/table';
const mergeAttributes = ['rowSpan', 'gridSpan', 'hMerge', 'vMerge'];
const mergedCell = (c: XmlNode) =>
  mergeAttributes.some(
    (k) => attr(c, k) !== undefined && attr(c, k) !== '1' && attr(c, k) !== '0',
  ) ||
  attr(c, 'hMerge') === '1' ||
  attr(c, 'vMerge') === '1';
function convertTable(s: SlideImportSession, page: SlidePage, d: Drawing) {
  const { node, sourcePart, address, object } = d;
  const data = achild(achild(node, 'graphic'), 'graphicData'),
    table = achild(data, 'tbl');
  if (!data || attr(data, 'uri') !== tableUri || !table) {
    s.builder.unsupported(
      'GRAPHIC_UNSUPPORTED',
      address,
      'Charts, SmartArt and other graphic frames need a verified element renderer or explicit exclusion.',
    );
    return false;
  }
  const rows = children(table, 'tr', ns.a),
    grid = children(achild(table, 'tblGrid'), 'gridCol', ns.a);
  if (!rows.length || !grid.length || rows.length * grid.length > importLimits.cells)
    throw new ImportError('TABLE_LIMIT', 'Invalid or oversized slide table');
  const cells = rows.map((row) => children(row, 'tc', ns.a));
  if (cells.some((row) => row.length !== grid.length) || cells.flat().some(mergedCell)) {
    s.builder.unsupported(
      'MERGED_SLIDE_TABLE',
      address,
      'Merged presentation tables are outside this native import profile.',
    );
    return false;
  }
  const [widths, heights] = tableGeometry(s, d, grid, rows);
  object.type = 'table';
  object.table = {
    rows: cells.map((row) => row.map((c) => plainText(achild(c, 'txBody')))),
    columnWidths: widths,
    rowHeights: heights,
    header: attr(achild(table, 'tblPr'), 'firstRow') !== '0',
  };
  object.typography = { fontFamily: page.context.font, fontSize: 16, padding: 8 };
  s.builder.add(
    'TABLE_STYLE',
    'approximation',
    address,
    'Table cells and dimensions stay editable. Native tables use a uniform text/cell style; Office per-cell rich formatting and theme styling are not retained.',
    true,
  );
  s.unknownChildren(table, ['tblPr', 'tblGrid', 'tr'], ns.a, sourcePart);
  for (const row of cells)
    for (const cell of row) {
      s.unknownChildren(cell, ['txBody', 'tcPr'], ns.a, sourcePart);
      for (const text of descendants(cell, 'hlinkClick', ns.a))
        s.metadataAndLinks(text, sourcePart);
    }
  return true;
}
function tableGeometry(s: SlideImportSession, d: Drawing, grid: XmlNode[], rows: XmlNode[]) {
  const { world } = d;
  const widths = grid.map((c) => (numeric(c, 'w') / 9525) * world.scaleX),
    heights = rows.map((c) => (numeric(c, 'h') / 9525) * world.scaleY);
  if (widths.some((v) => v <= 0) || heights.some((v) => v < 0))
    throw new ImportError('INVALID_TABLE', 'Non-positive table geometry');
  if (heights.some((v) => v === 0)) {
    s.builder.add(
      'TABLE_AUTO_HEIGHT',
      'approximation',
      d.address,
      'Office automatic row heights use a native minimum of 32 CSS pixels.',
      true,
    );
    heights.forEach((v, i) => {
      if (!v) heights[i] = 32 * world.scaleY;
    });
  }
  return [widths, heights] as const;
}
const openEnd = (end: string | undefined) => !!end && end !== 'none';
const connectorKind = (head: string | undefined, tail: string | undefined): ShapeKind =>
  openEnd(head) ? (openEnd(tail) ? 'double-arrow' : 'arrow') : openEnd(tail) ? 'arrow' : 'line';
const connectorPresets = ['line', 'straightConnector1'];
const lineChildren = [
  'noFill',
  'solidFill',
  'prstDash',
  'custDash',
  'round',
  'bevel',
  'miter',
  'headEnd',
  'tailEnd',
];
const shapePropertyChildren = ['xfrm', 'prstGeom', 'custGeom', ...fillElements, 'ln', 'effectLst'];
/** The native preset a shape geometry maps to; undefined (diagnosed) when it has none. */
function shapeGeometry(s: SlideImportSession, d: Drawing) {
  const { node } = d;
  const geom = pick(d.geometrySources, 'prstGeom', ns.a),
    custom = pick(d.geometrySources, 'custGeom', ns.a);
  const preset = geom
    ? shapeKinds[attr(geom, 'prst') ?? '']
    : custom
      ? customShape(custom, d.t.width, d.t.height)
      : undefined;
  const txBox =
    attr(pchild(nv(node), node.local === 'cxnSp' ? 'cNvCxnSpPr' : 'cNvSpPr'), 'txBox') === '1' ||
    (!!placeholder(node) && !geom && !custom);
  if (!preset && (!txBox || !!geom || !!custom)) {
    s.builder.unsupported(
      'SHAPE_UNSUPPORTED',
      d.address,
      `Shape ${attr(geom, 'prst') ?? 'custom geometry'} has no supported native representation. Explicitly exclude it or stop.`,
    );
    return undefined;
  }
  return { geom, preset, txBox };
}
function convertShape(s: SlideImportSession, page: SlidePage, d: Drawing) {
  const { sourcePart, object, props } = d;
  const geometry = shapeGeometry(s, d);
  if (!geometry) return false;
  const { geom, preset, txBox } = geometry;
  const line = applyShapeStyle(s, page, d);
  const head = attr(achild(line, 'headEnd'), 'type'),
    tail = attr(achild(line, 'tailEnd'), 'type');
  const shape = preset === 'line' ? connectorKind(head, tail) : preset;
  object.shape = shape ?? 'rectangle';
  if (geom && connectorPresets.includes(attr(geom, 'prst') ?? ''))
    placeConnector(s, d, openEnd(head) && !openEnd(tail), shape !== 'line');
  if (object.shape === 'rounded-rectangle') object.radius = cornerRadius(d, geom);
  auditShapeGeometry(s, d, geom, shape);
  if (line) auditLine(s, d, line);
  applyText(s, page, d, txBox);
  if (props) s.unknownChildren(props, shapePropertyChildren, ns.a, sourcePart);
  return true;
}
/** Applies theme-referenced and local fill/stroke; returns the effective line properties. */
function applyShapeStyle(s: SlideImportSession, page: SlidePage, d: Drawing) {
  const { address, object, props, style } = d;
  const { context, theme } = page;
  const fillRef = achild(style, 'fillRef'),
    lineRef = achild(style, 'lnRef');
  const fillIndex = fillRef ? numeric(fillRef, 'idx', 0) : 0,
    lineIndex = lineRef ? numeric(lineRef, 'idx', 0) : 0;
  const themeFill = themeStyle(theme, 'fillStyleLst', fillIndex),
    themeLine = themeStyle(theme, 'lnStyleLst', lineIndex);
  const hasLocalFill = props?.children.some(
    (n) => n.uri === ns.a && fillElements.includes(n.local),
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
  object.strokeWidth = (numeric(line, 'w', 0) / 9525) * d.world.scaleX;
  return line;
}
/** The 1-based theme style a `fillRef`/`lnRef` index selects; index 0 selects none. */
function themeStyle(theme: XmlNode | undefined, list: string, index: number) {
  if (!index) return undefined;
  const selected = (descendants(theme, list, ns.a)[0]?.children ?? [])[index - 1];
  if (!selected) throw new ImportError('UNRESOLVED_STYLE', 'Invalid theme style reference');
  return selected;
}
/** Straight connectors become a native line box between their two world endpoints. */
function placeConnector(s: SlideImportSession, d: Drawing, reversed: boolean, arrow: boolean) {
  const { object, t } = d;
  const matrix = multiply(d.parent, t.matrix);
  let ax = matrix[4],
    ay = matrix[5],
    bx = matrix[0] * t.width + matrix[2] * t.height + matrix[4],
    by = matrix[1] * t.width + matrix[3] * t.height + matrix[5];
  if (reversed) [ax, ay, bx, by] = [bx, by, ax, ay];
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
  if (arrow)
    s.builder.add(
      'LINE_ARROWHEAD',
      'approximation',
      d.address,
      'Arrow endpoints are retained; arrowhead dimensions use the native marker.',
      true,
    );
}
function cornerRadius(d: Drawing, geom: XmlNode | undefined) {
  const adjustment = children(achild(geom, 'avLst'), 'gd', ns.a).find(
    (g) => attr(g, 'name') === 'adj',
  );
  const formula = attr(adjustment, 'fmla');
  return (
    Math.min(d.world.bounds.width, d.world.bounds.height) *
    (formula?.match(/^val (\d+)$/) ? Number(formula.slice(4)) / 1e5 : 0.16667)
  );
}
function auditShapeGeometry(
  s: SlideImportSession,
  d: Drawing,
  geom: XmlNode | undefined,
  shape: ShapeKind | undefined,
) {
  if (
    geom &&
    d.object.shape !== 'rounded-rectangle' &&
    children(achild(geom, 'avLst'), 'gd', ns.a).length
  )
    s.builder.add(
      'SHAPE_ADJUSTMENT',
      'approximation',
      d.address,
      'Custom shape adjustments use the native preset geometry.',
      true,
    );
  if (shape?.startsWith('arrow-'))
    s.builder.add(
      'ARROW_GEOMETRY',
      'approximation',
      d.address,
      'Arrow remains a native editable preset; shaft/head proportions use the native preset.',
      true,
    );
}
function auditLine(s: SlideImportSession, d: Drawing, line: XmlNode) {
  const dash = achild(line, 'prstDash');
  if (dash && attr(dash, 'val') !== 'solid')
    s.builder.add(
      'LINE_DASH',
      'approximation',
      { ...d.address, part: dash.part, path: dash.path },
      'Office dash pattern uses the native solid stroke.',
      true,
    );
  s.unknownChildren(line, lineChildren, ns.a, d.sourcePart);
  if (achild(line, 'custDash'))
    s.builder.add(
      'LINE_DASH',
      'approximation',
      d.address,
      'Custom dash pattern uses the native solid stroke.',
      true,
    );
}
const textStyleName = (type: string | undefined) =>
  ['title', 'ctrTitle'].includes(type ?? '')
    ? 'titleStyle'
    : type === 'body'
      ? 'bodyStyle'
      : 'otherStyle';
function applyText(s: SlideImportSession, page: SlidePage, d: Drawing, txBox: boolean) {
  const { node, object, world } = d;
  const body = pchild(node, 'txBody');
  if (!body) return;
  const inheritedBodies = [pchild(d.mp, 'txBody'), pchild(d.lp, 'txBody')].filter(
    (v): v is XmlNode => !!v,
  );
  const text = importText(
    body,
    inheritedBodies,
    pchild(pchild(page.master, 'txStyles'), textStyleName(attr(placeholder(node), 'type'))),
    pchild(s.root, 'defaultTextStyle'),
    page.context,
    d.address,
    world.scaleY,
    achild(d.style, 'fontRef'),
  );
  object.text = text.text;
  object.runs = text.runs;
  object.typography = text.typography;
  if (txBox && object.fill === 'none' && object.strokeWidth === 0) {
    object.type = 'text';
    object.fill = text.typography.color ?? '#000000';
  }
  if (world.scaleX !== world.scaleY && object.text)
    s.builder.add(
      'TEXT_SCALE',
      'approximation',
      d.address,
      'Non-uniform group scaling uses vertical scaling for native font metrics.',
      true,
    );
}
/**
 * A local (even empty) effect list overrides the referenced theme effects.
 * Inspect only the selected style; unused theme decoration has no visual effect.
 */
function selectedEffects(s: SlideImportSession, page: SlidePage, d: Drawing) {
  const local = achild(d.props, 'effectLst');
  if (local || achild(d.props, 'effectDag')) return local;
  const effectRef = achild(d.style, 'effectRef'),
    index = effectRef ? numeric(effectRef, 'idx', 0) : 0;
  if (!Number.isInteger(index) || index < 0)
    throw new ImportError('UNRESOLVED_STYLE', 'Invalid theme effect reference');
  if (!index) return undefined;
  const themeEffect = children(
    descendants(page.theme, 'effectStyleLst', ns.a)[0],
    'effectStyle',
    ns.a,
  )[index - 1];
  if (!themeEffect) throw new ImportError('UNRESOLVED_STYLE', 'Invalid theme effect reference');
  s.unknownChildren(themeEffect, ['effectLst'], ns.a, themeEffect.part);
  for (const c of themeEffect.children) auditSlideVocabulary(c, c.part, s.builder);
  return achild(themeEffect, 'effectLst');
}
function auditEffects(s: SlideImportSession, page: SlidePage, d: Drawing) {
  const effects = selectedEffects(s, page, d);
  if (!effects?.children.length) return;
  s.builder.unsupported(
    'SHAPE_EFFECT',
    {
      part: effects.part,
      path: effects.path,
      ...(effects.part === d.address.part && d.address.elementId
        ? { elementId: d.address.elementId }
        : {}),
    },
    'Shadows and other shape effects are not retained. Explicitly exclude these effects or stop.',
  );
}
const drawingChildren = [
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
];
function finishObject(s: SlideImportSession, page: SlidePage, d: Drawing, inherited: boolean) {
  const { node, sourcePart, address, object, world } = d;
  s.unknownChildren(node, drawingChildren, ns.p, sourcePart);
  if (Math.abs(world.scaleX - world.scaleY) > 1e-8)
    s.builder.add(
      'NONUNIFORM_STYLE_METRICS',
      'approximation',
      address,
      'World geometry is retained; native stroke/corner and font metrics use one scale instead of anisotropic Office styling.',
      true,
    );
  s.countText(
    object.text.length + (object.table?.rows.flat().reduce((n, cell) => n + cell.length, 0) ?? 0),
  );
  auditSlideVocabulary(node, sourcePart, s.builder);
  page.slide.objects.push(object);
  s.mapping.push({ source: address, nativeIds: [object.id] });
  s.builder.add(
    'NATIVE_ELEMENT',
    inherited ? 'resolved' : 'native',
    address,
    `${object.type} is an editable native element.`,
  );
}
