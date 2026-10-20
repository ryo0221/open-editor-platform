import { imageDataUri, inspectOfficeImage } from '@editor-platform/office-adapters';
import {
  attribute as attr,
  descendants,
  namespaces as ns,
  ImportError,
  checkImportAbort,
  hashImportBytes,
  importLimits,
  importNativeId,
  validateDisplayLink,
  type ImportMapping,
  type ImportReportBuilder,
  type OfficePackage,
  type OfficeSourceAddress,
  type XmlNode,
} from '@editor-platform/office-import-core';
import { pchild } from './ooxml';
import type { SlideImportAdapters } from './types';
type ImageAsset = { src: string; width: number; height: number };
type DecodedImage = Awaited<ReturnType<NonNullable<SlideImportAdapters['decodeImage']>>>;
const isPngOrJpeg = (raw: Uint8Array) =>
  (raw[0] === 0x89 && raw[1] === 0x50) || (raw[0] === 0xff && raw[1] === 0xd8);
const unchangedImage = (
  decoded: DecodedImage,
  inspected: ReturnType<typeof inspectOfficeImage>,
  raw: Uint8Array,
) =>
  decoded.mime === inspected.mime &&
  decoded.width === inspected.width &&
  decoded.height === inspected.height &&
  decoded.bytes.length === raw.length &&
  decoded.bytes.every((v, i) => v === raw[i]);
/** Shared state of one PPTX import: ids, limits, image assets, diagnostics and mapping. */
export class SlideImportSession {
  readonly mapping: ImportMapping[] = [];
  private readonly pageParts = new Set<string>();
  private readonly assets = new Map<string, ImageAsset>();
  private readonly assetsByHash = new Map<string, ImageAsset>();
  private nextId = 0;
  private objects = 0;
  private totalImages = 0;
  private nativeAssetCharacters = 0;
  private textCharacters = 0;
  constructor(
    readonly pkg: OfficePackage,
    readonly builder: ImportReportBuilder,
    readonly root: XmlNode,
    private readonly requestId: string,
    private readonly decoder: SlideImportAdapters['decodeImage'],
    readonly signal: AbortSignal | undefined,
  ) {}
  id(prefix = 'object') {
    return importNativeId(this.requestId, ++this.nextId, prefix);
  }
  claimPagePart(part: string) {
    if (this.pageParts.has(part)) throw new ImportError('DUPLICATE_SLIDE_PART', part);
    this.pageParts.add(part);
  }
  countObject() {
    if (++this.objects > importLimits.objects)
      throw new ImportError(
        'OBJECT_LIMIT',
        'More than 10,000 selected objects including inherited objects',
      );
  }
  countNativeAsset(characters: number) {
    this.nativeAssetCharacters += characters;
    if (this.nativeAssetCharacters > importLimits.nativeAssetCharacters)
      throw new ImportError(
        'NATIVE_ASSET_LIMIT',
        'Repeated inline images exceed 128 MiB of native data URI text',
      );
  }
  countText(characters: number) {
    this.textCharacters += characters;
    if (this.textCharacters > importLimits.textCharacters)
      throw new ImportError('TEXT_LIMIT', 'More than 1,000,000 imported text characters');
  }
  async imageAsset(part: string, address: OfficeSourceAddress) {
    const existing = this.assets.get(part);
    if (existing) return existing;
    if (!this.decoder) {
      this.builder.unsupported(
        'IMAGE_DECODER',
        address,
        'A verified byte-only image decoder is required.',
      );
      return undefined;
    }
    const raw = this.pkg.bytes(part);
    if (!isPngOrJpeg(raw)) {
      this.builder.unsupported(
        'IMAGE_FORMAT',
        address,
        'This import profile supports static PNG/JPEG only.',
      );
      return undefined;
    }
    const inspected = inspectOfficeImage(raw),
      hash = await hashImportBytes(raw);
    const cached = this.assetsByHash.get(hash);
    if (cached) {
      this.assets.set(part, cached);
      return cached;
    }
    this.totalImages += raw.length;
    if (this.totalImages > importLimits.totalImageBytes)
      throw new ImportError('IMAGE_TOTAL_LIMIT', 'Unique embedded images exceed 64 MiB');
    const decoded = await this.decoder(raw.slice(), this.signal);
    checkImportAbort(this.signal);
    // A validator may not replace or mutate a source asset unnoticed.
    if (!unchangedImage(decoded, inspected, raw))
      throw new ImportError('IMAGE_ADAPTER', 'Image validator changed source bytes or dimensions');
    const result = {
      src: imageDataUri(inspected),
      width: inspected.width,
      height: inspected.height,
    };
    this.assets.set(part, result);
    this.assetsByHash.set(hash, result);
    return result;
  }
  unknownChildren(n: XmlNode, allowed: readonly string[], uri: string, part: string) {
    for (const c of n.children)
      if (
        !(
          (c.uri === uri && allowed.includes(c.local)) ||
          (c.uri === ns.a && allowed.includes(`a:${c.local}`))
        )
      )
        this.builder.unsupported(
          'UNSUPPORTED_ELEMENT',
          { part, path: c.path },
          `Unsupported ${c.local} in ${n.local}. Explicit exclusion removes this feature.`,
        );
  }
  validateIds(part: string) {
    const ids = new Set<string>();
    const tree = pchild(pchild(this.pkg.xml(part), 'cSld'), 'spTree');
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
  metadataAndLinks(n: XmlNode, part: string) {
    for (const h of [
      ...descendants(n, 'hlinkClick', ns.a),
      ...descendants(n, 'hlinkMouseOver', ns.a),
    ]) {
      const relation = attr(h, 'id', ns.rel);
      if (relation) {
        const r = this.pkg.relationship(part, relation);
        if (r.external) validateDisplayLink(r.target);
      }
      this.builder.add(
        'HYPERLINK',
        'approximation',
        { part, path: h.path },
        'Office object/text hyperlinks are not retained in native Slide content.',
        true,
      );
    }
  }
}
