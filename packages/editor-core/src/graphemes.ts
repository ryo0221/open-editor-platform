let segmenter: Intl.Segmenter | undefined;

/**
 * Japanese grapheme segmenter, created on first use.
 * Creating it when the module loads would make every bundle that imports editor-core fail to load
 * in a JavaScript runtime without `Intl` (for example a sandbox that only runs an extension's validate).
 */
export function graphemeSegmenter(): Intl.Segmenter {
  segmenter ??= new Intl.Segmenter('ja', { granularity: 'grapheme' });
  return segmenter;
}
