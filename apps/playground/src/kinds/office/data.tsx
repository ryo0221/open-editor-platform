import { memo } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { EditorSession } from '@editor-platform/editor-core';
import {
  DataSurface,
  isStructuredData,
  defaultView,
  type DataView,
  type StructuredData,
} from '@editor-platform/structured-data';
import { dataKind } from '@editor-platform/structured-data/kind';
import { DataGraphSurface } from '@editor-platform/structured-data-graph';
import type { Content } from '../../model';
import { hostKind } from '../host-kind';
import type { SurfaceHost } from '../surface-host';

const MemoDataSurface = memo(DataSurface);

/** Restores a saved view preference only while it still validates against the data. */
function retainedDataView(data: StructuredData, view: DataView | undefined) {
  if (!view || !isStructuredData({ ...data, views: [view] })) return undefined;
  return {
    ...view,
    widgets:
      data.views?.find((saved) => saved.id === view.id)?.widgets ?? defaultView(data).widgets,
  };
}

function DataHost({ host, content }: { host: SurfaceHost; content: StructuredData }) {
  const { session } = host;
  return (
    <MemoDataSurface
      content={content}
      initialView={retainedDataView(content, host.dataViews[host.active.id])}
      onViewChange={host.dataViewChanged}
      renderGraph={
        host.shared
          ? undefined
          : (props) => (
              <DataGraphSurface
                {...props}
                sourceRevision={canonicalJson((session as EditorSession<Content>).revision)}
              />
            )
      }
      readOnly={host.readOnly}
      execute={host.execute}
      select={host.select}
    />
  );
}

export const dataSurface = hostKind(dataKind, {
  Surface: DataHost,
  // Older readable schemas are listed and exported; the Surface opens only the current one.
  accepts: isStructuredData,
});
