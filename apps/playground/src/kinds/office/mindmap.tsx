import { memo } from 'react';
import { MindmapSurface } from '@editor-platform/mindmap';
import { mindmapKind } from '@editor-platform/mindmap/kind';
import { hostKind, type HostSurfaceProps, type KindContent } from '../host-kind';

const MemoMindmapSurface = memo(MindmapSurface);

function MindmapHost({ host, content }: HostSurfaceProps<KindContent<typeof mindmapKind>>) {
  return (
    <MemoMindmapSurface
      content={content}
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
      fileName={host.active.name}
    />
  );
}

export const mindmapSurface = hostKind(mindmapKind, { Surface: MindmapHost });
