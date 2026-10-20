import { useEffect, useState } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { type GraphDocument, type GraphEdge } from './model';
import { type GraphProfile } from './profile';
import { type GraphIntent } from './commands';
import { errorMessage, type GraphApply } from './view-model';

export interface GraphConnectionInput {
  base: string;
  target: string;
  dirty: boolean;
  type: string;
  from: string;
  to: string;
}
export type GraphConnectionPatch = Partial<Pick<GraphConnectionInput, 'from' | 'to' | 'type'>>;

/** Connection form buffer bound to one source revision and selection. */
export function useGraphConnection({
  stamp,
  id,
  edge,
  profile,
}: {
  stamp: string;
  id: string;
  edge?: GraphEdge;
  profile: GraphProfile;
}) {
  const currentConnection = (): GraphConnectionInput => ({
    base: stamp,
    target: id,
    dirty: false,
    type: edge?.type ?? Object.keys(profile.edges)[0] ?? '',
    from: edge?.from ?? '',
    to: edge?.to ?? '',
  });
  const [connection, setConnection] = useState(currentConnection);
  const connectionStale = connection.base !== stamp || connection.target !== id;
  useEffect(() => {
    if (
      !connection.dirty &&
      (connectionStale ||
        (connection.type !== '' && !Object.hasOwn(profile.edges, connection.type)))
    )
      setConnection(currentConnection());
  }, [stamp, id, profile, edge, connection, connectionStale]);
  const editConnection = (patch: GraphConnectionPatch) =>
    setConnection((old) => ({ ...(old.dirty ? old : currentConnection()), ...patch, dirty: true }));
  const resetConnection = () => setConnection(currentConnection());
  return { connection, setConnection, connectionStale, editConnection, resetConnection };
}

export function prepareGraphConnection({
  readOnly,
  connection,
  stamp,
  id,
  graph,
  profile,
  edgeId,
}: {
  readOnly: boolean;
  connection: GraphConnectionInput;
  stamp: string;
  id: string;
  graph: GraphDocument;
  profile: GraphProfile;
  edgeId?: (from: string, type: string) => string;
}): GraphIntent {
  const { from, to, type: edgeType } = connection;
  if (readOnly) throw new Error('このHostではGraphを編集できません。');
  if (connection.base !== stamp || connection.target !== id)
    throw new Error('Stale connection input; reload current values before editing.');
  if (!from || !to || !edgeType)
    throw new Error('接続の種類と両端を選択するか、接続入力をキャンセルしてください。');
  const existing = graph.edges.find((edge) => edge.id === connection.target);
  if ((existing ? profile.edges[existing.type] : profile.edges[edgeType])?.readOnly)
    throw new Error('この接続の定義は編集できません。');
  const intent: GraphIntent = existing
    ? { type: 'reconnect-edge', id: existing.id, from, to }
    : {
        type: 'add-edge',
        edge: {
          id: edgeId?.(from, edgeType) ?? newId('edge'),
          type: edgeType,
          from,
          to,
          attributes: {},
        },
      };
  return intent;
}

export function submitGraphConnection({
  prepare,
  apply,
  connection,
  setConnection,
  setError,
}: {
  prepare: () => GraphIntent;
  apply: GraphApply;
  connection: GraphConnectionInput;
  setConnection: (connection: GraphConnectionInput) => void;
  setError: (message: string) => void;
}) {
  try {
    const intent = prepare();
    if (apply([intent], connection.base)) setConnection({ ...connection, dirty: false });
  } catch (error) {
    setError(errorMessage(error));
  }
}
