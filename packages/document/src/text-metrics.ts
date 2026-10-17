import { isDeepFrozen } from '@editor-platform/artifact-core';
import type { DocumentBlock } from './model';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
/** View-only counters. Mutable Host blocks are always read again. */
export function createDocumentTextMetrics() {
  const retained = new WeakMap<DocumentBlock, { words: number; characters: number }>();
  return (blocks: DocumentBlock[]) => {
    let words = 0,
      characters = Math.max(0, blocks.length - 1);
    for (const block of blocks) {
      let metrics = isDeepFrozen(block) ? retained.get(block) : undefined;
      if (!metrics) {
        const text = block.type === 'table' ? (block.cells?.flat().join(' ') ?? '') : block.text;
        let count = 0;
        for (const segment of segmenter.segment(text)) if (segment.isWordLike) count++;
        metrics = { words: count, characters: text.length };
        if (isDeepFrozen(block)) retained.set(block, metrics);
      }
      words += metrics.words;
      characters += metrics.characters;
    }
    return { words, characters };
  };
}
