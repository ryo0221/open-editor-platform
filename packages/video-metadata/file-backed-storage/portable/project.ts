/** Private portable project profile; no public export or existing Host integration. */
import { canonicalJson, contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import { assertVideoContent, type VideoContent } from '@editor-platform/video-core';
import type { SaveCapture } from '@editor-platform/extension-contract/draft2';
import { prepareImportSet, type ImportSet } from '../../host-media/import';
import { MAX_ORIGINALS, memory, need, read, type Scanner, type Reader } from './io';
import { createZip, type Entry } from './zip64';
export interface ArchiveContent {
  sources: { id: string; asset: { assetId: string; sha256: string; byteLength: number } }[];
}
export interface ProjectProfile<C extends ArchiveContent, P> {
  readonly format: string;
  assertContent(value: unknown): asserts value is C;
  validatePlan(plan: P): void;
  validateSource(source: C['sources'][number], plan: P): void;
}
export interface Project<C extends ArchiveContent = VideoContent, P = ImportSet> {
  operationId: string;
  capture: SaveCapture;
  selectedVersionId: string;
  versions: ArtifactVersion<C>[];
  plans: { sourceId: string; plan: P }[];
  originals: Map<string, Reader>;
}
interface Manifest<C extends ArchiveContent, P>
  extends Omit<Project<C, P>, 'versions' | 'originals'> {
  format: string;
  versions: string[];
}
export const v0Profile: ProjectProfile<VideoContent, ImportSet> = {
  format: 'video-file-zip64-candidate-v0',
  assertContent: assertVideoContent,
  validatePlan(plan) {
    need(plan && typeof plan === 'object' && !Array.isArray(plan), 'Interpretation record');
    const keys = Object.keys(plan);
    need(keys.length === 1 && keys[0] === 'streams', 'Interpretation fields');
    need(Array.isArray(plan.streams) && plan.streams.length <= 2, 'Interpretation streams');
  },
  validateSource(source, plan) {
    const empty: VideoContent = {
      schema: 'video-core-prototype-v0',
      sources: [],
      sequence: {
        id: 'verify',
        duration: { value: 0, timescale: 1 },
        frameRate: { value: 25, timescale: 1 },
        clips: [],
        tracks: plan.streams.map((s) => ({
          id: s.destination,
          kind: s.kind === 'video' ? 'visual' : 'audio',
          enabled: true,
          locked: false,
        })),
      },
    };
    const verified = prepareImportSet(empty, plan, source.asset, source.id);
    need(
      canonicalJson(verified.sources[0]) === canonicalJson(source),
      'Interpretation/native mismatch',
    );
  },
};
export function createProject(scan: Scanner) {
  return createProfileProject(scan, v0Profile);
}
export function createProfileProject<C extends ArchiveContent, P>(
  scan: Scanner,
  profile: ProjectProfile<C, P>,
) {
  const { readZip } = createZip(scan);
  const hash = /^[a-f0-9]{64}$/;
  function fields(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
    need(v && typeof v === 'object' && !Array.isArray(v), 'Record fields');
    const actual = Object.keys(v).sort(),
      expected = [...keys].sort();
    need(
      actual.length === expected.length && actual.every((key, index) => key === expected[index]),
      'Record fields',
    );
  }
  function text(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0 && v.length <= 256;
  }
  function bounded(value: unknown, depth = 0, budget = { nodes: 0 }) {
    need(depth <= 24 && ++budget.nodes <= 4096, 'JSON depth/nodes');
    if (value && typeof value === 'object')
      for (const v of Object.values(value)) bounded(v, depth + 1, budget);
  }
  function jsonBytes(value: unknown) {
    bounded(value);
    const b = new TextEncoder().encode(canonicalJson(value));
    need(b.length <= 65536, 'Metadata byte budget');
    return b;
  }
  async function json(reader: Reader, signal: AbortSignal): Promise<unknown> {
    need(reader.size <= 65536n, 'Metadata byte budget');
    const bytes = await read(reader, 0n, Number(reader.size), signal);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const canonical = jsonBytes(value);
    need(
      bytes.length === canonical.length && bytes.every((v, i) => v === canonical[i]),
      'Canonical JSON required',
    );
    bounded(value);
    return value;
  }
  async function validateProject(p: Project<C, P>) {
    // A writer must not report success after dropping unsupported metadata (e.g. migration provenance).
    // Keep the same closed record boundary as the on-disk manifest; new metadata needs an explicit profile.
    fields(p, ['operationId', 'capture', 'selectedVersionId', 'versions', 'plans', 'originals']);
    need(
      text(p.operationId) &&
        text(p.selectedVersionId) &&
        Array.isArray(p.versions) &&
        p.versions.length > 0 &&
        p.versions.length <= 8 &&
        Array.isArray(p.plans) &&
        p.plans.length <= 100,
      'Project bounds',
    );
    validateCapture(p.capture);
    const ids = await validateVersions(p);
    const selected = ids.get(p.selectedVersionId);
    need(selected && selected.contentHash === p.capture.contentHash, 'Selected capture');
    for (const v of p.versions) validateLineage(v, ids);
    const plans = validatePlans(p.plans);
    validateClosure(p, plans);
  }
  function validateCapture(capture: Project<C, P>['capture']) {
    fields(capture, ['scope', 'revision', 'contentHash']);
    fields(capture.scope, ['artifactId', 'sessionId', 'generation']);
    fields(capture.revision, ['kind', 'sessionId', 'sequence']);
    need(
      Object.values(capture.scope).every(text) &&
        capture.revision.kind === 'local-draft' &&
        text(capture.revision.sessionId) &&
        capture.revision.sessionId === capture.scope.sessionId &&
        Number.isSafeInteger(capture.revision.sequence) &&
        capture.revision.sequence >= 0,
      'Capture',
    );
  }
  async function validateVersions(p: Project<C, P>) {
    const ids = new Map<string, ArtifactVersion<C>>();
    for (const v of p.versions) {
      jsonBytes(v);
      fields(v, [
        'artifactId',
        'versionId',
        'parentVersionId',
        'schemaVersion',
        'content',
        'contentHash',
        'createdAt',
        'createdBy',
        'reason',
      ]);
      profile.assertContent(v.content);
      need(
        text(v.versionId) &&
          !ids.has(v.versionId) &&
          v.artifactId === p.capture.scope.artifactId &&
          (v.parentVersionId === null || text(v.parentVersionId)) &&
          v.schemaVersion === 1 &&
          typeof v.createdAt === 'string' &&
          (v.createdBy === null || typeof v.createdBy === 'string') &&
          (v.reason === null || typeof v.reason === 'string') &&
          (await contentHash(v.content)) === v.contentHash,
        'Native envelope/hash',
      );
      ids.set(v.versionId, v);
    }
    return ids;
  }
  function validateLineage(v: ArtifactVersion<C>, ids: Map<string, ArtifactVersion<C>>) {
    const seen = new Set<string>();
    let at: string | null = v.versionId;
    while (at !== null) {
      need(!seen.has(at) && ids.has(at), 'Retained parent/cycle');
      seen.add(at);
      at = ids.get(at)!.parentVersionId;
    }
  }
  function validatePlans(list: Project<C, P>['plans']) {
    const plans = new Map<string, P>();
    for (const x of list) {
      fields(x, ['sourceId', 'plan']);
      need(text(x.sourceId) && !plans.has(x.sourceId), 'Interpretation identity');
      profile.validatePlan(x.plan);
      plans.set(x.sourceId, x.plan);
    }
    return plans;
  }
  function validateClosure(p: Project<C, P>, plans: Map<string, P>) {
    const sources = new Set<string>(),
      originals = new Set<string>();
    let total = 0n;
    need(p.originals instanceof Map && p.originals.size <= 100, 'Original count');
    for (const [id, original] of p.originals) {
      need(hash.test(id) && original.size > 0n, 'Original identity');
      total += original.size;
    }
    need(total <= MAX_ORIGINALS, 'Original aggregate budget');
    for (const v of p.versions)
      for (const source of v.content.sources) {
        sources.add(source.id);
        originals.add(source.asset.sha256);
        const original = p.originals.get(source.asset.sha256),
          plan = plans.get(source.id);
        need(
          original && original.size === BigInt(source.asset.byteLength) && plan,
          'Missing original/interpretation closure',
        );
        profile.validateSource(source, plan);
      }
    need(
      sources.size === plans.size && originals.size === p.originals.size,
      'Unexpected closure entries',
    );
  }
  async function entry(name: string, reader: Reader, signal: AbortSignal): Promise<Entry> {
    return { name, reader, size: reader.size, ...(await scan(reader, signal)) };
  }
  async function prepareProject(input: Project<C, P>, signal: AbortSignal) {
    // Pin data before awaits; the Host must retain immutable original readers through settlement.
    const { originals, ...metadata } = input;
    const p: Project<C, P> = { ...structuredClone(metadata), originals: new Map(originals) };
    await validateProject(p);
    signal.throwIfAborted();
    const entries: Entry[] = [];
    for (const v of p.versions) {
      const r = memory(jsonBytes(v)),
        digest = await scan(r, signal);
      entries.push({ name: `native/${digest.sha256}.json`, size: r.size, reader: r, ...digest });
    }
    const manifest: Manifest<C, P> = {
      format: profile.format,
      operationId: p.operationId,
      capture: p.capture,
      selectedVersionId: p.selectedVersionId,
      versions: entries.map((e) => e.name),
      plans: p.plans,
    };
    for (const [id, r] of p.originals) {
      const e = await entry(`originals/${id}.bin`, r, signal);
      need(e.sha256 === id, 'Original hash');
      entries.push(e);
    }
    entries.unshift(await entry('manifest.json', memory(jsonBytes(manifest)), signal));
    return entries;
  }
  async function openProject(reader: Reader, signal: AbortSignal): Promise<Project<C, P>> {
    const entries = await readZip(reader, signal);
    need(
      entries.filter((e) => e.name.startsWith('native/')).length <= 8 &&
        entries.filter((e) => e.name.startsWith('originals/')).length <= 100,
      'Record count',
    );
    need(
      entries.filter((e) => e.name.startsWith('originals/')).reduce((n, e) => n + e.size, 0n) <=
        MAX_ORIGINALS,
      'Original aggregate budget',
    );
    need(
      entries.every((e) => e.name.startsWith('originals/') || e.size <= 65536n),
      'Metadata byte budget',
    );
    const raw = await json(entries[0].reader, signal);
    fields(raw, ['format', 'operationId', 'capture', 'selectedVersionId', 'versions', 'plans']);
    need(
      raw.format === profile.format &&
        Array.isArray(raw.versions) &&
        raw.versions.length <= 8 &&
        new Set(raw.versions).size === raw.versions.length,
      'Manifest profile',
    );
    const verified = new Map<string, Entry>();
    for (const e of entries) {
      const actual = await scan(e.reader, signal);
      need(
        actual.crc === e.crc &&
          (e.name === 'manifest.json' || e.name.split('/')[1].split('.')[0] === actual.sha256),
        'Entry CRC/SHA mismatch',
      );
      verified.set(e.name, { ...e, ...actual });
    }
    const m = raw as unknown as Manifest<C, P>;
    const versions: ArtifactVersion<C>[] = [];
    for (const name of m.versions) {
      need(
        typeof name === 'string' && name.startsWith('native/') && verified.has(name),
        'Missing native',
      );
      versions.push((await json(verified.get(name)!.reader, signal)) as ArtifactVersion<C>);
    }
    const originals = new Map<string, Reader>();
    for (const e of entries)
      if (e.name.startsWith('originals/')) originals.set(e.name.slice(10, -4), e.reader);
    need(entries.length === 1 + versions.length + originals.size, 'Unexpected native entry');
    const p: Project<C, P> = {
      operationId: m.operationId,
      capture: m.capture,
      selectedVersionId: m.selectedVersionId,
      plans: m.plans,
      versions,
      originals,
    };
    await validateProject(p);
    signal.throwIfAborted();
    return p;
  }

  return { validateProject, prepareProject, openProject };
}
