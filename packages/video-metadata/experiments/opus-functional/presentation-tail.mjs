/** Fixed-profile decoder adapter: honor container DiscardPadding, never an expected test count. */
export function presentationTail(pcm, timing) {
  const { decodedFrames, discardFrames } = timing;
  if (
    !(pcm instanceof Float32Array) ||
    !Number.isSafeInteger(decodedFrames) ||
    !Number.isSafeInteger(discardFrames) ||
    decodedFrames <= 0 ||
    discardFrames < 0 ||
    discardFrames >= 960 ||
    discardFrames >= decodedFrames ||
    pcm.length !== decodedFrames * 2
  )
    throw Error('Decoded Opus/container coverage mismatch');
  return pcm.subarray(0, (decodedFrames - discardFrames) * 2);
}
