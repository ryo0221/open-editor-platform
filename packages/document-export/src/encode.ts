import { acceptsExport, checkExportAbort, type ExportConsent } from '@editor-platform/export-core';
import { ownedDocumentDocxPlan } from './plan';
import type { DocumentDocxPlan, DocumentDocxResult } from './types';

export async function encodeDocumentDocx(
  plan: DocumentDocxPlan,
  consent: ExportConsent,
  signal?: AbortSignal,
): Promise<DocumentDocxResult> {
  if (signal?.aborted) return { status: 'cancelled' };
  const owned = ownedDocumentDocxPlan(plan);
  if (!owned)
    return {
      status: 'failed',
      code: 'INVALID_PLAN',
      message: 'Prepare a document export plan in this process first',
    };
  if (!acceptsExport(owned.report, consent)) return { status: 'blocked', report: owned.report };
  try {
    const { encodeOwnedDocx } = await import('./docx-adapter');
    checkExportAbort(signal);
    return await encodeOwnedDocx(owned, signal);
  } catch {
    if (signal?.aborted) return { status: 'cancelled' };
    return {
      status: 'failed',
      code: 'ENCODE_FAILED',
      message: 'Encoding failed; no partial file was produced',
    };
  }
}
