/**
 * R3e-4: the CAD versions a structural analysis analyses (docs/cad/r3-analysis.md, Native model:
 * one solid body of one saved CAD version, fixed by version and content hash). The Playground
 * keeps each analysed version's content beside the record, by hash, as it keeps placed parts.
 */
import { cadContentHash, isCadDocument, type CadDocument } from '@editor-platform/cad-core';
import {
  emptySimulation,
  simulationMaterialPresets,
  type SimulationDocument,
} from '@editor-platform/simulation-core';
import type { StoredArtifact } from '../model';
import type { CadPartRecord } from '../cad/parts';

/** Imported STEP/BRep geometry: evaluating it needs asset bytes the analysis does not keep. */
const importsGeometry = (content: CadDocument) =>
  content.assets.some((a) => a.kind === 'source-step' || a.kind === 'normalized-brep');

/** One analysable choice: a saved version of a 3D CAD Artifact and one solid body of it. */
export interface SimulationSourceChoice {
  artifactId: string;
  versionId: string;
  bodyId: string;
  /** For the picker: the Artifact's name, the version's place and the body's name. */
  label: string;
  content: CadDocument;
}

/**
 * Every saved version of every 3D CAD Artifact with its active solid bodies, newest version first. Drafts
 * are never analysed (a version is fixed); assemblies are out of R3's scope (single part). A version
 * with imported geometry (STEP/BRep assets) is not offered yet: its bytes would have to travel with
 * the analysis, which keeps only the CAD document.
 */
export function simulationSourceChoices(
  records: readonly Pick<StoredArtifact, 'id' | 'kind' | 'name' | 'versions'>[],
): SimulationSourceChoice[] {
  const out: SimulationSourceChoice[] = [];
  for (const r of records) {
    if (r.kind !== 'cad') continue;
    // Newest version first.
    for (let i = r.versions.length - 1; i >= 0; i--) {
      const v = r.versions[i]!;
      const content = v.content;
      if (!isCadDocument(content) || content.parts?.length || importsGeometry(content)) continue;
      // CR5e: a sheet too, analysed as a shell of the thickness the analysis gives it.
      for (const body of content.bodies)
        if (body.state === 'active')
          out.push({
            artifactId: r.id,
            versionId: v.versionId,
            bodyId: body.id,
            label: `${r.name} · v${i + 1} · ${body.name}${body.kind === 'sheet' ? ' (sheet)' : ''}`,
            content,
          });
    }
  }
  return out;
}

/**
 * R3e-5b (代表操作5): the other saved versions of the analysed CAD Artifact that still have the
 * analysed body as an active solid, newest first. Switching to one keeps every load, constraint
 * and setting; their targets are resolved again on the new version, never by nearness.
 */
export function simulationVersionChoices(
  records: readonly Pick<StoredArtifact, 'id' | 'kind' | 'name' | 'versions'>[],
  doc: SimulationDocument,
): SimulationSourceChoice[] {
  return simulationSourceChoices(records.filter((r) => r.id === doc.source.artifactId)).filter(
    (c) => c.bodyId === doc.source.bodyId && c.versionId !== doc.source.versionId,
  );
}

/** The record with `content` kept as a source (by hash, once), before an edit names it. */
export function stageSimulationSource<T extends Pick<StoredArtifact, 'simulationSources'>>(
  record: T,
  content: CadDocument,
): T {
  const contentHash = cadContentHash(content);
  const kept = record.simulationSources ?? [];
  if (kept.some((p) => p.contentHash === contentHash)) return record;
  return {
    ...record,
    simulationSources: [...kept, { contentHash, content: structuredClone(content) }],
  };
}

/**
 * The record as exported: only the sources its draft and versions analyse. A version switched
 * away from stays kept locally (Undo may come back to it), like a CAD part no longer placed.
 */
export function portableSimulationRecord<
  T extends Pick<StoredArtifact, 'kind' | 'draft' | 'versions' | 'simulationSources'>,
