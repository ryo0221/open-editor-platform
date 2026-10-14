import {
  copy,
  fingerprint,
  fail,
  type Action,
  type DomainCodec,
  type Operation,
} from '@editor-platform/collaboration-core';
import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
export interface EditorAsset {
  id: string;
  hash: string;
}
/** Transient, Host-owned asset cache. Ordinary/native exports keep the domain's image schema. */
export class EditorAssetCache {
  private values = new Map<string, string>();
  reference(data: string): EditorAsset {
    const hash = fingerprint(data),
      id = `asset-${hash}`;
    this.values.set(id, data);
    return { id, hash };
  }
  register(ref: EditorAsset, data: string) {
    if (
      !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(data) ||
      fingerprint(data) !== ref.hash ||
      ref.id !== `asset-${ref.hash}`
    )
      fail('asset-unavailable', 'Image bytes do not match their Host asset hash');
    this.values.set(ref.id, data);
  }
  resolve(ref: EditorAsset) {
    const data = this.values.get(ref.id);
    if (!data || fingerprint(data) !== ref.hash)
      fail('asset-unavailable', 'Asset has not arrived or its hash differs');
    return data;
  }
  encode(value: unknown): unknown {
    if (typeof value === 'string' && /^data:image\//.test(value))
      return { $editorAsset: this.reference(value) };
    if (Array.isArray(value)) return value.map((v) => this.encode(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, this.encode(v)]),
      );
    return value;
  }
  decode(value: unknown, strict = false): unknown {
    if (typeof value === 'string' && /^data:image\//.test(value)) {
      if (strict) fail('invalid-operation', 'Submit an asset ID/hash instead of image bytes');
      this.reference(value);
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => this.decode(v, strict));
    if (value && typeof value === 'object') {
      if ('$editorAsset' in value) return this.resolve(value.$editorAsset as EditorAsset);
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.decode(v, strict)]));
    }
    return value;
  }
  references(value: unknown): EditorAsset[] {
    const found = new Map<string, EditorAsset>();
    const visit = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      if ('$editorAsset' in v) {
        const ref = v.$editorAsset as EditorAsset;
        found.set(ref.id, ref);
      } else Object.values(v).forEach(visit);
    };
    visit(value);
    return [...found.values()];
  }
}
export interface AssetEditorCodec<T> extends DomainCodec<T> {
  assets: EditorAssetCache;
}
export function editorAssetCodec<T>(
  codec: DomainCodec<T>,
  assets = new EditorAssetCache(),
  strict = false,
): AssetEditorCodec<T> {
  const closures = new WeakMap<object, unknown>();
  const encode = (action: Action): Action => {
    const closure = action.payload.closure;
    if (
      action.type !== 'reuse.instance' ||
      !closure ||
      typeof closure !== 'object' ||
      !isDeepFrozen(closure)
    )
      return assets.encode(action) as Action;
    // Adopted definitions are immutable. Keep one encoded copy across the inverse
    // batch; ordinary/mutable actions still use the existing owned serialization.
    if (!closures.has(closure)) closures.set(closure, deepFreeze(assets.encode(closure)));
    const result = assets.encode({
      ...action,
      payload: { ...action.payload, closure: undefined },
    }) as Action;
    result.payload.closure = closures.get(closure);
    return result;
  };
  return {
    ...codec,
    assets,
    encode,
    apply(content, action, version, textVersions) {
      const decoded = assets.decode(action, strict) as Action;
      const result = codec.apply(content, decoded, version, textVersions);
      return { ...result, inverse: result.inverse.map(encode) };
    },
    ...(codec.applyReadonly
      ? {
          applyReadonly(
            content: T,
            action: Action,
            version: number,
            textVersions?: Record<string, number>,
          ) {
            const result = codec.applyReadonly!(
              content,
              assets.decode(action, strict) as Action,
              version,
              textVersions,
            );
            return { ...result, inverse: result.inverse.map(encode) };
          },
        }
      : {}),
    mapAnchor: (anchor, content, action) =>
      codec.mapAnchor?.(anchor, content, assets.decode(action, strict) as Action) ?? anchor,
  };
}
export function encodeEditorOperation<T>(codec: DomainCodec<T>, op: Operation): Operation {
  const assets = (codec as AssetEditorCodec<T>).assets;
  return assets ? { ...copy(op), actions: assets.encode(op.actions) as Action[] } : copy(op);
}
