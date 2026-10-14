import { expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { clone } from '@editor-platform/artifact-core';
import { isDeck } from '@editor-platform/slide/model';
import { isDocument } from '@editor-platform/document/model';
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
} from '@editor-platform/slide-export';
import {
  captureDocumentExportSnapshot,
  prepareDocumentDocx,
  encodeDocumentDocx,
} from '@editor-platform/document-export';
import type { ExportFontProfile } from '@editor-platform/export-core';
import { officeReuseCases } from '../../../tests/fixtures/reuse/office';

it('R15 exports adopted values and pinned versions, requires current reuse-loss consent and excludes retained definitions', async () => {
  const png = {
      mime: 'image/png' as const,
      width: 1,
      height: 1,
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ3kAAAAASUVORK5CYII=',
          'base64',
        ),
      ),
    },
    image = `data:image/png;base64,${Buffer.from(png.bytes).toString('base64')}`;
  // Contract-only font manifest; actual rendering uses the verified physical fonts.
  const contractFont: ExportFontProfile = {
    id: 'contract',
    family: 'Noto Sans CJK JP',
    version: 'test',
    license: 'OFL',
    verified: true,
    faces: [
      { weight: 'regular', sha256: 'a'.repeat(64) },
      { weight: 'bold', sha256: 'b'.repeat(64) },
    ],
    glyphRanges: [[0, 0x10ffff]],
  };
  const contractOptions = {
    pageIds: 'all' as const,
    includeHiddenSlides: false,
    includeNotes: true,
    fontProfileId: 'contract',
    fallback: 'reject' as const,
  };
  const docOptions = {
    fontProfileId: 'contract',
    styleProfileId: 'document-ja-1' as const,
    mermaid: 'reject' as const,
    previewBlocks: 'reject' as const,
  };
  const cases = await officeReuseCases(image),
    basis = { kind: 'saved-version' as const, artifactId: 'case', versionId: 'one' };
  for (const fixture of cases) {
    if (fixture.domain === 'design') continue;
    for (const [version, content] of [
      ['pinned', fixture.pinned],
      ['adopted', fixture.adopted],
    ] as const) {
      const plan = isDeck(content)
        ? await prepareSlidePptx(
            await captureSlideExportSnapshot(content, basis),
            contractOptions,
            { resolveFont: async () => contractFont, resolveAsset: async () => png },
          )
        : await prepareDocumentDocx(
            await captureDocumentExportSnapshot(
              content as Parameters<typeof captureDocumentExportSnapshot>[0],
              basis,
            ),
            docOptions,
            { resolveFont: async () => contractFont, resolveAsset: async () => png },
          );
      const loss = plan.report.diagnostics.find((d) => d.code === 'REUSABLE_LINKS_RESOLVED')!;
      expect(loss).toMatchObject({
        severity: 'warning',
        requiresAcceptance: true,
        effect: 'editability',
      });
      const consent = {
        planHash: plan.report.planHash,
        acceptedDiagnosticIds: plan.report.diagnostics
          .filter((d) => d.requiresAcceptance)
          .map((d) => d.id),
      };
      const encode = (approval: typeof consent) =>
        isDeck(content)
          ? encodeSlidePptx(plan as Parameters<typeof encodeSlidePptx>[0], approval)
          : encodeDocumentDocx(plan as Parameters<typeof encodeDocumentDocx>[0], approval);
      expect(
        (
          await encode({
            ...consent,
            acceptedDiagnosticIds: consent.acceptedDiagnosticIds.filter((id) => id !== loss.id),
          })
        ).status,
      ).toBe('blocked');
      expect((await encode({ ...consent, planHash: 'previous-plan' })).status).toBe('blocked');
      const result = await encode(consent);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw Error('Export blocked');
      const zip = unzipSync(result.bytes),
        xml = Object.entries(zip)
          .filter(([name]) => /^(word\/document|ppt\/slides\/slide\d+)\.xml$/.test(name))
          .map(([, bytes]) => strFromU8(bytes))
          .join('');
      expect(xml).toContain('案件Aの本文を保持します。');
      expect(xml.toUpperCase()).toContain(version === 'adopted' ? '99331A' : '336699');
      expect(Object.keys(zip).some((name) => name.includes('/media/'))).toBe(true);
      expect(xml).not.toContain('office-brand');
      // Copy-only output has the same native model but no reusable-link loss.
      const copy = clone(content);
      if (isDocument(copy)) {
        delete copy.reuse;
        const copiedPlan = await prepareDocumentDocx(
          await captureDocumentExportSnapshot(copy, basis),
          docOptions,
          { resolveFont: async () => contractFont, resolveAsset: async () => png },
        );
        expect(copiedPlan.report.diagnostics.some((d) => d.code === loss.code)).toBe(false);
      }
    }
  }
}, 15000);
