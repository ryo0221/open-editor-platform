import type { ReferenceResolver } from '@editor-platform/artifact-references';
import type { DocumentContent } from './model';

/** Capture only blocks emitted by the chosen static format, without changing the draft. */
export async function captureDocumentReferences(
  initial: DocumentContent,
  references?: ReferenceResolver,
  includeHidden = false,
): Promise<DocumentContent> {
  const scope = initial.blocks.filter((block) => includeHidden || !block.hidden);
  if (!scope.some((block) => block.reference)) return initial;
  if (!references) throw new Error('参照付きの出力には参照接続が必要です。');
  const captured = new Map((await references.capture(scope)).map((block) => [block.id, block]));
  return { ...initial, blocks: initial.blocks.map((block) => captured.get(block.id) ?? block) };
}
