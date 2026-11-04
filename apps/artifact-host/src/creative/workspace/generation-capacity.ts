import {
  commitVersion,
  serializeArtifact,
  updateDraft,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  hostNativeArtifactByteLimit,
  serializeHostNativeArtifact,
} from '@editor-platform/editor-host';
import type { DesignContent } from '@editor-platform/design/model';

/** Size projection only: no version is written, adopted or exposed as a saved version. */
async function candidate(artifact: Artifact<DesignContent>, content: DesignContent) {
  return commitVersion(updateDraft(artifact, content), null, 'Host save');
}

/** Conservative RGBA/base64 allowance, in addition to retained versions and raster ancestors.
 * Ancillary PNG chunks and provider compression are unknown; the second gate remains mandatory.
 */
export async function assertWorldGenerationCapacity(
  artifact: Artifact<DesignContent>,
  content: DesignContent,
  width: number,
  height: number,
  ancestorBytes: number,
) {
  const projected = await candidate(artifact, content);
  // Four copies: src and provenance.src, each in the draft and the next saved version.
  const scanlines = (width * 4 + 1) * height;
  const pngBytes = scanlines + Math.ceil(scanlines / 65535) * 5 + 6 + 65536;
  const imageBytes = 22 + 4 * Math.ceil(pngBytes / 3);
  // Existing content is retained, so this deliberately does not subtract the replaced target.
  // JSON indentation/attribution are included in ancestorBytes and the metadata allowance.
  const allowance = 4 * imageBytes + 2 * ancestorBytes + 65536;
  const bytes = new TextEncoder().encode(serializeArtifact(projected)).length + allowance;
  if (bytes > hostNativeArtifactByteLimit) {
    throw Error(
      `生成前の容量見積りで保存余地が不足しています（保持版込み ${bytes} bytes）。低い解像度または別の成果物を選んでください。旧版は削除しません。`,
    );
  }
}

/** Measure the actual normalized result plus the immutable version that saving will add.
 * The returned synchronous assertion closes the await/commit gap without changing native Undo.
 */
export async function checkWorldResultCapacity(
  artifact: Artifact<DesignContent>,
  content: DesignContent,
): Promise<(current: Artifact<DesignContent>) => void> {
  const before = serializeArtifact(artifact);
  const projected = await candidate(artifact, content);
  try {
    serializeHostNativeArtifact(projected);
  } catch (error) {
    throw Error(
      '生成結果を含む保存候補がnative容量上限を超えています。未適用の結果を保持しました。画像を小さくして再準備してください。',
      { cause: error },
    );
  }
  return (current) => {
    if (serializeArtifact(current) !== before)
      throw Error('容量確認後に保存版が変わりました。もう一度採用してください。');
  };
}
