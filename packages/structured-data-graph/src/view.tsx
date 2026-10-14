import { useRef, useState } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { type EditorCommand, type Region } from '@editor-platform/editor-core';
import { type StructuredData } from '@editor-platform/structured-data/model';
import {
  GraphSurface,
  GraphBinding,
  type GraphProjection,
} from '@editor-platform/structured-graph';
import {
  createDataGraphNode,
  dataGraphAdapter,
  dataEdgeId,
  dataNodeId,
  dataRowId,
  dataColumnId,
  newDataGraphNodeId,
} from './adapter';
export interface DataGraphSurfaceProps {
  content: StructuredData;
  execute: (cmd: EditorCommand<StructuredData>) => void | boolean;
  select: (id: string, region?: Region) => void;
  readOnly?: boolean;
  sourceRevision: string;
  visibleRowIds?: string[];
  openSource?: (rowId?: string) => void;
  openDefinition?: (columnId?: string) => void;
}
export function DataGraphSurface({
  content,
  execute,
  select,
  readOnly = false,
  sourceRevision,
  visibleRowIds,
  openSource,
  openDefinition,
}: DataGraphSurfaceProps) {
  const latest = useRef({ content, execute, readOnly, sourceRevision });
  latest.current = { content, execute, readOnly, sourceRevision };
  const [error, setError] = useState('');
  const [binding] = useState(
    () =>
      new GraphBinding({
        adapter: dataGraphAdapter,
        sourceId: 'data',
        read: () => ({
          content: latest.current.content,
          revision: latest.current.sourceRevision,
          readOnly: latest.current.readOnly,
        }),
        execute: (cmd) => {
          if (latest.current.execute(cmd) === false)
            throw new Error('Host refused the Data command');
        },
      }),
  );
  let projection: GraphProjection;
  try {
    projection = binding.project();
  } catch (e) {
    return (
      <div>
        <p role="alert">
          Graphを表示できません: {(e as Error).message}。元データと項目定義を確認してください。
        </p>
        <p>所有元: Structured Data</p>
        {openSource && <button onClick={() => openSource()}>元データを開く</button>}
        {openDefinition && <button onClick={() => openDefinition()}>データ定義</button>}
      </div>
    );
  }
  return (
    <>
      <GraphSurface
        content={projection.graph}
        profile={projection.profile}
        stamp={projection.stamp}
        previewEdit={(intents) => {
          binding.preview(intents);
        }}
        sourceActions={{
          owner: 'Structured Data',
          readOnlyReason: readOnly ? 'このHostではデータ定義を編集できません。' : undefined,
          onOpenSource:
            openSource &&
            ((id) => {
              const edge = projection.graph.edges.find((edge) => edge.id === id);
              const nodeId =
                edge?.from ??
                (projection.graph.nodes.some((node) => node.id === id) ? id : undefined);
              openSource(nodeId ? dataRowId(nodeId, content) : undefined);
            }),
          onOpenDefinition:
            openDefinition &&
            ((id) => {
              const edge = projection.graph.edges.find((edge) => edge.id === id);
              openDefinition(edge ? dataColumnId(edge.type, content) : undefined);
            }),
        }}
        onEdit={(intents, base) => {
          try {
            binding.apply(intents, base);
            setError('');
            return true;
          } catch (e) {
            setError((e as Error).message);
            return false;
          }
        }}
        readOnly={readOnly}
        select={(id) => {
          const edge = projection.graph.edges.find((e) => e.id === id);
          if (edge)
            select(dataRowId(edge.from, content), {
              type: 'cell',
              columnId: dataColumnId(edge.type, content),
            });
          else if (projection.graph.nodes.some((n) => n.id === id)) select(dataRowId(id, content));
        }}
        visibleNodeIds={visibleRowIds?.map(dataNodeId)}
        diagnostics={projection.diagnostics}
        nodeId={() => dataNodeId(newDataGraphNodeId())}
        nodeFactory={(id) => createDataGraphNode(content, dataRowId(id, content))}
        edgeId={(from, type) => dataEdgeId(dataRowId(from, content), dataColumnId(type, content))}
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}
/** Fingerprint is useful when a Host has no revision counter; a real Session revision is preferred. */
export const dataGraphRevision = (content: StructuredData) => canonicalJson(content);
