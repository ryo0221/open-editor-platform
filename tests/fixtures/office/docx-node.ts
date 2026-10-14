import { readFile } from 'node:fs/promises';
import {
  captureDocumentExportSnapshot,
  prepareDocumentDocx,
  encodeDocumentDocx,
  type DocumentDocxOptions,
  type DocxAdapters,
} from '@editor-platform/document-export';
import { prepareOfficeFonts, type OfficeFontManifest } from '@editor-platform/office-adapters';
import { decodeNodeOfficeImage, nodeOfficeImagePng } from '@editor-platform/office-adapters/node';
import type { CaptureBasis, ExportFontProfile } from '@editor-platform/export-core';
import type { DocumentContent } from '@editor-platform/document/model';

export const docxOptions: DocumentDocxOptions = {
  fontProfileId: 'noto-cjk-jp-2.004',
  styleProfileId: 'document-ja-1',
  mermaid: 'source',
  previewBlocks: 'source',
};
export async function nodeDocxAdapters(): Promise<DocxAdapters> {
  const root = 'apps/playground/public/office-fonts/';
  const profiles = new Map<string, ExportFontProfile>();
  for (const name of ['manifest.json', 'mono-manifest.json']) {
    const manifest = JSON.parse(await readFile(root + name, 'utf8')) as OfficeFontManifest;
    const fonts = await prepareOfficeFonts(
      manifest,
      await Promise.all(manifest.faces.map((f) => readFile(root + f.file))),
    );
    profiles.set(manifest.id, structuredClone(fonts.profile) as ExportFontProfile);
  }
  return {
    resolveFont: async (id) => {
      const profile = profiles.get(id);
      if (!profile) throw Error('Unknown fixture font');
      return structuredClone(profile);
    },
    resolveAsset: async (source, signal) => {
      if (!/^data:image\/(png|jpeg|gif|webp);base64,/.test(source))
        throw Error('Fixture resolver accepts embedded images only');
      return decodeNodeOfficeImage(
        new Uint8Array(Buffer.from(source.split(',')[1], 'base64')),
        signal,
      );
    },
    imagePng: nodeOfficeImagePng,
  };
}
export async function nodeDocx(
  content: DocumentContent,
  basis: CaptureBasis,
  options = docxOptions,
  adapters?: DocxAdapters,
) {
  const snapshot = captureDocumentExportSnapshot(content, basis);
  const plan = await prepareDocumentDocx(
    await snapshot,
    options,
    adapters ?? (await nodeDocxAdapters()),
  );
  const result = await encodeDocumentDocx(plan, {
    planHash: plan.report.planHash,
    acceptedDiagnosticIds: plan.report.diagnostics
      .filter((d) => d.requiresAcceptance)
      .map((d) => d.id),
  });
  if (result.status !== 'ok') throw Error(JSON.stringify(result));
  return result;
}
