import { mountV2Host } from './host-v2';
import { productCodecV2 } from './product-codec-v2.mjs';
globalThis.videoV2Ready = mountV2Host(
  globalThis.document.querySelector('main'),
  undefined,
  productCodecV2,
).then((host) => {
  globalThis.closeVideoV2 = host.close;
});
