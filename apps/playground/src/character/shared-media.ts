import { useEffect, useRef, useState } from 'react';
import type { CharacterAssetRef, CharacterDocument } from '@editor-platform/character-core';
import { encodeBytes, sha256Ref, type CadResource } from '../cad/resources';
import type { StoredArtifact } from '../model';

export async function readCharacterOriginal(
  url: string,
  ref: CharacterAssetRef,
  signal?: AbortSignal,
) {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok || response.headers.get('Content-Length') !== String(ref.byteLength))
    throw Error('素材を取得できません。');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== ref.byteLength || (await sha256Ref(bytes)) !== ref.sha256)
    throw Error('素材が固定した版と一致しません。');
  return bytes;
}

type MediaVersion = { revision: number } | { versionId: string };
export type CharacterMediaUrl = (assetId: string, version?: MediaVersion) => string;

export async function sharedCharacterExportResources(
  record: StoredArtifact,
  revision: number,
  urlFor: CharacterMediaUrl,
) {
  const resources = new Map<string, CadResource>();
  const snapshots = [
    { content: record.draft.content, version: { revision } },
    ...record.versions.map((v) => ({ content: v.content, version: { versionId: v.versionId } })),
  ];
  for (const { content, version } of snapshots) {
    for (const ref of (content as CharacterDocument).assets) {
      const url = urlFor(ref.id, version);
      const key = ref.kind + ':' + ref.sha256;
      if (resources.has(key)) {
        const check = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (!check.ok) throw Error('保存した版の素材を取得できません。');
      } else {
        const bytes = await readCharacterOriginal(url, ref);
        resources.set(key, {
          kind: ref.kind as CadResource['kind'],
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          mediaType: ref.mediaType,
          encoding: 'base64',
          bytes: encodeBytes(bytes),
        });
      }
    }
  }
  return [...resources.values()];
}

/** Keep fetched originals in the current view only and drop them when grants expire. */
export function useSharedCharacterMedia(
  urlFor: ((id: string) => string) | undefined,
  refsKey: string,
  revision: number,
) {
  const refreshForRevision = useRef<() => void>(undefined);
  const [loaded, setLoaded] = useState<{
    urlFor: CharacterMediaUrl;
    refsKey: string;
    assets: Map<string, Uint8Array>;
  }>();
  useEffect(() => {
    setLoaded(undefined);
    if (!urlFor) return;
    const refs: CharacterAssetRef[] = JSON.parse(refsKey);
    const controller = new AbortController();
    let assets = new Map<string, Uint8Array>();
    let published: Map<string, Uint8Array> | undefined;
    let running = false;
    let pending = false;
    async function refresh() {
      if (controller.signal.aborted) return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        do {
          pending = false;
          const next = new Map<string, Uint8Array>();
          for (const ref of refs) {
            if (controller.signal.aborted) return;
            try {
              const url = urlFor!(ref.id);
              const previous = assets.get(ref.id);
              if (previous) {
                const r = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
                if (r.ok && r.headers.get('Content-Length') === String(ref.byteLength))
                  next.set(ref.id, previous);
              } else {
                next.set(ref.id, await readCharacterOriginal(url, ref, controller.signal));
              }
            } catch {
              /* Drop this original when its current grant or bytes are unavailable. */
            }
          }
          if (controller.signal.aborted) return;
          const lost = [...assets.keys()].some(id => !next.has(id));
          if (lost || next.size !== assets.size || [...next].some(([id, bytes]) => assets.get(id) !== bytes))
            assets = next;
          // Withhold newly downloaded bytes until a revision seen during the GET is checked too.
          if (lost && pending && published) {
            published = new Map([...published].filter(([id]) => assets.has(id)));
            setLoaded({ urlFor: urlFor!, refsKey, assets: published });
          } else if (!pending && assets !== published) {
            published = assets;
            setLoaded({ urlFor: urlFor!, refsKey, assets });
          }
        } while (pending);
      } finally {
        running = false;
      }
    }
    refreshForRevision.current = () => void refresh();
    const timer = window.setInterval(() => { if (!running) void refresh(); }, 2000);
    return () => {
      refreshForRevision.current = undefined;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [urlFor, refsKey]);

  useEffect(() => { refreshForRevision.current?.(); }, [urlFor, refsKey, revision]);
  return urlFor && loaded?.urlFor === urlFor && loaded.refsKey === refsKey ? loaded.assets : undefined;
}
