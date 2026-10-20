import { contentHash, deserializeArtifact, newId } from '@editor-platform/artifact-core';
import type { ReferenceResolver } from '@editor-platform/artifact-references';
import { isAnnotation } from '@editor-platform/editor-core';
import { isDesign } from '@editor-platform/design';
import { importMarkdown } from '@editor-platform/document';
import { hasSlideAnimations, isDeck } from '@editor-platform/slide';
import { importCsv, isStructuredData } from '@editor-platform/structured-data';
import { validateNativeReusableDefinitions, type Domain } from '@editor-platform/templates';
import { validateArtifactReferenceHistory } from '../artifact-references';
import { validateGeoRecord } from '../geo/resources';
import { makeArtifact, validContent, type Content, type StoredArtifact } from '../model';
import { nativeContent } from './native';

const maxImportBytes = 16_000_000;

/** A native artifact export, re-identified unless it is Geo (whose ID is its resource scope). */
async function importedArtifact(
  text: string,
  value: unknown,
  exists: (id: string) => boolean,
): Promise<{ record: StoredArtifact; name: string; originalId: string }> {
  const artifact = deserializeArtifact(text);
  if (
    !validContent(artifact.kind, artifact.draft.content) ||
    artifact.versions.some((v) => !validContent(artifact.kind, v.content))
  )
    throw new Error('Invalid domain content');
  for (const version of artifact.versions)
    if ((await contentHash(version.content)) !== version.contentHash)
      throw new Error('Version content hash mismatch');
  const id = artifact.kind === 'geo' ? artifact.id : newId('artifact');
  if (artifact.kind === 'geo' && exists(id))
    throw Error('This Geo artifact already exists. Open it from the artifact list.');
  const record: StoredArtifact = {
    ...artifact,
    id,
    draft: { ...artifact.draft, content: artifact.draft.content as Content },
    versions: artifact.versions.map((v) => ({
      ...v,
      artifactId: id,
      content: v.content as Content,
    })),
    annotations: [],
  };
  if (record.kind === 'geo') {
    const rawGeo = value as StoredArtifact;
    record.geoResources = rawGeo.geoResources;
    record.geoDataInputs = rawGeo.geoDataInputs;
    await validateGeoRecord(record);
  }
  const raw = value as { annotations?: unknown };
  if (raw.annotations !== undefined) {
    if (!Array.isArray(raw.annotations) || !raw.annotations.every(isAnnotation))
      throw new Error('Invalid annotations');
    record.annotations = raw.annotations.map((annotation) => ({
      ...annotation,
      anchor: {
        ...annotation.anchor,
        addresses: annotation.anchor.addresses.map((address) => ({
          ...address,
          artifactId: address.artifactId === artifact.id ? id : address.artifactId,
        })),
      },
    }));
  }
  return { record, name: artifact.name, originalId: artifact.id };
}

function hasReusableAdapter(kind: string, content: Content) {
  return (
    kind !== 'react-ui' &&
    kind !== 'structured-graph' &&
    kind !== 'geo' &&
    kind !== 'animation' &&
    !(isDeck(content) && hasSlideAnimations(content))
  );
}

/**
 * Reads a Markdown, CSV, bare data/Design JSON or native artifact export into a new
 * record. Everything is validated before the caller adopts it; nothing is stored here.
 */
export async function readImportFile(
  file: File,
  context: { exists(id: string): boolean; references: ReferenceResolver },
): Promise<StoredArtifact> {
  if (file.size > maxImportBytes) throw new Error('Import files must be smaller than 16 MB');
  const text = await file.text();
  let record: StoredArtifact;
  let nativeName: string | undefined;
  let importedArtifactId: string | undefined;
  if (/\.md$/i.test(file.name)) {
    record = makeArtifact('document', 1);
    record.draft.content = importMarkdown(text);
  } else if (/\.csv$/i.test(file.name)) {
    record = makeArtifact('data', 1);
    record.draft.content = importCsv(text);
  } else {
    const value: unknown = JSON.parse(text);
    if (isStructuredData(value)) {
      record = makeArtifact('data', 1);
      record.draft.content = value;
    } else if (isDesign(value)) {
      // React bundles retain ordinary native Design content as native.json.
      record = makeArtifact('design', 1);
      record.draft.content = value;
    } else {
      const imported = await importedArtifact(text, value, context.exists);
      record = imported.record;
      nativeName = imported.name;
      importedArtifactId = imported.originalId;
    }
  }
  for (const content of [record.draft.content, ...record.versions.map((v) => v.content)])
    if (hasReusableAdapter(record.kind, content))
      await validateNativeReusableDefinitions(record.kind as Domain, nativeContent(content));
  // Reference sources retain exported IDs; check self-addresses in that original scope.
  await validateArtifactReferenceHistory(
    { ...record, id: importedArtifactId ?? record.id },
    context.references,
  );
  record.name = nativeName ?? file.name.replace(/\.(md|csv|json)$/i, '');
  record.provenance = {
    source: 'imported',
    format: file.name.split('.').pop(),
    importedAt: new Date().toISOString(),
  };
  return record;
}
