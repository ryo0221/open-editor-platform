/** Validation build only: scalar PCM hashes and one independent canvas readback. */
import { productCodecV2 } from '../../../video-metadata/host-media/m2/product-codec-v2.mjs';
const encode = productCodecV2.encode;
productCodecV2.encode = async function (...args) {
  const bytes = await encode.apply(this, args);
  globalThis.privateLastExport = productCodecV2.provenance(bytes);
  return bytes;
};
const play = productCodecV2.play;
productCodecV2.play = function (snapshot, at, canvas, signal, report) {
  return play.call(this, snapshot, at, canvas, signal, (evidence) => {
    const frame = evidence.frames.at(-1);
    if (!globalThis.privatePreview && frame?.frame >= 50) {
      globalThis.privatePreview = {
        ...frame,
        width: canvas.width,
        height: canvas.height,
        rgba: Array.from(
          canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
        ),
      };
    }
    report?.(evidence);
  });
};
