import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  cadAssetMediaTypes,
  applyCadOperation,
  cadContentHash,
  f01Empty,
  sk01Watch,
  type CadDocument,
} from '@editor-platform/cad-core';
import { bimContentHash, f31BoxBuilding } from '@editor-platform/bim-core';
import { drawingStarter, type DrawingDocument } from '@editor-platform/drawing-core';
import type { StoredArtifact } from '../model';
import { encodeBytes, type CadResource } from '../cad/resources';
import {
  drawingAssetBytes,
  drawingIssuePdf,
  drawingIssueRecord,
  drawingSourceClosure,
  mergeDrawingSources,
  portableDrawingRecord,
  stageDrawingSources,
  validateDrawingSources,
} from './sources';

// DW1 (docs/cad/drawing-editor.md, 元の版の保持). ST-700, TS-2402.
const watch = sk01Watch();
const assembly = watch.assembly;
const building = f31BoxBuilding();
const withSources = (refs: { kind: 'cad' | 'bim'; contentHash: string }[]): DrawingDocument => {
  const doc = drawingStarter();
  doc.sources = refs.map((r, i) => ({
    id: `src-${i}`,
    kind: r.kind,
    artifactId: `a-${i}`,
    versionId: 'v1',
    contentHash: r.contentHash,
    name: `S${i}`,
  }));
  return doc;
};
const record = (draft: DrawingDocument, versions: DrawingDocument[] = []) =>
  ({
    kind: 'drawing',
    draft: { content: draft },
    versions: versions.map((content) => ({ content })),
  }) as unknown as StoredArtifact;

describe('drawing sources (DW1)', () => {
  it('keeps an assembly with its whole part closure and a building, each once', () => {
    const doc = withSources([
      { kind: 'cad', contentHash: cadContentHash(assembly) },
      { kind: 'bim', contentHash: bimContentHash(building) },
    ]);
    const staged = stageDrawingSources(
      record(doc),
      [
        { kind: 'cad', content: assembly },
        { kind: 'bim', content: building },
        { kind: 'cad', content: assembly },
      ],
      watch.lookup,
    );
    const parts = new Set(assembly.parts.map((p) => p.source.contentHash));
    expect(staged.drawingSources!.length).toBeGreaterThanOrEqual(parts.size + 2);
    expect(() => validateDrawingSources(staged)).not.toThrow();
    const { reached } = drawingSourceClosure(staged);
    for (const h of parts) expect(reached.get(h)?.kind).toBe('cad');
    // Each version's closure is walked once, however often it is reached (Codex on #1237).
    const count = (versions: { kind: 'cad'; content: CadDocument }[]) => {
      let n = 0;
      stageDrawingSources(record(doc), versions, (h) => (n++, watch.lookup(h)));
      return n;
    };
    const once = count([{ kind: 'cad', content: assembly }]);
    expect(once).toBeGreaterThan(0);
    expect(
      count([
        { kind: 'cad', content: assembly },
        { kind: 'cad', content: assembly },
        { kind: 'cad', content: assembly },
      ]),
    ).toBe(once);
  });

  it('refuses a missing, altered, wrong-kind or unreferenced version', () => {
    const doc = withSources([{ kind: 'cad', contentHash: cadContentHash(assembly) }]);
    const staged = stageDrawingSources(
      record(doc),
      [{ kind: 'cad', content: assembly }],
      watch.lookup,
    );
    const without = { ...staged, drawingSources: staged.drawingSources!.slice(1) };
    expect(() => validateDrawingSources(without)).toThrow('Drawing source missing');
    const altered = structuredClone(staged);
    altered.drawingSources![0]!.content = {
      ...altered.drawingSources![0]!.content,
      name: 'x',
    } as never;
    expect(() => validateDrawingSources(altered)).toThrow(/hash mismatch|content/);
    const asBim = record(withSources([{ kind: 'bim', contentHash: cadContentHash(assembly) }]));
    expect(() =>
      validateDrawingSources({ ...asBim, drawingSources: staged.drawingSources }),
    ).toThrow('Drawing source kind');
    const extra = stageDrawingSources(staged, [{ kind: 'bim', content: building }], watch.lookup);
    expect(() => validateDrawingSources(extra)).toThrow('not referenced');
    expect(() => validateDrawingSources(extra, { stored: true })).not.toThrow();
    expect(() =>
      stageDrawingSources(record(doc), [{ kind: 'cad', content: assembly }], () => undefined),
    ).toThrow('source-missing');
  });

  it('exports only what the draft and versions reach, and merges both sides of a save', () => {
    const doc = withSources([{ kind: 'bim', contentHash: bimContentHash(building) }]);
    const both = stageDrawingSources(
      record(doc),
      [
        { kind: 'bim', content: building },
        { kind: 'cad', content: assembly },
      ],
      watch.lookup,
    );
    const out = portableDrawingRecord(both);
    expect(out.drawingSources!.map((p) => p.kind)).toEqual(['bim']);
    expect(() => validateDrawingSources(out)).not.toThrow();
    const merged = mergeDrawingSources(out, { drawingSources: both.drawingSources!.slice(1, 2) });
    expect(merged.drawingSources).toHaveLength(2);
  });
});

