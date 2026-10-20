import type { ComponentProps } from 'react';
import type { ElementAddress } from '@editor-platform/editor-core';
import type { DesignContent } from '@editor-platform/design/model';
import { isDesign } from '@editor-platform/design';
import type { AnimationDesignImportPanel } from '@editor-platform/animation-adapters/design-ui';
import type { AnimationHostContent } from '@editor-platform/animation-core/v2';
import {
  displayCell,
  isStructuredData,
  type StructuredData,
} from '@editor-platform/structured-data';
import {
  isReview,
  reviewAddressRevision,
  reviewRevision,
  type ReviewSurface,
} from '@editor-platform/review-surfaces';
import type { SlideSurface } from '@editor-platform/slide';
import { validContent, type StoredArtifact } from '../model';

type SlideProps = ComponentProps<typeof SlideSurface>;
type ReviewSource = Awaited<
  ReturnType<NonNullable<ComponentProps<typeof ReviewSurface>['resolveAnnotationSource']>>
>;

/** Every saved Design frame, at every version, as an Animation import source. */
export function designFrameSources(
  records: StoredArtifact[],
): ComponentProps<typeof AnimationDesignImportPanel>['sources'] {
  return records
    .filter((record) => record.kind === 'design')
    .flatMap((record) =>
      record.versions.flatMap((version) =>
        isDesign(version.content)
          ? version.content.elements
              .filter((element) => element.type === 'frame')
              .map((frame) => ({
                source: {
                  artifactId: record.id,
                  versionId: version.versionId,
                  contentHash: version.contentHash,
                  compositionId: frame.id,
                },
                content: version.content as DesignContent,
                label: `${record.name} / ${frame.name} / ${version.versionId}`,
              }))
          : [],
      ),
    );
}

/** Every saved Animation composition, at every version, for Slide embedding. */
export function slideAnimationSources(
  records: StoredArtifact[],
): NonNullable<SlideProps['animationSources']> {
  return records
    .filter((r) => r.kind === 'animation')
    .flatMap((r) =>
      r.versions.flatMap((version, index) => {
        if (!validContent('animation', version.content)) return [];
        const content = version.content as AnimationHostContent;
        return content.compositions.map((c) => ({
          source: {
            artifactId: r.id,
            versionId: version.versionId,
            contentHash: version.contentHash,
            compositionId: c.id,
          },
          content,
          label: r.name,
          versionLabel: `版 ${index + 1}`,
        }));
      }),
    );
}

/** Chart snapshots from each data draft: first column labels and its first formula/number column. */
export function slideDataSnapshots(
  records: StoredArtifact[],
): NonNullable<SlideProps['dataSnapshots']> {
  return records
    .filter((a) => isStructuredData(a.draft.content))
    .map((a) => {
      const data = a.draft.content as StructuredData;
      const column =
        data.columns.find((c) => c.type === 'formula') ??
        data.columns.find((c) => c.type === 'number');
      return {
        label: a.name,
        labels: data.rows.map((r) => String(r.values[data.columns[0]?.id] ?? '')),
        values: data.rows.map((r) => (column ? Number(displayCell(data, r, column)) || 0 : 0)),
        capturedAt: new Date().toISOString(),
      };
    });
}

/** Finds the saved review revision a line annotation was anchored to. */
export function reviewAnnotationSource(
  record: StoredArtifact | undefined,
  address: ElementAddress,
): ReviewSource {
  const region = address.region;
  if (region?.type !== 'lines') return undefined;
  for (const version of record?.versions ?? [])
    if (isReview(version.content)) {
      const file = version.content.files.find((file) => file.id === address.elementId);
      const side = region.side ?? 'new';
      if (file && reviewRevision(file, side) === reviewAddressRevision(address))
        return {
          name: file.name,
          revisionId: reviewRevision(file, side),
          side,
          text: side === 'old' ? file.oldText : file.newText,
        };
    }
  return undefined;
}
