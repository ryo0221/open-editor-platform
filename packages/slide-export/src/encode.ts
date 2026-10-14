import { acceptsExport, checkExportAbort } from '@editor-platform/export-core';
import { ownedSlidePptxPlan } from './plan';
import type { SlidePptxEncoder } from './types';

/** Only an owned, consented plan reaches the lazy encoder. No resolution occurs here. */
export const encodeSlidePptx: SlidePptxEncoder = async (plan, consent, signal) => {
  if (signal?.aborted) return { status: 'cancelled' };
  const owned = ownedSlidePptxPlan(plan);
  if (!owned)
    return {
      status: 'failed',
      code: 'INVALID_PLAN',
      message: 'Prepare an export plan in this process first',
    };
  if (!acceptsExport(owned.report, consent)) return { status: 'blocked', report: owned.report };
  try {
    const { encodeOwnedPptx } = await import('./pptxgen-adapter');
    checkExportAbort(signal);
    return await encodeOwnedPptx(owned, signal);
  } catch {
    if (signal?.aborted) return { status: 'cancelled' };
    return {
      status: 'failed',
      code: 'ENCODE_FAILED',
      message: 'Encoding failed; no partial file was produced',
    };
  }
};
