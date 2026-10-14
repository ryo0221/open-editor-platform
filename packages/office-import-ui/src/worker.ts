import { prepareSlideImport } from '@editor-platform/slide-import';
import { prepareDocumentImport } from '@editor-platform/document-import';
import type { OfficeImportPlan } from '@editor-platform/office-import-core';
import type { ImportContent } from './protocol';
import { materializeOfficeImport } from '@editor-platform/office-import-core';
import { decodeBrowserOfficeImage } from '@editor-platform/office-adapters/browser';
import type { ImportRequest, ImportResponse } from './protocol';
let plan: OfficeImportPlan<ImportContent> | undefined;
let generation = 0;
const send = (message: ImportResponse) => postMessage(message);
onmessage = async ({ data }: MessageEvent<ImportRequest>) => {
  try {
    if (data.action === 'prepare') {
      const attempt = ++generation;
      plan = undefined;
      const adapters = {
        version: 'office-image-validator-1',
        decodeImage: decodeBrowserOfficeImage,
      };
      const prepared =
        data.format === 'docx'
          ? await prepareDocumentImport(
              { bytes: data.bytes, format: 'docx' },
              data.options,
              data.requestId,
              adapters,
            )
          : await prepareSlideImport(
              { bytes: data.bytes, format: 'pptx' },
              data.options,
              data.requestId,
              adapters,
            );
      if (attempt !== generation) return;
      plan = prepared;
      send({ id: data.id, status: 'prepared', preview: prepared.preview, report: prepared.report });
    } else {
      if (!plan) throw Error('Prepare the import again');
      send({
        id: data.id,
        status: 'materialized',
        artifact: materializeOfficeImport(plan, data.consent),
      });
    }
  } catch (e) {
    send({
      id: data.id,
      status: 'failed',
      code: e && typeof e === 'object' && 'code' in e ? String(e.code) : 'IMPORT_FAILED',
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
