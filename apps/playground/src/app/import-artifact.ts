import { verifyPlaygroundEstimate as verifyEstimateArtifact } from './estimate-bim';
import { verifyAnalysisArtifact } from '@editor-platform/analysis/host';
import { clone, contentHash, deserializeArtifact, newId } from '@editor-platform/artifact-core';
import type { ReferenceResolver } from '@editor-platform/artifact-references';
import { isAnnotation } from '@editor-platform/editor-core';
import { isDesignWithPaths } from '@editor-platform/design';
import { importMarkdown } from '@editor-platform/document';
import { importCsv, isStructuredData } from '@editor-platform/structured-data';
import { MINDMAP_ARTIFACT_KIND, mindmapProblem } from '@editor-platform/mindmap-core';
import { validateNativeReusableDefinitions, type Domain } from '@editor-platform/templates';
import { artifactReferenceItems, validateArtifactReferenceHistory } from '../artifact-references';
import { assertBimNativeFits, bimPartHashes, validateBimParts } from '../bim/parts';
import type { CadPartRecord } from '../cad/parts';
import type { CadDocument } from '@editor-platform/cad-core';
import type { BimIfcImportReport } from '@editor-platform/bim/ifc-import';
import type { BimPartReference } from '@editor-platform/bim';
import { cadNativeKinds, cadNativeLimit, cadNativeLimitText } from '../cad/resources';
import { makeArtifact, validContent, type Content, type StoredArtifact } from '../model';
import { recordHooks } from '../kinds/records';
import { nativeContent } from './native';
import { hostNativeArtifactByteLimit } from '@editor-platform/editor-host';

const maxImportBytes = 16_000_000;
const maxImportFiles = 32;

/** A native artifact export, re-identified unless it is Geo (whose ID is its resource scope). */
async function importedArtifact(
  text: string,
  value: unknown,
  exists: (id: string) => boolean,
): Promise<{ record: StoredArtifact; name: string; originalId: string }> {
  const parsed = deserializeArtifact(text);
  const hooks = recordHooks(parsed.kind);
  const artifact = hooks.parseNative ? await hooks.parseNative(text) : parsed;
  const invalid = [artifact.draft.content, ...artifact.versions.map((v) => v.content)].find(
    (content) => !validContent(artifact.kind, content),
  );
  if (invalid !== undefined)
    throw new Error(
      // A newer Graph schema gets its own reason, as when it is opened from storage.
      hooks.invalidReason?.(invalid) ?? 'Invalid domain content',
    );
  for (const version of artifact.versions)
    if ((await contentHash(version.content)) !== version.contentHash)
      throw new Error('Version content hash mismatch');
  await verifyEstimateArtifact(artifact);
  await verifyAnalysisArtifact(artifact);
  const id = hooks.importKeepsId ? artifact.id : newId('artifact');
  if (hooks.importKeepsId && exists(id)) throw Error(hooks.importKeepsId.duplicate);
  const record: StoredArtifact = {
    ...artifact,
    id,
    draft: {
      ...artifact.draft,
      // An older schema is imported as the current one; versions keep their bytes.
      content: hooks.openContent(artifact.draft.content),
    },
    versions: artifact.versions.map((v) => ({
      ...v,
      artifactId: id,
      content: v.content as Content,
    })),
    annotations: [],
  };
  // The data that travels beside the content in the same file (kinds/*/records.ts).
  await hooks.importExtras?.(record, value as StoredArtifact);
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
  return recordHooks(kind).reusableAdapter(content);
}

interface ImportContext {
  exists(id: string): boolean;
  references: ReferenceResolver;
}

/**
 * Reads a Markdown, CSV, bare data/Design/Mind Map JSON or native artifact export into a new
 * record. Everything is validated before the caller adopts it; nothing is stored here.
 */
async function readImportFile(
  file: File,
  context: ImportContext,
): Promise<{ record: StoredArtifact; originalId?: string }> {
  const native = /\.json$/i.test(file.name);
  if (
    file.size >
    (native ? Math.max(cadNativeLimit.bytes, hostNativeArtifactByteLimit) : maxImportBytes)
  )
    throw new Error(
      native
        ? `Native JSON files must not exceed 64 MiB (${cadNativeLimitText()} for CAD, building and character files)`
        : 'Import files must be smaller than 16 MB',
    );
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
    } else if (
      value !== null &&
      typeof value === 'object' &&
      (value as { artifactKind?: unknown }).artifactKind === MINDMAP_ARTIFACT_KIND
    ) {
      // A bare Mind Map: its own JSON export, or a file of the external mindmap-editor 0.1.5.
      const problem = mindmapProblem(value);
      if (problem) throw new Error(`Invalid Mind Map: ${problem}`);
      record = makeArtifact('mindmap', 1);
      record.draft.content = value as Content;
    } else if (isDesignWithPaths(value)) {
      // React bundles retain ordinary native Design content as native.json.
      record = makeArtifact('design', 1);
      record.draft.content = value;
    } else {
      const imported = await importedArtifact(text, value, context.exists);
      record = imported.record;
      nativeName = imported.name;
      importedArtifactId = imported.originalId;
    }
    if (file.size > hostNativeArtifactByteLimit && !cadNativeKinds.has(record.kind))
      throw new Error('Native JSON files must not exceed 64 MiB');
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
  const template = record.provenance?.template;
  if (
    template !== undefined &&
    (!template ||
      typeof template.id !== 'string' ||
      !template.id ||
      !Number.isSafeInteger(template.version) ||
      template.version < 1 ||
      typeof template.hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(template.hash))
  )
    throw new Error('Invalid template provenance');
  record.provenance = {
    source: 'imported',
    format: file.name.split('.').pop(),
    importedAt: new Date().toISOString(),
    ...(template
      ? { template: { id: template.id, version: template.version, hash: template.hash } }
      : {}),
  };
  return { record, originalId: importedArtifactId };
}

