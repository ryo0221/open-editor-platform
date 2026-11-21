import { canonicalJson } from '@editor-platform/artifact-core';
import type { EditorSession } from '@editor-platform/editor-core';
import {
  NativeGraphSurface,
  isGraphDocument,
  relationProfile,
} from '@editor-platform/structured-graph';
import { graphProfileFor } from '../../app/graph-templates';
import type { Content } from '../../model';
import { graphDefinition } from '../office';
import { hostKind, type HostSurfaceProps, type KindContent } from '../host-kind';
import { readGraphDocument } from '@editor-platform/structured-graph';
import { clone } from '@editor-platform/artifact-core';

function GraphHost({ host, content }: HostSurfaceProps<KindContent<typeof graphDefinition>>) {
  return (
    <NativeGraphSurface
      content={content}
      profile={graphProfileFor(content) ?? relationProfile}
      sourceRevision={canonicalJson((host.session as EditorSession<Content>).revision)}
      execute={host.execute}
      select={host.select}
      selectedId={host.selection.addresses[0]?.elementId}
      readOnly={host.readOnly}
    />
  );
}

export const graphSurface = hostKind(graphDefinition, {
  Surface: GraphHost,
  // Older stored schemas validate because they upgrade; the Surface opens only the current one.
  accepts: isGraphDocument,
  hooks: {
    sharedSessions: false,
    commentsButton: 'disabled',
    // An older Graph version is restored as the current schema.
    restore: (_record, content) => readGraphDocument(clone(content)),
    adoptsOpenedContent: true,
    comments: false,
  },
});
