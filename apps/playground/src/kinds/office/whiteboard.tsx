import { memo } from 'react';
import { WhiteboardSurface } from '@editor-platform/whiteboard';
import { whiteboardKind } from '@editor-platform/whiteboard/kind';
import { hostKind, type HostSurfaceProps, type KindContent } from '../host-kind';

const MemoWhiteboardSurface = memo(WhiteboardSurface);

function WhiteboardHost({ host, content }: HostSurfaceProps<KindContent<typeof whiteboardKind>>) {
  return (
    <MemoWhiteboardSurface
      references={host.sharedSession ? undefined : host.references}
      focusReferenceId={host.revealAddress?.elementId}
      layout={host.whiteboardLayout}
      content={content}
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
    />
  );
}

export const whiteboardSurface = hostKind(whiteboardKind, { Surface: WhiteboardHost });