/** Points draft references and annotation anchors at the new IDs of the same import. */
function relink(record: StoredArtifact, ids: Map<string, string>): StoredArtifact {
  const content = clone(record.draft.content);
  for (const item of artifactReferenceItems(content)) {
    const reference = item.reference;
    const id = reference && ids.get(reference.source.artifactId);
    if (reference && id)
      item.reference = {
        ...reference,
        source: { ...reference.source, artifactId: id },
        snapshot: { ...reference.snapshot, artifactId: id },
      };
  }
  recordHooks(record.kind).relink?.(content, ids);
  return {
    ...record,
    draft: { ...record.draft, content },
    annotations: record.annotations.map((annotation) => ({
      ...annotation,
      anchor: {
        ...annotation.anchor,
        addresses: annotation.anchor.addresses.map((address) => ({
          ...address,
          artifactId: ids.get(address.artifactId) ?? address.artifactId,
        })),
      },
    })),
  };
}

/**
 * Reads one or more files as one import: either every file becomes a new record or
 * none does. Drafts that refer to another artifact of the same import follow its new ID;
 * committed versions keep the references they were saved with.
 */
export async function readImportFiles(
  files: File[],
  context: ImportContext,
): Promise<StoredArtifact[]> {
  if (!files.length) throw new Error('Choose a file to import');
  if (files.length > maxImportFiles)
    throw new Error(`Import at most ${maxImportFiles} files at once`);
  const imported: { record: StoredArtifact; originalId?: string }[] = [];
  const ids = new Map<string, string>();
  for (const file of files) {
    try {
      const one = await readImportFile(file, context);
      if (one.originalId !== undefined) {
        if (ids.has(one.originalId)) throw new Error('This artifact is already in the import');
        ids.set(one.originalId, one.record.id);
      }
      imported.push(one);
    } catch (error) {
      if (files.length === 1) throw error;
      throw new Error(`${file.name}: ${(error as Error).message}`);
    }
  }
  return imported.map(({ record }) => relink(record, ids));
}

/**
 * An IFC file as a new building (docs/cad/r2c-architecture.md, IFC; R2c-U5, R2c-6). A part the
 * file names is restored only when its exact CAD version is one of this Playground's saved
 * versions; the building then keeps that version in its record, as a placed part does. Anything
 * the import would lose waits for the user (`acceptLoss`). Nothing is stored here.
 */
export async function readIfcImport(
  file: File,
  context: { records(): StoredArtifact[]; acceptLoss?: boolean },
): Promise<
  | { status: 'imported'; record: StoredArtifact }
  | { status: 'needs-confirmation'; report: BimIfcImportReport }
> {
  const { readBimIfcFile } = await import('@editor-platform/bim/ifc-import');
  const versions = new Map<string, CadPartRecord>();
  const resolve = (source: BimPartReference) => {
    const cad = context
      .records()
      .find((r) => r.id === source.artifactId && r.kind === 'cad')
      ?.versions.find(
        (v) => v.versionId === source.versionId && v.contentHash === source.contentHash,
      );
    if (!cad) return false;
    versions.set(source.contentHash, {
      contentHash: source.contentHash,
      content: cad.content as unknown as CadDocument,
    });
    return true;
  };
  // Read through to the document, so the report the user confirms holds every loss, then ask.
  const result = await readBimIfcFile(file, { acceptLoss: true, resolvePart: resolve });
  if (result.status === 'needs-confirmation') return result;
  // The file keeps a part type whose elements it dropped, and types no element places: each
  // type's version resolves here too, and one that does not is a loss like its elements.
  const doc = result.document;
  const unresolved = doc.types.filter((t) => t.kind === 'part' && !resolve(t.source));
  const report: BimIfcImportReport = unresolved.length
    ? {
        ...result.report,
        losses: [
          ...result.report.losses,
          ...unresolved.map((t) => ({
            entity: 'part type',
            reason: 'part-unresolved',
            name: t.name,
          })),
        ],
        summary: [
          ...result.report.summary,
          { entity: 'part type', reason: 'part-unresolved', count: unresolved.length },
        ],
      }
    : result.report;
  if ((report.losses.length || report.withoutFollow) && !context.acceptLoss)
    return { status: 'needs-confirmation', report };
  doc.types = doc.types.filter((t) => !unresolved.includes(t));
  const record = makeArtifact('bim', 1);
  record.draft.content = doc as unknown as Content;
  record.name = file.name.replace(/\.ifc$/i, '') || record.name;
  const placed = bimPartHashes(record);
  if (placed.size)
    record.cadParts = [...versions.values()].filter((p) => placed.has(p.contentHash));
  validateBimParts(record);
  // The kept versions travel in the native file: one past its limit could not be saved.
  assertBimNativeFits(record, 'import');
  record.provenance = { source: 'imported', format: 'ifc', importedAt: new Date().toISOString() };
  return { status: 'imported', record };
}