// DW3c-2 (ST-706, TS-2418): the asset bytes the kept CAD versions name travel with the drawing.
describe('drawing assets (DW3c-2)', () => {
  const bytes = new TextEncoder().encode('ISO-10303-21; fake STEP for the closure');
  const sha = `sha256:${bytesToHex(sha256(bytes))}`;
  const resource: CadResource = {
    kind: 'source-step',
    sha256: sha,
    byteLength: bytes.length,
    mediaType: cadAssetMediaTypes['source-step'],
    encoding: 'base64',
    bytes: encodeBytes(bytes),
  };
  // One body as STEP import inserts it: its STEP original and normalized BRep (one fake byte
  // string for both kinds here).
  const ref = (id: string, kind: 'source-step' | 'normalized-brep') => ({
    id,
    kind,
    sha256: sha,
    byteLength: bytes.length,
    mediaType: cadAssetMediaTypes[kind],
  });
  const part: CadDocument = applyCadOperation(f01Empty(), {
    type: 'insertImportedBody',
    assets: [ref('s-1', 'source-step'), ref('b-1', 'normalized-brep')],
    feature: {
      id: 'imp-1',
      name: 'part',
      type: 'imported',
      inputFeatureIds: [],
      args: {
        kind: 'solid',
        sourceAssetId: 's-1',
        brepAssetId: 'b-1',
        importer: { id: 'occt', buildHash: `sha256:${'f'.repeat(64)}` },
        sourceUnit: 'mm',
        scaleToMm: 1,
      },
    },
    body: {
      id: 'part',
      name: 'part',
      sourceFeatureId: 'imp-1',
      placementFeatureId: 'place-1',
      appearance: { color: '#8899aa', opacity: 1 },
    },
  });
  const brep: CadResource = {
    ...resource,
    kind: 'normalized-brep',
    mediaType: cadAssetMediaTypes['normalized-brep'],
  };
  const doc = withSources([{ kind: 'cad', contentHash: cadContentHash(part) }]);
  const lookup = (kind: string, s: string) =>
    s !== sha
      ? undefined
      : kind === 'source-step'
        ? resource
        : kind === 'normalized-brep'
          ? brep
          : undefined;

  it('keeps the bytes once, checks them, exports and merges them with their versions', () => {
    expect(() =>
      stageDrawingSources(record(doc), [{ kind: 'cad', content: part }], () => undefined),
    ).toThrow('source-assets');
    const staged = stageDrawingSources(
      record(doc),
      [{ kind: 'cad', content: part }],
      () => undefined,
      lookup,
    );
    expect(staged.drawingAssets).toEqual([resource, brep]);
    expect(() => validateDrawingSources(staged)).not.toThrow();
    expect(drawingAssetBytes(staged, sha)).toEqual(bytes);
    // Missing, altered or unreferenced bytes refuse the record.
    expect(() => validateDrawingSources({ ...staged, drawingAssets: [] })).toThrow(
      'Drawing asset missing',
    );
    const altered = { ...resource, bytes: encodeBytes(new TextEncoder().encode('other')) };
    expect(() => validateDrawingSources({ ...staged, drawingAssets: [altered, brep] })).toThrow(
      'hash mismatch',
    );
    const none = record(withSources([]));
    const extra = { ...none, drawingSources: [], drawingAssets: [resource] };
    expect(() => validateDrawingSources(extra)).toThrow('not referenced');
    expect(() => validateDrawingSources(extra, { stored: true })).not.toThrow();
    // A building placing the imported part keeps it without its bytes: the building draws it
    // without them (Codex on #1237); a CAD view of the part then keeps them.
    const placing = structuredClone(building);
    placing.types.push({
      id: 't-part',
      kind: 'part',
      name: 'Part',
      source: { artifactId: 'p', versionId: 'v1', contentHash: cadContentHash(part) },
      hintBounds: { min: [0, 0, 0], max: [10, 10, 10] },
    });
    const bimDoc = withSources([{ kind: 'bim', contentHash: bimContentHash(placing) }]);
    const viaBuilding = stageDrawingSources(
      record(bimDoc),
      [{ kind: 'bim', content: placing }],
      (h) => (h === cadContentHash(part) ? part : undefined),
    );
    expect(viaBuilding.drawingSources).toHaveLength(2);
    expect(viaBuilding.drawingAssets).toBeUndefined();
    expect(() => validateDrawingSources(viaBuilding)).not.toThrow();
    expect(portableDrawingRecord(viaBuilding).drawingAssets).toBeUndefined();
    // Then drawn as CAD: its bytes are kept with it (Codex on #1237).
    const both = {
      ...viaBuilding,
      draft: {
        ...viaBuilding.draft,
        content: withSources([
          { kind: 'bim', contentHash: bimContentHash(placing) },
          { kind: 'cad', contentHash: cadContentHash(part) },
        ]),
      },
    };
    expect(() => validateDrawingSources(both)).toThrow('Drawing asset missing');
    const promoted = stageDrawingSources(
      both,
      [{ kind: 'cad', content: part }],
      () => undefined,
      lookup,
    );
    expect(promoted.drawingSources).toHaveLength(2);
    expect(promoted.drawingAssets).toEqual([resource, brep]);
    expect(() => validateDrawingSources(promoted)).not.toThrow();
    expect(portableDrawingRecord(extra).drawingAssets).toEqual([]);
    expect(mergeDrawingSources(staged, { drawingSources: [] }).drawingAssets).toEqual([
      resource,
      brep,
    ]);
  });

  it('checks the bytes against every version naming them (Codex on #1219)', () => {
    // An earlier version names the same asset with another length: it could not evaluate.
    const other = structuredClone(part);
    other.assets[0]!.byteLength = bytes.length + 1;
    const both = withSources([
      { kind: 'cad', contentHash: cadContentHash(other) },
      { kind: 'cad', contentHash: cadContentHash(part) },
    ]);
    const kept = stageDrawingSources(
      record(both),
      [
        { kind: 'cad', content: part },
        { kind: 'cad', content: other },
      ],
      () => undefined,
      lookup,
    );
    expect(() => validateDrawingSources(kept)).toThrow('does not match its ref');
  });
});

