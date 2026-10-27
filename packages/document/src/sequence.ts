import {
  canonicalJson,
  clone,
  contentHash,
  deepFreeze,
  type Artifact,
} from '@editor-platform/artifact-core';
import { isDocument, type DocumentContent } from './model';

export interface DocumentSequenceSource {
  artifact: Artifact<DocumentContent>;
  versionId: string;
}
export interface DocumentSequenceDiagnostic {
  code:
    | 'missing-version'
    | 'invalid-source'
    | 'unsupported'
    | 'page-settings'
    | 'not-included'
    | 'limit';
  severity: 'error' | 'warning';
  sourceIndex?: number;
  elementId?: string;
  message: string;
}
export interface DocumentSequenceManifest {
  schemaVersion: 1;
  /** Requested order is retained even when a source is missing/corrupt. */
  requests: { artifactId: string; versionId: string; order: number }[];
  sources: {
    artifactId: string;
    versionId: string;
    contentHash: string;
    order: number;
    elements: { sourceId: string; outputId: string }[];
  }[];
  diagnostics: DocumentSequenceDiagnostic[];
}
export const documentSequenceLimits = Object.freeze({
  sources: 128,
  blocks: 2000,
  textCharacters: 1_000_000,
});
/** Derived, owned content only. Never saves/commits a second manuscript or resolves "latest".
 * Feed a successful content to the existing DOCX preflight; keep this manifest with its report. */
export async function composeDocumentSequence(input: readonly DocumentSequenceSource[]) {
  // Capture all inputs before hashing, so concurrent Host changes cannot change a source.
  const sources = clone(input);
  const manifest: DocumentSequenceManifest = {
    schemaVersion: 1,
    requests: sources.map((s, order) => ({
      artifactId: s.artifact.id,
      versionId: s.versionId,
      order,
    })),
    sources: [],
    diagnostics: [],
  };
  const add = (d: DocumentSequenceDiagnostic) => manifest.diagnostics.push(d);
  const output: DocumentContent = { schemaVersion: 2, blocks: [] };
  let characters = 0;
  if (!sources.length || sources.length > documentSequenceLimits.sources)
    add({ code: 'limit', severity: 'error', message: 'Choose 1–128 exact Document versions' });
  else
    for (const [sourceIndex, { artifact, versionId }] of sources.entries()) {
      const versions = artifact.versions.filter((v) => v.versionId === versionId);
      if (!versionId || versions.length !== 1) {
        add({
          code: 'missing-version',
          severity: 'error',
          sourceIndex,
          message: 'Exact retained version is missing or ambiguous',
        });
        continue;
      }
      const version = versions[0];
      const content = version.content;
      if (
        artifact.kind !== 'document' ||
        version.artifactId !== artifact.id ||
        !isDocument(content) ||
        (await contentHash(content)) !== version.contentHash
      ) {
        add({
          code: 'invalid-source',
          severity: 'error',
          sourceIndex,
          message: 'Source kind, native content, ownership or hash is invalid',
        });
        continue;
      }
      const entry: DocumentSequenceManifest['sources'][number] = {
        artifactId: artifact.id,
        versionId,
        contentHash: version.contentHash,
        order: sourceIndex,
        elements: [],
      };
      manifest.sources.push(entry);
      if (Object.keys(content).some((k) => !['schemaVersion', 'page', 'blocks'].includes(k)))
        add({
          code: 'unsupported',
          severity: 'error',
          sourceIndex,
          message: 'Reuse or unknown Document fields cannot be flattened',
        });
      if (
        content.page &&
        Object.keys(content.page).some((k) => !['size', 'margin', 'landscape'].includes(k))
      )
        add({
          code: 'unsupported',
          severity: 'error',
          sourceIndex,
          message: 'Unknown page layout fields cannot be flattened',
        });
      if (sourceIndex === 0 && content.page) output.page = clone(content.page);
      if (canonicalJson(content.page ?? null) !== canonicalJson(output.page ?? null))
        add({
          code: 'page-settings',
          severity: 'warning',
          sourceIndex,
          message: 'Derived output uses the first chapter page settings',
        });
      for (const block of content.blocks) {
        if (
          !['paragraph', 'heading'].includes(block.type) ||
          block.rich?.some((span) =>
            Object.keys(span).some(
              (k) =>
                ![
                  'text',
                  'bold',
                  'italic',
                  'underline',
                  'strike',
                  'code',
                  'link',
                  'color',
                  'highlight',
                ].includes(k),
            ),
          ) ||
          Object.keys(block).some(
            (k) =>
              ![
                'id',
                'type',
                'text',
                'rich',
                'style',
                'styleName',
                'hidden',
                'level',
                'align',
                'indent',
              ].includes(k),
          )
        ) {
          add({
            code: 'unsupported',
            severity: 'error',
            sourceIndex,
            elementId: block.id,
            message: 'Initial sequence subset supports paragraph/heading rich text only',
          });
          continue;
        }
        const outputId = `sequence:${sourceIndex}:${block.id}`;
        entry.elements.push({ sourceId: block.id, outputId });
        output.blocks.push({ ...block, id: outputId });
        characters += (block.rich?.map((s) => s.text).join('') ?? block.text).length;
      }
    }
  if (
    output.blocks.length > documentSequenceLimits.blocks ||
    characters > documentSequenceLimits.textCharacters
  )
    add({
      code: 'limit',
      severity: 'error',
      message: 'Combined output exceeds 2000 blocks / 1000000 UTF-16 units',
    });
  add({
    code: 'not-included',
    severity: 'warning',
    message:
      'Derived output excludes source annotations, history and private selection; Japanese publishing layout is unsupported. Format adapters declare their own capabilities.',
  });
  const ok = !manifest.diagnostics.some((d) => d.severity === 'error');
  return deepFreeze({ ok, content: ok ? output : undefined, manifest });
}
