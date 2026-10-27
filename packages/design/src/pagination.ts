import { clone, contentHash, deepFreeze, type Artifact } from '@editor-platform/artifact-core';
import {
  command,
  withCommandReads,
  drawingSvg,
  descendantIds,
  transaction,
  type Bounds,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  assertDesignContent,
  appearance,
  insertElement,
  updateElement,
  transformElements,
  designDrawings,
  designPaintOrder,
  type DesignContent,
} from './model';
import { designExportPaintBounds } from './paint-bounds';
import { captureDesignData } from './command-data';
import { validDesignPagination, type DesignPagination } from './pagination-contract';
export * from './pagination-contract';

export function setDesignPagination(value: DesignPagination): EditorCommand<DesignContent> {
  const owned = captureDesignData(value, true);
  return withCommandReads(
    command('design.pagination', 'Set page reading order', (d) => {
      if (!validDesignPagination(owned, d.elements))
        throw Error('Invalid page/panel IDs or reading order');
      const next = { ...d, pagination: clone(owned) };
      assertDesignContent(next);
      return next;
    }),
    { content: ['*'] },
  );
}
export function insertDesignPage(
  bounds: Bounds,
  id?: string,
): EditorCommand<DesignContent> & { elementId: string } {
  const insert = insertElement('frame', { bounds, ...(id === undefined ? {} : { id }) });
  const elementId = insert.elementId;
  return {
    ...withCommandReads(
      command('design.page.insert', 'Insert page', (d) => {
        const next = insert.apply(d);
        return setDesignPagination({
          ...(d.pagination ?? { schemaVersion: 1, direction: 'rtl', pages: [], images: [] }),
          pages: [...(d.pagination?.pages ?? []), { frameId: elementId, panelIds: [] }],
        }).apply(next);
      }),
      { content: ['*'] },
    ),
    elementId,
  };
}
export function insertDesignPanel(
  pageId: string,
  bounds: Bounds,
  id?: string,
): EditorCommand<DesignContent> & { elementId: string } {
  const insert = insertElement('frame', {
    parentId: pageId,
    bounds,
    ...(id === undefined ? {} : { id }),
  });
  return {
    ...withCommandReads(
      command('design.panel.insert', 'Insert panel', (d) => {
        if (!d.pagination?.pages.some((p) => p.frameId === pageId)) throw Error('Unknown page');
        const next = insert.apply(d);
        return setDesignPagination({
          ...d.pagination,
          pages: d.pagination.pages.map((p) =>
            p.frameId === pageId ? { ...p, panelIds: [...p.panelIds, insert.elementId] } : p,
          ),
        }).apply(next);
      }),
      { content: ['*'] },
    ),
    elementId: insert.elementId,
  };
}
/** Deliberately narrow data adapter: unsupported keys/types are refused before preview. */
export function designPageEditCommand(raw: unknown): EditorCommand<DesignContent> {
  const edits = captureDesignData(raw, true);
  if (!Array.isArray(edits) || !edits.length || edits.length > 100)
    throw Error('Expected 1–100 page edits');
  const commands = edits.map((edit: unknown) => {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw Error('Invalid page edit');
    const e = edit as Record<string, unknown>;
    if (
      Object.keys(e).length !== 3 ||
      typeof e.id !== 'string' ||
      !e.id ||
      !Object.hasOwn(e, 'value')
    )
      throw Error('Unsupported page edit');
    if (e.type !== 'text' && e.type !== 'bounds' && e.type !== 'image')
      throw Error('Unsupported page edit type');
    if (e.type === 'text' && typeof e.value !== 'string') throw Error('Expected text/image string');
    if (e.type === 'image' && (!e.value || typeof e.value !== 'object' || Array.isArray(e.value)))
      throw Error('Image edit requires src/source/license');
    const image =
      e.type === 'image'
        ? (e.value as { src: string; source: string; license: string })
        : undefined;
    if (
      image &&
      (!image.src ||
        typeof image.source !== 'string' ||
        typeof image.license !== 'string' ||
        Object.keys(image).sort().join(',') !== 'license,source,src')
    )
      throw Error('Image edit requires src/source/license');
    const patch =
      e.type === 'text'
        ? { text: e.value as string }
        : image
          ? { src: image.src }
          : { bounds: e.value as Bounds };
    return command<DesignContent>('design.page.edit', 'Edit page element', (d) => {
      const target = d.elements.find((el) => el.id === e.id);
      if (
        !d.pagination ||
        !target ||
        target.type !== (e.type === 'text' ? 'text' : e.type === 'image' ? 'image' : target.type)
      )
        throw Error('Missing or unsupported page edit target');
      if (
        !descendantIds(
          d.elements,
          d.pagination.pages.map((p) => p.frameId),
        ).has(target.id) ||
        !['frame', 'rectangle', 'shape', 'text', 'image', 'group'].includes(target.type)
      )
        throw Error('Target is outside the M0 page subset');
      if (e.type === 'text' && appearance(d, target).runs?.length)
        throw Error('Formatted dialogue requires native text preparation');
      if (e.type === 'bounds') {
        const b = e.value as Bounds;
        if (
          !b ||
          Object.keys(b).sort().join(',') !== 'height,width,x,y' ||
          !Object.values(b).every((v) => typeof v === 'number' && Number.isFinite(v)) ||
          b.width < 1 ||
          b.height < 1
        )
          throw Error('Invalid panel bounds');
        return transformElements([target.id], {
          dx: b.x - target.bounds.x,
          dy: b.y - target.bounds.y,
          dw: b.width - target.bounds.width,
          dh: b.height - target.bounds.height,
        }).apply(d);
      }
      const next = updateElement(e.id as string, patch).apply(d);
      return image
        ? setDesignPagination({
            ...d.pagination,
            images: [
              ...d.pagination.images.filter((i) => i.elementId !== e.id),
              { elementId: e.id as string, source: image.source, license: image.license },
            ],
          }).apply(next)
        : next;
    });
  });
  return withCommandReads(transaction('Edit page elements', commands), { content: ['*'] });
}
export interface DesignPageDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  elementId?: string;
  message: string;
}
/** Captures one immutable Design source; PNG/PDF encoding is the existing canvas-ui adapter. */
export async function captureDesignPages(
  artifact: Artifact<DesignContent>,
  versionId: string,
  options: { mode: 'm0' | 'vector' } = { mode: 'm0' },
) {
  const settings = captureDesignData(options, true);
  if (Object.keys(settings).length !== 1 || !['m0', 'vector'].includes(settings.mode))
    throw Error('Unsupported page capture mode');
  const source = clone(artifact);
  const selected = source.versions.filter((v) => v.versionId === versionId);
  if (source.kind !== 'design' || !versionId || selected.length !== 1)
    throw Error('Select one exact Design version');
  const saved = selected[0];
  assertDesignContent(saved.content);
  if (saved.artifactId !== source.id || (await contentHash(saved.content)) !== saved.contentHash)
    throw Error('Design source hash/ownership mismatch');
  const d = saved.content;
  if (!d.pagination?.pages.length) throw Error('No page reading order');
  const diagnostics: DesignPageDiagnostic[] = [
    {
      code: 'raster-pdf',
      severity: 'warning',
      message:
        'PNG/PDF are derived raster representations; native editing, annotations, typography and vector fidelity are not preserved. Vertical text and ruby are unsupported.' +
        (settings.mode === 'm0' ? ' Balloon paths require explicit vector capture.' : ''),
    },
  ];
  if (d.reuse)
    diagnostics.push({
      code: 'reuse',
      severity: 'error',
      message: 'M0 capture does not flatten linked reuse dependencies',
    });
  const textStyleKeys = [
    'fontFamily',
    'fontSize',
    'bold',
    'italic',
    'underline',
    'strike',
    'color',
    'lineHeight',
    'letterSpacing',
    'align',
    'verticalAlign',
    'padding',
    'list',
    'overflow',
  ];
  const pages = d.pagination.pages.map((p) => {
    const frame = d.elements.find((e) => e.id === p.frameId)!;
    const ids = descendantIds(d.elements, [frame.id]);
    const elements = designPaintOrder(d).filter((e) => ids.has(e.id));
    for (const e of elements) {
      const effective = appearance(d, e);
      if (
        [effective.typography, ...(effective.runs ?? []).map((r) => r.style)].some(
          (style) => style && Object.keys(style).some((k) => !textStyleKeys.includes(k)),
        )
      )
        diagnostics.push({
          code: 'text-style',
          severity: 'error',
          elementId: e.id,
          message: 'Unknown text features (including vertical text/ruby) are unsupported',
        });
      const paint =
        settings.mode === 'vector' && e.id !== frame.id
          ? designExportPaintBounds(designDrawings(d, e), e.bounds, effective.rotation)
          : e.bounds;
      if (
        paint.x < frame.bounds.x ||
        paint.y < frame.bounds.y ||
        paint.x + paint.width > frame.bounds.x + frame.bounds.width ||
        paint.y + paint.height > frame.bounds.y + frame.bounds.height
      )
        diagnostics.push({
          code: 'page-crop',
          severity: 'warning',
          elementId: e.id,
          message: 'Element extends outside the page and may be cropped',
        });
      if (e.hidden)
        diagnostics.push({
          code: 'hidden',
          severity: 'warning',
          elementId: e.id,
          message: 'Hidden element is omitted',
        });
      if (
        effective.reference ||
        (settings.mode === 'm0' && (e.path || e.vector)) ||
        !['frame', 'rectangle', 'shape', 'text', 'image', 'group'].includes(e.type) ||
        effective.rotation
      )
        diagnostics.push({
          code: 'unsupported',
          severity: 'error',
          elementId: e.id,
          message:
            'Page capture rejects references, components, rotations and vector paths without explicit opt-in',
        });
      if (
        e.type === 'image' &&
        (!e.src ||
          !/^data:image\/(png|jpeg|webp);base64,/i.test(e.src) ||
          !d.pagination!.images.some((i) => i.elementId === e.id))
      )
        diagnostics.push({
          code: 'image-source',
          severity: 'error',
          elementId: e.id,
          message: 'Capture requires embedded raster data and explicit source/license metadata',
        });
    }
    return {
      name: frame.name,
      frameId: frame.id,
      panelIds: [...p.panelIds],
      width: frame.bounds.width,
      height: frame.bounds.height,
      svg: drawingSvg(
        elements.flatMap((e) => designDrawings(d, e)),
        frame.bounds,
        '#ffffff',
      ),
    };
  });
  const included = descendantIds(
    d.elements,
    d.pagination.pages.map((p) => p.frameId),
  );
  for (const e of d.elements)
    if (!included.has(e.id))
      diagnostics.push({
        code: 'outside-pages',
        severity: 'warning',
        elementId: e.id,
        message: 'Element outside declared pages is omitted',
      });
  if (
    pages.some((p) => p.width > 4096 || p.height > 4096) ||
    pages.reduce((n, p) => n + p.width * p.height, 0) > 64_000_000
  )
    diagnostics.push({
      code: 'pixel-limit',
      severity: 'error',
      message: 'Capture exceeds 4096 px per dimension or 64 million total pixels',
    });
  const ok = !diagnostics.some((d) => d.severity === 'error');
  return deepFreeze({
    ok,
    pages: ok ? pages : [],
    manifest: {
      schemaVersion: 1 as const,
      capability: settings.mode,
      artwork: d.elements
        .filter((e) => included.has(e.id) && (e.path || e.vector))
        .map((e) => ({
          elementId: e.id,
          kind: e.path ? ('path' as const) : ('vector' as const),
          ...(e.vector ? { provenance: e.vector.provenance } : {}),
        })),
      source: { artifactId: source.id, versionId, contentHash: saved.contentHash },
      direction: d.pagination.direction,
      pages: d.pagination.pages,
      images: d.pagination.images,
      diagnostics,
    },
  });
}
