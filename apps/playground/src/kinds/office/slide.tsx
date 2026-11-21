import { slideKind } from '@editor-platform/slide/kind';
import { SlideSurface } from '@editor-platform/slide';
import { slideAnimationSources, slideDataSnapshots } from '../../app/surface-sources';
import { hostKind, type HostSurfaceProps, type KindContent } from '../host-kind';
import { latestRecord } from '../surface-host';

function SlideHost({ host, content }: HostSurfaceProps<KindContent<typeof slideKind>>) {
  const { sharedSession, revealAddress } = host;
  return (
    <SlideSurface
      animationSources={
        !sharedSession ? slideAnimationSources([...host.savedRecords.current.values()]) : undefined
      }
      openAnimation={
        !sharedSession
          ? (source, objectId, pageId) => {
              const original = latestRecord(host, source.artifactId);
              if (
                !original ||
                original.kind !== 'animation' ||
                host.loadErrors[original.id] ||
                !host.sessions.current.has(original.id)
              )
                throw Error(
                  '元の Animation が見つかりません。保持した版のプレビューは利用できます。',
                );
              if (host.referenceNavigation.current(source.artifactId, objectId, pageId))
                host.setRevealAddress({
                  artifactId: source.artifactId,
                  elementId: source.compositionId,
                });
            }
          : undefined
      }
      references={sharedSession ? undefined : host.references}
      focusReferenceId={revealAddress?.elementId}
      focusAddress={revealAddress}
      content={content}
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
      dataSnapshots={slideDataSnapshots(host.records)}
    />
  );
}

export const slideSurface = hostKind(slideKind, { Surface: SlideHost });
