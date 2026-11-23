import {
  ReferenceError,
  svgReferenceProjection,
  type ReferenceAdapter,
} from '@editor-platform/artifact-references';
import {
  exportMindmapSvg,
  mindmapProblem,
  type MindmapContent,
} from '@editor-platform/mindmap-core';

/**
 * A saved Mind Map as a picture: the whole map (`mindmap` / `map`) or one branch with its
 * descendants (`mindmap-branch`, `nodeIds` [the branch id]). Folds are the saved ones.
 */
export const mindmapReferenceAdapter: ReferenceAdapter = {
  domain: 'mindmap',
  modes: ['fixed'],
  validate(snapshot) {
    const problem = mindmapProblem(snapshot.content);
    if (problem) throw new ReferenceError('error', `Mind Mapの保存版が不正です（${problem}）。`);
    if (snapshot.dependencies.length)
      throw new ReferenceError('error', 'Mind Map has no dependencies');
  },
  project(snapshot, target) {
    const content = snapshot.content as MindmapContent;
    if (target.columnIds || target.rowIds || target.featureIds)
      throw new ReferenceError('unsupported', 'Mind Map targets use nodeIds only');
    if (target.kind === 'mindmap' && target.viewId === 'map' && !target.nodeIds)
      return svgReferenceProjection(exportMindmapSvg(content), 'Saved Mind Map');
    if (target.kind === 'mindmap-branch' && target.nodeIds?.length === 1) {
      const id = target.nodeIds[0];
      if (!Object.hasOwn(content.nodes, id))
        throw new ReferenceError('missing-target', '引用した枝が保存版にありません。');
      return svgReferenceProjection(
        exportMindmapSvg(content, { nodeId: id }),
        content.nodes[id].text || 'Mind Map branch',
      );
    }
    throw new ReferenceError('unsupported', 'Use the whole map or one branch of a Mind Map');
  },
};