describe('drawing issues (DW6b)', () => {
  // ST-714, TS-2448: an issue names a saved version, its sheets' marks are in that version, its
  // PDF is the bytes its hash names; the record keeps every issue on both sides of a save.
  const issuedDoc = drawingStarter();
  issuedDoc.sheets[0]!.revisions.push({
    id: 'rev-1',
    mark: 'A',
    date: '2026-11-14',
    description: '発行',
    by: '',
  });
  const pdf = new TextEncoder().encode('%PDF-1.7 issued');
  const base = {
    kind: 'drawing',
    draft: { content: issuedDoc },
    versions: [{ versionId: 'v-1', content: issuedDoc }],
  } as unknown as StoredArtifact;
  const issue = drawingIssueRecord(
    'v-1',
    '2026-11-14T00:00:00.000Z',
    [{ sheetId: issuedDoc.sheets[0]!.id, name: 'Sheet 1', mark: 'A' }],
    pdf,
  );

  it('keeps an issue with its version, refusing one altered or naming no version', () => {
    const r = { ...base, drawingIssues: [issue] };
    expect(() => validateDrawingSources(r)).not.toThrow();
    expect(drawingIssuePdf(r, 'v-1')).toEqual(pdf);
    expect(portableDrawingRecord(r).drawingIssues).toEqual([issue]);
    const altered = { ...issue, pdf: { ...issue.pdf, bytes: btoa('%PDF-1.7 altered') } };
    expect(() => validateDrawingSources({ ...base, drawingIssues: [altered] })).toThrow(
      'Drawing issue',
    );
    expect(() =>
      validateDrawingSources({ ...base, drawingIssues: [{ ...issue, versionId: 'v-9' }] }),
    ).toThrow('Drawing issue version missing');
    expect(() =>
      validateDrawingSources({
        ...base,
        drawingIssues: [{ ...issue, sheets: [{ ...issue.sheets[0]!, mark: 'B' }] }],
      }),
    ).toThrow('Drawing issue sheet');
    expect(() => validateDrawingSources({ ...base, drawingIssues: [issue, issue] })).toThrow(
      'Drawing issue duplicated',
    );
    // Both sides of a save keep their issues.
    const other = { ...issue, versionId: 'v-2' };
    expect(
      mergeDrawingSources({ drawingIssues: [issue] }, { drawingIssues: [other] }).drawingIssues,
    ).toEqual([other, issue]);
  });
});
