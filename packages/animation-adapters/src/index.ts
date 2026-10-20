import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  isDesign,
  layoutDesign,
  designPaintOrder,
  designDrawings,
  type DesignContent,
} from '@editor-platform/design/model';
import {
  shapePath,
  layoutDrawingText,
  rotatedBounds,
  type Drawing,
} from '@editor-platform/editor-core';
import type { SourceRef } from '@editor-platform/animation-core';
import {
  createAnimation2,
  createAnimationLayer2,
  readAnimation2,
  animationCommand2,
  color2,
  decodeAnimationBase64,
  hashAnimationBytes2,
  inspectAnimationAsset2,
  equivalentAnimationAsset2,
  type AnimationContent2,
  type Asset2,
  type Layer2,
  type VectorPath2,
} from '@editor-platform/animation-core/v2';
export interface AnimationConversionPlan {
  readonly planHash: string;
  readonly source: SourceRef;
  readonly diagnostics: readonly {
    sourceId: string;
    severity: 'error' | 'loss';
    message: string;
  }[];
  readonly content?: AnimationContent2;
}
const plans = new WeakMap<AnimationConversionPlan, AnimationContent2>();
/** Explicit portable subset: absolute/relative M/L/H/V/C/Q/Z, no SVG markup or arc approximation. */
function path2(data: string): VectorPath2 {
  const pattern = /[MLHVCQZmlhvcqz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g,
    tokens: string[] = [];
  let end = 0;
  for (const match of data.matchAll(pattern)) {
    if (!/^[\s,]*$/.test(data.slice(end, match.index))) throw Error('Unsupported vector command');
    tokens.push(match[0]);
    end = match.index + match[0].length;
  }
  if (!/^[\s,]*$/.test(data.slice(end))) throw Error('Unsupported vector command');
  const out: VectorPath2 = [];
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    command = '';
  for (let i = 0; i < tokens.length; ) {
    if (/^[a-z]$/i.test(tokens[i])) command = tokens[i++];
    const upper = command.toUpperCase(),
      relative = command !== upper;
    if (upper === 'Z') {
      out.push(['Z']);
      x = sx;
      y = sy;
      command = '';
      continue;
    }
    const count = ({ M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4 } as Record<string, number>)[upper];
    if (!count || i + count > tokens.length) throw Error('Unsupported vector command');
    const values = tokens.slice(i, i + count).map(Number);
    if (values.some((n) => !Number.isFinite(n))) throw Error('Invalid vector coordinates');
    i += count;
    if (upper === 'H') {
      x = relative ? x + values[0] : values[0];
      out.push(['L', x, y]);
    } else if (upper === 'V') {
      y = relative ? y + values[0] : values[0];
      out.push(['L', x, y]);
    } else {
      for (let j = 0; relative && j < values.length; j += 2) {
        values[j] += x;
        values[j + 1] += y;
      }
      x = values.at(-2)!;
      y = values.at(-1)!;
      out.push([upper, ...values] as VectorPath2[number]);
      if (upper === 'M') {
        sx = x;
        sy = y;
        command = relative ? 'l' : 'L';
      }
    }
  }
  return out;
}
const color = (value: string) => {
  if (value === 'none' || value === 'transparent') return '#00000000';
  if (!color2(value)) throw Error('Only native solid colors can be converted');
  return value;
};
export function captureDesignAnimation(
  source: SourceRef,
  input: DesignContent,
  selection: readonly string[],
  font: Asset2 | null = null,
  id: () => string = () => crypto.randomUUID(),
): AnimationConversionPlan {
  const owned = clone(input),
    sourceRef = clone(source);
  if (!isDesign(owned) || reuseHash(owned) !== sourceRef.contentHash)
    throw Error('Design source snapshot/hash mismatch');
  if (!selection.length || selection.some((key) => !owned.elements.some((e) => e.id === key)))
    throw Error('Select an existing Design frame or element');
  const content = createAnimation2(),
    c = content.compositions[0];
  c.id = id();
  content.rootCompositionId = c.id;
  c.name = 'Converted Design';
  const diagnostics: AnimationConversionPlan['diagnostics'][number][] = [],
    mapping: AnimationContent2['provenance'][number]['mapping'] = [];
  if (font) content.assets.push(clone(font));
  const selected = new Set(selection);
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of owned.elements)
      if (e.parentId && selected.has(e.parentId) && !selected.has(e.id)) {
        selected.add(e.id);
        changed = true;
      }
  }
  const resolved = layoutDesign(owned),
    groupIds = new Map(
      resolved.elements
        .filter((e) => selected.has(e.id) && ['group', 'frame'].includes(e.type))
        .map((e) => [e.id, id()]),
    );
  const selectedRoots = resolved.elements.filter((element) => {
    if (!selection.includes(element.id)) return false;
    let parent = element.parentId;
    while (parent) {
      if (selection.includes(parent)) return false;
      parent = resolved.elements.find((e) => e.id === parent)?.parentId;
    }
    return true;
  });
  const bounds = selectedRoots.map((e) =>
    e.type === 'frame' ? e.bounds : rotatedBounds(e.bounds, e.rotation ?? 0),
  );
  const x = Math.min(...bounds.map((b) => b.x)),
    y = Math.min(...bounds.map((b) => b.y));
  const origin = {
    x,
    y,
    width: Math.max(...bounds.map((b) => b.x + b.width)) - x,
    height: Math.max(...bounds.map((b) => b.y + b.height)) - y,
  };
  c.width = Math.max(1, origin.width);
  c.height = Math.max(1, origin.height);
  function base(d: Drawing, key: string) {
    return {
      ...createAnimationLayer2('group', key, c.duration),
      name: d.id,
      parentId: null,
      transform: {
        x: d.bounds.x - origin.x + d.bounds.width / 2,
        y: d.bounds.y - origin.y + d.bounds.height / 2,
        anchorX: d.bounds.width / 2,
        anchorY: d.bounds.height / 2,
        scaleX: d.flipX ? -1 : 1,
        scaleY: d.flipY ? -1 : 1,
        rotation: d.rotation ?? 0,
        opacity: d.opacity ?? 1,
      },
    };
  }
  for (const raw of designPaintOrder(resolved).filter((e) => selected.has(e.id))) {
    try {
      if (raw.react || raw.web || raw.reference || raw.interactions?.length)
        throw Error('React/Web/interactive Design elements require a separate adapter');
      if (raw.layout || raw.constraints || raw.type === 'instance')
        diagnostics.push({
          sourceId: raw.id,
          severity: 'loss',
          message:
            'Layout, constraints and component ownership are captured as resolved static geometry.',
        });
      if (raw.hidden) continue;
      const parent = raw.parentId ? (groupIds.get(raw.parentId) ?? null) : null;
      const gid = groupIds.get(raw.id);
      if (gid) {
        const group = createAnimationLayer2('group', gid, c.duration);
        group.name = raw.name;
        group.parentId = parent;
        group.transform.x = 0;
        group.transform.y = 0;
        c.layers.push(group);
        mapping.push({ sourceId: raw.id, layerId: gid });
      }
      for (const drawing of designDrawings(resolved, raw)) {
        const d = clone(drawing);
        if (d.hidden || d.kind === 'group') continue;
        if (!['shape', 'text', 'image'].includes(d.kind)) throw Error('Unsupported Design drawing');
        if (
          ['ellipse', 'rounded-rectangle', 'arrow', 'double-arrow'].includes(d.shape ?? '') ||
          (d.arrowhead && d.arrowhead !== 'none') ||
          (d.kind === 'shape' && !!d.text)
        )
          throw Error('This shape or embedded shape label requires an explicit conversion');
        if (d.crop || d.radius || d.dash || d.vector)
          throw Error(
            'Vector libraries, crop, rounded corners and dashed effects need explicit conversion',
          );
        let layer: Layer2;
        const key = id(),
          common = base(d, key);
        if (d.kind === 'image') {
          if (d.imageFit !== 'fit' || d.crop)
            throw Error('Cropped Design images require an explicit fallback');
          const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(d.src ?? '');
          if (!match)
            throw Error(
              'Design images must contain portable PNG/JPEG bytes; external URLs are not fetched',
            );
          const bytes = decodeAnimationBase64(match[2]),
            contentHash = hashAnimationBytes2(bytes),
            mediaType = match[1] as Asset2['mediaType'];
          let asset = content.assets.find(
            (asset) => asset.contentHash === contentHash && asset.mediaType === mediaType,
          );
          if (!asset) {
            asset = {
              id: id(),
              contentHash,
              mediaType,
              base64: match[2],
              attribution: `Retained from Design ${sourceRef.artifactId} / ${sourceRef.versionId}`,
              license: 'Unspecified in Design source',
            };
            inspectAnimationAsset2(asset);
            content.assets.push(asset);
          }
          layer = {
            ...common,
            type: 'image',
            assetId: asset.id,
            width: d.bounds.width,
            height: d.bounds.height,
          };
        } else if (d.kind === 'text') {
          if (!font) throw Error('Choose a pinned font asset before converting text');
          const style = d.typography ?? {};
          if (
            (style.align && style.align !== 'left') ||
            style.letterSpacing ||
            style.list ||
            (style.verticalAlign && style.verticalAlign !== 'top')
          )
            throw Error('Unsupported text alignment, spacing or padding');
          const textLayout = layoutDrawingText(d),
            padding = textLayout.padding;
          common.transform.anchorX -= padding;
          common.transform.anchorY -= padding;
          if (style.overflow !== 'expand')
            d.clipBounds = [...(d.clipBounds ?? []), { ...d.bounds, rotation: d.rotation ?? 0 }];
          const baseStyle = {
            ...(style.bold ? { bold: true } : {}),
            ...(style.italic ? { italic: true } : {}),
            ...(style.underline ? { underline: true } : {}),
          };
          layer = {
            ...common,
            type: 'text',
            text: d.text,
            runs: (d.runs?.length ? d.runs : [{ text: d.text }]).map((run) => ({
              ...run,
              style: {
                ...baseStyle,
                ...run.style,
                fontSize: Math.max(
                  8,
                  ((run.style?.fontSize ?? style.fontSize ?? 28) * textLayout.fontSize) /
                    (style.fontSize ?? 28),
                ),
              },
            })),
            width: Math.max(1, d.bounds.width - padding * 2),
            height: Math.max(1, d.bounds.height - padding * 2),
            fontAssetId: font.id,
            fontSize: textLayout.fontSize,
            lineHeight: style.lineHeight ?? 1.3,
            fill: color(style.color ?? d.fill),
          };
          diagnostics.push({
            sourceId: raw.id,
            severity: 'loss',
            message: 'Text uses the explicitly selected retained font asset.',
          });
        } else if ((d.shape ?? 'rectangle') === 'rectangle')
          layer = {
            ...common,
            type: 'rect',
            width: d.bounds.width,
            height: d.bounds.height,
            fill: color(d.fill),
            stroke: color(d.stroke ?? '#5b6472'),
            strokeWidth: d.strokeWidth ?? 1,
          };
        else
          layer = {
            ...common,
            type: 'path',
            path: path2(shapePath(d.shape!, d.bounds.width, d.bounds.height)),
            fill: color(d.fill),
            stroke: color(d.stroke ?? '#5b6472'),
            strokeWidth: d.strokeWidth ?? 1,
          };
        layer.parentId = gid ?? parent;
        let previous: string | null = null;
        for (const bounds of d.clipBounds ?? []) {
          const maskId = id();
          c.layers.push({
            ...base(
              {
                ...d,
                bounds,
                rotation: bounds.rotation ?? 0,
                opacity: 1,
                flipX: false,
                flipY: false,
              },
              maskId,
            ),
            type: 'rect',
            width: bounds.width,
            height: bounds.height,
            fill: '#000000',
            stroke: '#00000000',
            strokeWidth: 0,
            maskOnly: true,
            parentId: gid ?? parent,
            clipId: previous,
          });
          previous = maskId;
        }
        layer.clipId = previous;
        c.layers.push(layer);
        mapping.push({ sourceId: raw.id, layerId: key });
      }
    } catch (error) {
      diagnostics.push({ sourceId: raw.id, severity: 'error', message: String(error) });
    }
  }
  content.provenance = [
    {
      source: sourceRef,
      mapping,
      losses: diagnostics
        .filter((d) => d.severity === 'loss')
        .map((d) => `${d.sourceId}: ${d.message}`),
    },
  ];
  let checked: AnimationContent2 | undefined;
  if (!diagnostics.some((d) => d.severity === 'error'))
    try {
      checked = readAnimation2(content);
    } catch (error) {
      diagnostics.push({
        sourceId: sourceRef.compositionId,
        severity: 'error',
        message: String(error),
      });
    }
  const plan = deepFreeze({
    planHash: reuseHash({ source: sourceRef, content: checked ?? null, diagnostics }),
    source: sourceRef,
    diagnostics,
    ...(checked ? { content: checked } : {}),
  });
  if (checked) plans.set(plan, checked);
  return plan;
}
export function adoptDesignAnimation(
  plan: AnimationConversionPlan,
  target: AnimationContent2,
  acceptedPlanHash: string,
  scope: { canEdit(): boolean },
) {
  const captured = plans.get(plan);
  if (!captured || plan.planHash !== acceptedPlanHash)
    throw Error('Design conversion must use the reviewed capture and consent');
  const assets = [...target.assets],
    ids = new Map<string, string>();
  for (const asset of captured.assets) {
    const equivalent = assets.find((old) => equivalentAnimationAsset2(old, asset));
    ids.set(asset.id, equivalent?.id ?? asset.id);
    if (!equivalent) assets.push(asset);
  }
  const compositions = captured.compositions.map((c) => ({
    ...c,
    layers: c.layers.map((layer) =>
      layer.type === 'image'
        ? { ...layer, assetId: ids.get(layer.assetId)! }
        : layer.type === 'text' && layer.fontAssetId
          ? { ...layer, fontAssetId: ids.get(layer.fontAssetId)! }
          : layer,
    ),
  }));
  return animationCommand2(
    target,
    [
      {
        type: 'structure.replace',
        compositions: [...target.compositions, ...compositions],
        publicInputs: target.publicInputs,
      },
      {
        type: 'content.set',
        field: 'assets',
        value: assets,
      },
      {
        type: 'content.set',
        field: 'provenance',
        value: [...target.provenance, ...captured.provenance],
      },
    ],
    scope,
    'Import captured Design',
  );
}
