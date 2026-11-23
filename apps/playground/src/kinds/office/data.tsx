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
import { inspectFmeaData, isFmeaData } from '../../app/fmea-templates';
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
  const inspection = isFmeaData(content) ? inspectFmeaData(content) : undefined;
  return (
    <>
      {inspection && (
        <section
          aria-label="FMEA inspection (prototype)"
          role="status"
          style={{ padding: '8px 12px', borderBottom: '1px solid #94a3b8' }}
        >
          <strong>FMEA試作 / {inspection.rowCount}件</strong>
          {' · '}RPN = S × O × D（参考値） / AP未評価 {inspection.apPending}件{' · '}
          {inspection.issues.length
            ? `入力要確認 ${inspection.issues.length}件: ${inspection.issues.slice(0, 2).join(' / ')}`
            : 'S/O/D: 1～10を確認'}
          <div style={{ fontSize: '0.8em' }}>
            APは自動判定しません。尺度・評価根拠・対策後の再評価は担当者による確認が必要です。
          </div>
        </section>
      )}
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
    </>
  );
}

export const dataSurface = hostKind(dataKind, {
  Surface: DataHost,
  // Older readable schemas are listed and exported; the Surface opens only the current one.
  accepts: isStructuredData,
  hooks: { exports: { csv: true } },
});
