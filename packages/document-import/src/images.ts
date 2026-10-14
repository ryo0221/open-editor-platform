import {
  attribute,
  child,
  children,
  namespaces as ns,
  ImportError,
  importLimits,
  hashImportBytes,
  checkImportAbort,
  type XmlNode,
} from '@editor-platform/office-import-core';
import { inspectOfficeImage, imageDataUri } from '@editor-platform/office-adapters';
import type { DocumentBlock } from '@editor-platform/document/model';
import type { DocumentImportAdapters } from './types';
import { address, type DocumentImportContext } from './context';
export class WordImages {
  private assets = new Map<string, { src: string; width: number; height: number }>();
  private imageIds = new Set<string>();
  private total = 0;
  private serialized = 0;
  constructor(
    private context: DocumentImportContext,
    private decoder: DocumentImportAdapters['decodeImage'],
    private signal?: AbortSignal,
  ) {}
  async drawing(node: XmlNode): Promise<DocumentBlock | undefined> {
    const { pkg, builder, mapping, id } = this.context;
    const frames = children(node, 'inline', ns.wp),
      anchors = children(node, 'anchor', ns.wp);
    if (anchors.length || frames.length !== 1) {
      builder.unsupported(
        'FLOATING_DRAWING',
        address(node),
        'Only a single in-flow picture is supported here. Explicit exclusion removes this drawing, including any textbox content.',
      );
      return;
    }
    const frame = frames[0],
      graphic = child(frame, 'graphic', ns.a),
      data = child(graphic, 'graphicData', ns.a);
    if (attribute(data, 'uri') !== ns.pic) {
      builder.unsupported(
        'DRAWING_UNSUPPORTED',
        address(node),
        'Charts, SmartArt and drawing text are outside the in-flow picture profile. Exclusion removes this drawing.',
      );
      return;
    }
    const pic = child(data, 'pic', ns.pic),
      fill = child(pic, 'blipFill', ns.pic),
      blip = child(fill, 'blip', ns.a),
      props = child(pic, 'spPr', ns.pic);
    if (!pic || !blip) throw new ImportError('INVALID_IMAGE_STRUCTURE', `${node.part}${node.path}`);
    const docPr = child(frame, 'docPr', ns.wp),
      sourceId = attribute(docPr, 'id');
    if (sourceId) {
      const key = `${node.part}#${sourceId}`;
      if (this.imageIds.has(key)) throw new ImportError('DUPLICATE_SOURCE_ID', key);
      this.imageIds.add(key);
    }
    const relation = attribute(blip, 'embed', ns.rel) ?? attribute(blip, 'link', ns.rel);
    if (!relation) throw new ImportError('INVALID_IMAGE_REFERENCE', `${node.part}${node.path}`);
    const rel = pkg.relationship(node.part, relation, 'image');
    if (rel.external) {
      builder.unsupported(
        'EXTERNAL_IMAGE',
        address(node),
        'External images are never fetched. Explicit exclusion removes the image.',
      );
      return;
    }
    const bytes = pkg.bytes(rel.target);
    if (!((bytes[0] === 0x89 && bytes[1] === 0x50) || (bytes[0] === 0xff && bytes[1] === 0xd8))) {
      builder.unsupported(
        'IMAGE_FORMAT',
        address(node),
        'Only static PNG/JPEG inputs are accepted; explicit exclusion removes this picture.',
      );
      return;
    }
    const inspected = inspectOfficeImage(bytes);
    if (inspected.width * inspected.height > importLimits.imagePixels)
      throw new ImportError('IMAGE_PIXEL_LIMIT', rel.target);
    const hash = await hashImportBytes(bytes);
    checkImportAbort(this.signal);
    let asset = this.assets.get(hash);
    if (!asset) {
      if (!this.decoder) {
        builder.unsupported(
          'IMAGE_DECODER',
          address(node),
          'An owned-byte image decoder is required. Exclusion removes this picture.',
        );
        return;
      }
      this.total += bytes.length;
      if (this.total > importLimits.totalImageBytes)
        throw new ImportError('IMAGE_TOTAL_LIMIT', 'More than 64 MiB unique images');
      const decoded = await this.decoder(bytes.slice(), this.signal);
      checkImportAbort(this.signal);
      if (
        decoded.mime !== inspected.mime ||
        decoded.width !== inspected.width ||
        decoded.height !== inspected.height ||
        decoded.bytes.length !== bytes.length ||
        decoded.bytes.some((v, i) => v !== bytes[i])
      )
        throw new ImportError('IMAGE_ADAPTER', 'Image decoder changed bytes or dimensions');
      asset = { src: imageDataUri(inspected), width: inspected.width, height: inspected.height };
      this.assets.set(hash, asset);
    }
    const extent = child(frame, 'extent', ns.wp),
      width = Number(attribute(extent, 'cx')) / 9525,
      height = Number(attribute(extent, 'cy')) / 9525;
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 10000 ||
      height > 10000
    )
      throw new ImportError('IMAGE_GEOMETRY', 'Invalid in-flow picture extent');
    if (Math.abs(width / height - asset.width / asset.height) > 0.001)
      builder.add(
        'IMAGE_ASPECT',
        'approximation',
        address(node),
        'Native Document retains width and the original image aspect ratio; Office stretching is not retained.',
        true,
      );
    const crop = child(fill, 'srcRect', ns.a),
      transform = child(props, 'xfrm', ns.a);
    if (crop && crop.attributes.some((a) => !a.uri && Number(a.value) !== 0))
      builder.unsupported(
        'IMAGE_CROP',
        address(crop),
        'Native Document has no image crop. Explicit exclusion of crop uses the whole image.',
      );
    const fillRect = child(child(fill, 'stretch', ns.a), 'fillRect', ns.a);
    if (fillRect && fillRect.attributes.some((a) => !a.uri && Number(a.value) !== 0))
      builder.unsupported(
        'IMAGE_FILL_RECT',
        address(fillRect),
        'Picture fill margins are not retained. Exclusion fills the native image rectangle.',
      );
    const offset = child(transform, 'off', ns.a),
      innerExtent = child(transform, 'ext', ns.a);
    if (
      (offset && offset.attributes.some((a) => !a.uri && Number(a.value) !== 0)) ||
      (innerExtent &&
        (Number(attribute(innerExtent, 'cx')) !== Number(attribute(extent, 'cx')) ||
          Number(attribute(innerExtent, 'cy')) !== Number(attribute(extent, 'cy'))))
    )
      builder.add(
        'IMAGE_INNER_GEOMETRY',
        'approximation',
        address(transform!),
        'Native image uses the in-flow outer width and original aspect ratio; inner drawing offsets/extents are not retained.',
        true,
      );
    const effectExtent = child(frame, 'effectExtent', ns.wp);
    if (
      (effectExtent && effectExtent.attributes.some((a) => !a.uri && Number(a.value) !== 0)) ||
      frame.attributes.some((a) => !a.uri && /^dist[TRBL]$/.test(a.local) && Number(a.value) !== 0)
    )
      builder.add(
        'IMAGE_SPACING',
        'approximation',
        address(frame),
        'Office picture effect spacing and text distances use native image block spacing.',
        true,
      );
    if (
      transform &&
      transform.attributes.some(
        (a) =>
          !a.uri &&
          ['rot', 'flipH', 'flipV'].includes(a.local) &&
          !['0', 'false'].includes(a.value),
      )
    )
      builder.unsupported(
        'IMAGE_TRANSFORM',
        address(transform),
        'Document images do not retain rotation/reflection. Exclusion uses the original upright image.',
      );
    const known = new Map<string, Set<string>>([
      [ns.w, new Set(['drawing'])],
      [ns.wp, new Set(['inline', 'extent', 'effectExtent', 'docPr', 'cNvGraphicFramePr'])],
      [
        ns.a,
        new Set([
          'graphic',
          'graphicData',
          'graphicFrameLocks',
          'picLocks',
          'blip',
          'stretch',
          'fillRect',
          'srcRect',
          'xfrm',
          'off',
          'ext',
          'prstGeom',
          'avLst',
          'noFill',
        ]),
      ],
      [ns.pic, new Set(['pic', 'nvPicPr', 'cNvPr', 'cNvPicPr', 'blipFill', 'spPr'])],
    ]);
    const audit = (n: XmlNode) => {
      if (!known.get(n.uri)?.has(n.local)) {
        builder.unsupported(
          'IMAGE_PROPERTY',
          address(n),
          `Unsupported picture property ${n.local}. Exclusion removes this property.`,
        );
        return;
      }
      for (const c of n.children) audit(c);
    };
    audit(node);
    if (
      attribute(child(props, 'prstGeom', ns.a), 'prst') &&
      attribute(child(props, 'prstGeom', ns.a), 'prst') !== 'rect'
    )
      builder.unsupported(
        'IMAGE_CLIP',
        address(props!),
        'Non-rectangular clipping is not retained. Exclusion shows the original rectangle.',
      );
    this.serialized += asset.src.length;
    if (this.serialized > importLimits.nativeAssetCharacters)
      throw new ImportError('NATIVE_ASSET_LIMIT', 'Repeated inline image text exceeds 128 MiB');
    const result: DocumentBlock = {
      id: id('image'),
      type: 'image',
      text: '',
      src: asset.src,
      width,
      alt: attribute(docPr, 'descr') ?? attribute(docPr, 'title') ?? '',
    };
    mapping.push({ source: address(node), nativeIds: [result.id] });
    builder.add(
      'NATIVE_IMAGE',
      'native',
      address(node),
      'Embedded PNG/JPEG is an independently editable native image with retained alt text.',
    );
    return result;
  }
}
