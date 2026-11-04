import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { checkDocumentNotation } from '@editor-platform/document/manuscript';
import {
  isDocument,
  isVerticalDocument,
  type DocumentContent,
} from '@editor-platform/document/model';
import { composeDocumentSequence } from '@editor-platform/document/sequence';
import type { Artifact } from '@editor-platform/artifact-core';
import { makeNovelArtifacts, novelNotationRules } from './novel-workspace';

describe('novel demo sample', () => {
  it('creates three saved vertical chapters that compose into one read-through', async () => {
    const chapters = (await makeNovelArtifacts()) as Artifact<DocumentContent>[];
    expect(chapters.map((c) => c.name)).toEqual([
      '灯台守の手紙　第一章',
      '灯台守の手紙　第二章',
      '灯台守の手紙　第三章',
    ]);
    for (const chapter of chapters) {
      expect(isDocument(chapter.draft.content)).toBe(true);
      expect(isVerticalDocument(chapter.draft.content)).toBe(true);
      expect(chapter.versions).toHaveLength(1);
      expect(chapter.draft.baseVersionId).toBe(chapter.versions[0].versionId);
    }
    const spans = chapters.flatMap((c) => c.draft.content.blocks.flatMap((b) => b.rich ?? []));
    expect(spans.some((s) => s.ruby)).toBe(true);
    expect(spans.some((s) => s.emphasisDots)).toBe(true);
    // Each notation rule has something to find somewhere in the sample.
    const found = chapters.flatMap((c) =>
      checkDocumentNotation(c.draft.content, novelNotationRules).map((f) => f.ruleId),
    );
    expect(new Set(found)).toEqual(new Set(novelNotationRules.map((r) => r.id)));
    const reading = await composeDocumentSequence(
      chapters.map((artifact) => ({ artifact, versionId: artifact.draft.baseVersionId! })),
    );
    expect(reading.manifest.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(reading.content?.blocks.length).toBe(
      chapters.reduce((n, c) => n + c.draft.content.blocks.length, 0),
    );
  });
});
