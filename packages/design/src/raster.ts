import { canonicalJson } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import {
  appearance,
  assertDesignContent,
  updateElement,
  type DesignContent,
  type DesignElement,
} from './model';

export const designRasterLimits = Object.freeze({
  bytes: 4 * 1024 * 1024,
  dimension: 2048,
  pixels: 4 * 1024 * 1024,
  samples: 4096,
});
export interface RasterRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(bytes: Uint8Array, start: number, end: number) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** Bounded static PNG admission. Actual bitmap decoding remains a browser boundary. */
export function designPngInfo(src: unknown): { width: number; height: number; bytes: number } {
  const prefix = 'data:image/png;base64,';
  if (
    typeof src !== 'string' ||
    !src.startsWith(prefix) ||
    src.length > prefix.length + Math.ceil(designRasterLimits.bytes / 3) * 4
  )
    throw Error('編集できる画像は4MiB以下の埋め込みPNGです。');
  const encoded = src.slice(prefix.length);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw Error('PNGのbase64が不正です。');
  const raw = atob(encoded),
    bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (
    bytes.length > designRasterLimits.bytes ||
    bytes.length < 57 ||
    [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v)
  )
    throw Error('PNGデータが不正です。');
  const view = new DataView(bytes.buffer);
  let offset = 8,
    width = 0,
    height = 0,
    idat = false,
    ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw Error('PNGが途中で切れています。');
    const size = view.getUint32(offset),
      end = offset + 8 + size;
    if (end + 4 > bytes.length) throw Error('PNG chunkが不正です。');
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || crc(bytes, offset + 4, end) !== view.getUint32(end))
      throw Error('PNGの整合性検査に失敗しました。');
    if (offset === 8 && type !== 'IHDR') throw Error('PNG headerがありません。');
    if (type === 'IHDR') {
      if (offset !== 8 || size !== 13) throw Error('PNG headerが不正です。');
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (
        !width ||
        !height ||
        width > designRasterLimits.dimension ||
        height > designRasterLimits.dimension ||
        width * height > designRasterLimits.pixels
      )
        throw Error('PNGは長辺2048px・合計4M画素までです。');
    }
    if (type === 'acTL') throw Error('アニメーションPNGは編集できません。');
    if (type === 'IDAT') idat = true;
    offset = end + 4;
    if (type === 'IEND') {
      if (size || offset !== bytes.length || !idat) throw Error('PNG末尾が不正です。');
      ended = true;
      break;
    }
  }
  if (!ended) throw Error('PNG末尾がありません。');
  return { width, height, bytes: bytes.length };
}
export function assertRasterRegion(region: RasterRegion, width: number, height: number): void {
  if (
    !region ||
    Object.keys(region).sort().join(',') !== 'height,width,x,y' ||
    ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width < 1 ||
    region.height < 1 ||
    region.x + region.width > width ||
    region.y + region.height > height
  )
    throw Error('画像の選択範囲が不正です。');
}
export function editableDesignRaster(content: DesignContent, id: string): DesignElement {
  const byId = new Map(content.elements.map((e) => [e.id, e]));
  const target = byId.get(id);
  if (
    !target ||
    target.type !== 'image' ||
    target.reference ||
    appearance(content, target).src !== target.src
  )
    throw Error('元データを所有する画像レイヤーを選んでください。');
  let e: DesignElement | undefined = target;
  const seen = new Set<string>();
  while (e) {
    if (seen.has(e.id) || appearance(content, e).hidden || appearance(content, e).locked)
      throw Error('画像または親レイヤーは非表示・ロック中です。');
    seen.add(e.id);
    e = byId.get(e.parentId ?? '');
  }
  designPngInfo(target.src);
  return target;
}
/** One pixel edit, one existing local command/history entry. No second document model. */
export function replaceDesignRaster(
  base: DesignContent,
  id: string,
  src: string,
  kind: 'paint' | 'erase' | 'ai-region',
  writable = () => true,
): EditorCommand<DesignContent> {
  const before = editableDesignRaster(base, id),
    old = designPngInfo(before.src),
    next = designPngInfo(src),
    expected = canonicalJson(base);
  if (
    !['paint', 'erase', 'ai-region'].includes(kind) ||
    old.width !== next.width ||
    old.height !== next.height
  )
    throw Error('画像修正は同じ画素サイズで行ってください。');
  if (src === before.src) throw Error('画像に変更がありません。');
  return command(
    'design.raster.edit',
    kind === 'erase' ? '画像の一部を消す' : '画像を描き直す',
    (content) => {
      if (!writable()) throw Error('画像は閲覧専用です。');
      if (canonicalJson(content) !== expected)
        throw Error('画像修正の後に原稿が変わりました。やり直してください。');
      editableDesignRaster(content, id);
      let result = updateElement(id, { src }).apply(content);
      const attribution = content.pagination?.images.find((i) => i.elementId === id);
      if (attribution && result.pagination) {
        const suffix = kind === 'ai-region' ? ' / AI region edit' : ' / pixel edit';
        const source = attribution.source.endsWith(suffix)
          ? attribution.source
          : attribution.source + suffix;
        if (source.length > 4096) throw Error('画像の出典情報が長すぎます。');
        result = {
          ...result,
          pagination: {
            ...result.pagination,
            images: [
              ...result.pagination.images.filter((i) => i.elementId !== id),
              { ...attribution, source },
            ],
          },
        };
      }
      assertDesignContent(result);
      return result;
    },
  );
}
