import { mountV1Host } from './host-v1';
import { productCodecV1 } from './product-codec-v1.mjs';
// Explicit unsaved session: no Storage adapter or portable acceptance claim.
globalThis.videoV1Ready = mountV1Host(
  globalThis.document.querySelector('main'),
  undefined,
  productCodecV1,
).then((host) => {
  globalThis.closeVideoV1 = host.close;
});
