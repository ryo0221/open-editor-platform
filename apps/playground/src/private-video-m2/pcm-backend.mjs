/* global __EDITOR_PRIVATE_M2_PCM_MODE__, __EDITOR_PRIVATE_M2_PCM_BYTES__ */
// Private build selection only; never a saved preference or a runtime fallback.
import {
  configureM2Pcm,
  configureM2PcmFactory,
  m2PcmDiagnostics,
} from '../../../../packages/video-core/src/pcm/owners';
import '../../../../packages/video-metadata/host-media/m2/observe-validation.mjs';
const mode =
  typeof __EDITOR_PRIVATE_M2_PCM_MODE__ === 'undefined' ? 'js' : __EDITOR_PRIVATE_M2_PCM_MODE__;
if (!['js', 'wasm'].includes(mode)) throw Error('Private M2 PCM build selection');
if (mode === 'wasm') {
  // Typed input backing construction follows admission.
  configureM2PcmFactory(4972, () => {
    if (typeof __EDITOR_PRIVATE_M2_PCM_BYTES__ === 'undefined')
      throw Error('Private M2 PCM build selection');
    return new Uint8Array(__EDITOR_PRIVATE_M2_PCM_BYTES__);
  });
} else configureM2Pcm('js');
globalThis.privatePcmDiagnostics = m2PcmDiagnostics;
