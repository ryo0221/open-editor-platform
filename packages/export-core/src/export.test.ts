import { describe, expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { createDeck } from '@editor-platform/slide/model';
import { createDocument } from '@editor-platform/document/model';
import {
  acceptsExport,
  captureExportSnapshot,
  exportDiagnostic,
  hashExportBytes,
  ownExportAsset,
  validExportBasis,
  type ExportReport,
} from '@editor-platform/export-core';

describe('shared export contracts in Node', () => {
  for (const [domain, create] of [
    ['slide', createDeck],
    ['document', createDocument],
  ] as const)
    for (const basis of [
      { kind: 'local-draft' as const, artifactId: domain },
      { kind: 'confirmed' as const, artifactId: domain, revision: 7 },
      { kind: 'saved-version' as const, artifactId: domain, versionId: 'version-2' },
    ])
      it(`${domain} acquires ${basis.kind} content and basis before yielding`, async () => {
        const content = create();
        const expected = structuredClone(content),
          origin = structuredClone(basis);
        const pending = captureExportSnapshot(content, basis);
        Object.assign(content, { mutationAfterCapture: true });
        Object.assign(basis, { artifactId: 'changed-after-call' });
        const snapshot = await pending;
        expect(snapshot.content).toEqual(expected);
        expect(snapshot.basis).toEqual({ ...origin, contentHash: await contentHash(expected) });
        expect(Object.isFrozen(snapshot.content)).toBe(true);
        expect(Object.isFrozen(Object.values(snapshot.content).find(Array.isArray))).toBe(true);
        expect(validExportBasis(snapshot.basis)).toBe(true);
      });

  it('diagnostic IDs are stable across localization and domain address key ordering', () => {
    const a = exportDiagnostic('LOSS', 'warning', 'English', {
      domain: 'document',
      blockId: 'table',
      cell: { row: 2, column: 3 },
    });
    const b = exportDiagnostic('LOSS', 'warning', '日本語', {
      cell: { column: 3, row: 2 },
      blockId: 'table',
      domain: 'document',
    });
    expect(a.id).toBe(b.id);
    expect(a.address).not.toHaveProperty('slideId');
    expect(
      exportDiagnostic('LOSS', 'warning', 'English', {
        domain: 'slide',
        slideId: 'table',
        elementId: '2',
      }).id,
    ).not.toBe(a.id);
  });

  it('all current warnings require exact consent and errors cannot be waived', async () => {
    const basis = (await captureExportSnapshot({}, { kind: 'local-draft', artifactId: 'id' }))
      .basis;
    const diagnostics = ['A', 'B'].map((code) => exportDiagnostic(code, 'warning', code));
    const report: ExportReport = {
      schemaVersion: 1,
      exporterVersion: '1',
      planHash: 'current',
      basis,
      diagnostics,
    };
    const ids = diagnostics.map((d) => d.id);
    expect(acceptsExport(report, { planHash: 'old', acceptedDiagnosticIds: ids })).toBe(false);
    expect(
      acceptsExport(report, { planHash: 'current', acceptedDiagnosticIds: ids.slice(0, 1) }),
    ).toBe(false);
    expect(
      acceptsExport(report, { planHash: 'current', acceptedDiagnosticIds: [...ids, 'unknown'] }),
    ).toBe(false);
    expect(acceptsExport(report, { planHash: 'current', acceptedDiagnosticIds: ids })).toBe(true);
    report.diagnostics.push(exportDiagnostic('BLOCK', 'error', 'Cannot export'));
    expect(
      acceptsExport(report, {
        planHash: 'current',
        acceptedDiagnosticIds: report.diagnostics.map((d) => d.id),
      }),
    ).toBe(false);
  });

  it('owns typed image bytes without freezing caller memory; rejects forged metadata', async () => {
    const bytes = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC2cAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const a = ownExportAsset({ bytes, mime: 'image/png', width: 1, height: 1 });
    const hash = await hashExportBytes(a.bytes);
    bytes.fill(0);
    expect(await hashExportBytes(a.bytes)).toBe(hash);
    expect(() => ownExportAsset({ ...a, width: 2 })).toThrow('dimensions');
    expect(() => ownExportAsset({ ...a, mime: 'image/jpeg' })).toThrow('signature');
    expect(() => ownExportAsset({ ...a, height: 32_000_001 })).toThrow('limit');
  });
});
