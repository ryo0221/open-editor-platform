import path from 'node:path';
/** Exact artifact target check for future M2 composition; no permissive v1 fallback. */
export function requirePrivateVideoTarget(bundle, target) {
  const entries = {
    'video-v1-review': 'apps/playground/src/private-video/runtime-entry.mjs',
    'video-v2-review': 'apps/playground/src/private-video-m2/runtime-entry.mjs',
  };
  if (!Object.hasOwn(entries, target)) throw Error('Unknown private Video target');
  const entry = entries[target];
  const outputs = Object.entries(bundle.metafile.outputs);
  if (
    bundle.outputFiles.length !== 1 ||
    outputs.length !== 1 ||
    (bundle.outputFiles[0].path !== '<stdout>' &&
      path.resolve(outputs[0][0]) !== path.resolve(bundle.outputFiles[0].path)) ||
    outputs[0][1].entryPoint !== entry ||
    !Object.hasOwn(bundle.metafile.inputs, entry) ||
    !Object.hasOwn(outputs[0][1].inputs, entry) ||
    !Number.isSafeInteger(outputs[0][1].inputs[entry].bytesInOutput) ||
    outputs[0][1].inputs[entry].bytesInOutput <= 0 ||
    outputs[0][1].bytes !== bundle.outputFiles[0].contents.byteLength
  )
    throw Error('Private Video artifact target mismatch');
  const other = entries[target === 'video-v1-review' ? 'video-v2-review' : 'video-v1-review'];
  if (Object.hasOwn(bundle.metafile.inputs, other))
    throw Error('Mixed private Video runtime entries');
  return Object.freeze({ target, entryPoint: entry });
}
