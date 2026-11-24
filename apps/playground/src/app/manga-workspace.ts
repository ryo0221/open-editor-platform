import {
  createArtifact,
  createArtifactIfAbsent,
  canonicalJson,
} from '@editor-platform/artifact-core';
import { createDesign } from '@editor-platform/design/model';
import { insertDesignPage, setDesignPagination } from '@editor-platform/design/pagination';
import type { StoredArtifact } from '../model';
import { storage } from './records';

export interface MangaCreationOptions {
  landscape: boolean;
  direction: 'rtl' | 'ltr';
}
export function makeMangaArtifact(options: MangaCreationOptions): StoredArtifact {
  let content = insertDesignPage({
    x: 0,
    y: 0,
    width: options.landscape ? 800 : 600,
    height: options.landscape ? 600 : 800,
  }).apply(createDesign());
  content = setDesignPagination({ ...content.pagination!, direction: options.direction }).apply(
    content,
  );
  return { ...createArtifact('design', '漫画', content), annotations: [] };
}
export async function saveNewManga(artifact: StoredArtifact) {
  return createArtifactIfAbsent(storage, artifact, canonicalJson(artifact), canonicalJson);
}
const key = (id: string) => `editor-platform.workspace.${id}`;
export function readMangaWorkspace(
  id: string,
  fallback: 'design' | 'manga' = 'design',
): 'design' | 'manga' {
  try {
    const saved = localStorage.getItem(key(id));
    return saved === 'design' || saved === 'manga' ? saved : fallback;
  } catch {
    return fallback;
  }
}
export function writeMangaWorkspace(id: string, value: 'design' | 'manga') {
  try {
    localStorage.setItem(key(id), value);
  } catch {
    /* View preferences never prevent native editing. */
  }
}