>(record: T): T {
  if (record.kind !== 'simulation' || !record.simulationSources) return record;
  const used = new Set(roots(record).map((d) => d.source.contentHash));
  return {
    ...record,
    simulationSources: record.simulationSources.filter((p) => used.has(p.contentHash)),
  };
}

/** A new analysis of the choice: steel on the body, the default mesh, nothing loaded yet. */
export function newSimulation(
  choice: Pick<SimulationSourceChoice, 'artifactId' | 'versionId' | 'bodyId' | 'content'>,
  name: string,
): { doc: SimulationDocument; retained: CadPartRecord } {
  const contentHash = cadContentHash(choice.content);
  const doc = emptySimulation(
    {
      artifactId: choice.artifactId,
      versionId: choice.versionId,
      contentHash,
      bodyId: choice.bodyId,
    },
    name,
  );
  doc.materials.push({ id: 'steel', ...simulationMaterialPresets[0]! });
  doc.materialId = 'steel';
  // CR5e: a sheet starts as a 1 mm shell, its thickness edited in the Bodies list.
  if (choice.content.bodies.find((b) => b.id === choice.bodyId)?.kind === 'sheet') {
    doc.schemaVersion = 2;
    doc.sheets = [{ bodyId: choice.bodyId, thicknessMm: 1 }];
  }
  return { doc, retained: { contentHash, content: structuredClone(choice.content) } };
}

const roots = (record: Pick<StoredArtifact, 'draft' | 'versions'>) =>
  [record.draft.content, ...record.versions.map((v) => v.content)] as SimulationDocument[];

/**
 * Native import and stored-record check: each retained version is valid CAD content kept under
 * its own hash, once, and every version the draft and versions analyse is kept. An import keeps
 * exactly those; a stored record may also keep versions switched away from (`stored`), which
 * the export leaves out (`portableSimulationRecord`).
 */
export function validateSimulationSources(
  record: Pick<StoredArtifact, 'draft' | 'versions' | 'simulationSources'>,
  { stored = false }: { stored?: boolean } = {},
) {
  const kept = record.simulationSources ?? [];
  if (!Array.isArray(kept)) throw new Error('Simulation sources');
  const hashes = new Set<string>();
  for (const p of kept) {
    if (
      !p ||
      typeof p !== 'object' ||
      Object.keys(p).sort().join() !== 'content,contentHash' ||
      typeof p.contentHash !== 'string'
    )
      throw new Error('Simulation source');
    if (hashes.has(p.contentHash)) throw new Error('Simulation source duplicated');
    hashes.add(p.contentHash);
    if (!isCadDocument(p.content)) throw new Error('Simulation source content');
    // Imported geometry needs its asset bytes, which the analysis does not keep (yet).
    if (importsGeometry(p.content)) throw new Error('Simulation source assets');
    if (cadContentHash(p.content) !== p.contentHash)
      throw new Error('Simulation source hash mismatch');
  }
  const used = new Set(roots(record).map((d) => d.source.contentHash));
  for (const h of used) if (!hashes.has(h)) throw new Error('Simulation source missing');
  if (!stored && used.size !== hashes.size) throw new Error('Simulation source not referenced');
}

/** The retained CAD content a document analyses, if the record keeps it. */
export const simulationSourceOf = (
  record: Pick<StoredArtifact, 'simulationSources'> | undefined,
  doc: SimulationDocument,
) => record?.simulationSources?.find((p) => p.contentHash === doc.source.contentHash)?.content;

/**
 * A version save's record keeps every analysed CAD version either side holds: one staged by a
 * version switch while the save was capturing stays (the record only gains them).
 */
export function mergeSimulationSources(
  saved: Pick<StoredArtifact, 'simulationSources'>,
  latest: Pick<StoredArtifact, 'simulationSources'>,
): Pick<StoredArtifact, 'simulationSources'> {
  if (!saved.simulationSources && !latest.simulationSources) return {};
  const merged = [...(latest.simulationSources ?? [])];
  for (const p of saved.simulationSources ?? [])
    if (!merged.some((m) => m.contentHash === p.contentHash)) merged.push(p);
  return { simulationSources: merged };
}
