import { copy, fail, type DomainCodec } from '@editor-platform/collaboration-core';
import type { SlideContent } from '@editor-platform/slide/model';
import type { DesignContent } from '@editor-platform/design/model';
import type { WhiteboardContent } from '@editor-platform/whiteboard/model';
export interface AssetRef {
  id: string;
  hash: string;
}
/** Immutable asset storage is a Host concern; content materialization stays domain-specific. */
export class AssetRegistry {
  private assets = new Map<string, { hash: string; data: string; available: boolean }>();
  put(id: string, hash: string, data: string) {
    const old = this.assets.get(id);
    if (old && (old.hash !== hash || old.data !== data))
      fail('protocol-error', 'Asset ID reused with a different hash or bytes');
    this.assets.set(id, { hash, data, available: true });
  }
  unavailable(id: string) {
    const value = this.assets.get(id);
    if (value) value.available = false;
  }
  resolve(ref: AssetRef) {
    const value = this.assets.get(ref.id);
    if (!value || !value.available || value.hash !== ref.hash)
      fail('asset-unavailable', 'Asset missing, deleted, or hash mismatch');
    return value.data;
  }
  reference(data: string): AssetRef {
    for (const [id, value] of this.assets)
      if (value.data === data && value.available) return { id, hash: value.hash };
    return fail('asset-unavailable', 'Register existing asset bytes before replacing them');
  }
}
/** Operation carries only ID/hash; legacy snapshots/exports retain their original image schema. */
export function withAssets<T extends SlideContent | DesignContent | WhiteboardContent>(
  codec: DomainCodec<T>,
  assets: AssetRegistry,
): DomainCodec<T> {
  return {
    ...codec,
    apply(content, action, version, textVersions) {
      if (action.type !== 'asset.attach')
        return codec.apply(content, action, version, textVersions);
      const entities =
        'slides' in content
          ? content.slides.flatMap((s) => s.objects)
          : 'elements' in content
            ? content.elements
            : content.nodes;
      const item = entities.find((e) => e.id === action.target);
      if (!item) fail('target-deleted', 'Image target deleted');
      if (('type' in item ? item.type : item.kind) !== 'image')
        fail('invalid-operation', 'Assets attach only to image elements');
      const ref = action.payload.reference as AssetRef | null;
      if (ref !== null && (!ref || typeof ref.id !== 'string' || typeof ref.hash !== 'string'))
        fail('schema-mismatch', 'Invalid asset reference');
      const previous = item.src ? assets.reference(item.src) : null;
      const src = ref === null ? undefined : assets.resolve(ref);
      if (src !== undefined && !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(src))
        fail('invalid-operation', 'Expected image bytes');
      if (src === undefined) delete item.src;
      else item.src = src;
      const key = `${item.id}/src`;
      return {
        content,
        required: [key],
        touched: [key],
        targets: [item.id],
        inverse: [
          { type: 'asset.attach', target: item.id, payload: { reference: copy(previous) } },
        ],
      };
    },
  };
}
