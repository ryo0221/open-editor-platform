import { canonicalJson } from '@editor-platform/artifact-core';
import {
  NativeGraphSurface,
  isGraphDocument,
  relationProfile,
} from '@editor-platform/structured-graph';
import { graphProfileFor } from '../../app/graph-templates';
import { evaluateFta, formatProbability } from '../../app/analysis-graph-templates';
import { useEditorDraftPort } from '../editor-draft-port';
import { graphDefinition } from '../office';
import { hostKind, type HostSurfaceProps, type KindContent } from '../host-kind';
import { readGraphDocument } from '@editor-platform/structured-graph';
import { clone } from '@editor-platform/artifact-core';

function GraphHost({ host, content }: HostSurfaceProps<KindContent<typeof graphDefinition>>) {
  const session = useEditorDraftPort(host);
  const evaluation =
    content.profile.id === 'analysis-fault-tree' ? evaluateFta(content) : undefined;
  return (
    <>
      {evaluation && (
        <section aria-label="FTA evaluation (prototype)" role="status" className="analysis-banner">
          <strong>FTA試算（静的・独立事象の仮定）: </strong>
          {evaluation.ok
            ? `トップ事象の確率 ${formatProbability(evaluation.probability)} / 基本事象 ${evaluation.basicEventIds.length}件`
            : `計算不可: ${evaluation.issues.join(' / ')}`}
          <div className="analysis-banner-note">
            説明用の計算です。共通原因故障、時間依存、実証された独立性、認証済み安全解析には対応しません。
          </div>
        </section>
      )}
      <NativeGraphSurface
        content={content}
        profile={graphProfileFor(content) ?? relationProfile}
        sourceRevision={canonicalJson(session.revision)}
        execute={host.execute}
        select={host.select}
        selectedId={
          host.selection.addresses[0]?.elementId ??
          (host.revealAddress?.artifactId === host.active.id
            ? host.revealAddress.elementId
            : undefined)
        }
        readOnly={host.readOnly}
        itemReferences={host.itemReferences}
      />
    </>
  );
}

export const graphSurface = hostKind(graphDefinition, {
  Surface: GraphHost,
  // Older stored schemas validate because they upgrade; the Surface opens only the current one.
  accepts: isGraphDocument,
  hooks: {
    commentsButton: 'disabled',
    // An older Graph version is restored as the current schema.
    restore: (_record, content) => readGraphDocument(clone(content)),
    adoptsOpenedContent: true,
    comments: false,
  },
});
