import {
  ReviewSurface,
  isReview,
  assertReviewSelection,
  remapReviewAnnotation,
} from '@editor-platform/review-surfaces';
import { reviewKind } from '@editor-platform/review-surfaces/kind';
import { reviewAnnotationSource } from '../../app/surface-sources';
import { hostKind, type HostSurfaceProps, type KindContent } from '../host-kind';
import { latestRecord } from '../surface-host';

function ReviewHost({ host, content }: HostSurfaceProps<KindContent<typeof reviewKind>>) {
  const { active, readOnly } = host;
  return (
    <ReviewSurface
      onViewSettingsChange={(patch) => host.editPrivateSettings(active.id, patch)}
      viewSettings={host.templateViewSettings[active.id] as { split?: boolean; wrap?: boolean }}
      content={content}
      onSelectionClear={() => host.selectNow([])}
      onVisibleSourceChange={(source) => {
        host.visibleReviewSource.current = { artifactId: active.id, source };
      }}
      resolveAnnotationSource={async (address) =>
        reviewAnnotationSource(latestRecord(host), address)
      }
      onRemapAnnotation={(id, region, fileId) => {
        if (readOnly) return;
        const latest = latestRecord(host)!;
        if (!isReview(latest.draft.content)) return;
        const addresses = [{ artifactId: active.id, elementId: fileId, region }];
        try {
          assertReviewSelection(
            latest.draft.content,
            addresses,
            host.visibleReviewSource.current?.source,
            active.id,
          );
          host.persist({
            ...latest,
            annotations: latest.annotations.map((annotation) =>
              annotation.id === id ? remapReviewAnnotation(annotation, addresses[0]) : annotation,
            ),
          });
        } catch (error) {
          host.setError(String(error));
        }
      }}
      readOnly={readOnly || !!host.sharedSession}
      canComment={!readOnly}
      onAddComment={(body) => host.addComment(host.selection, body)}
      execute={host.execute}
      select={host.select}
      annotations={active.annotations}
      focusAddress={host.revealAddress}
    />
  );
}

export const reviewSurface = hostKind(reviewKind, {
  Surface: ReviewHost,
  hooks: { annotationSurface: true },
});
