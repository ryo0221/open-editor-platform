import { clone } from '@editor-platform/artifact-core';
import type { Identity, Snapshot } from '@editor-platform/collaboration-core';
import { rejectReuse, type LockedClosure } from '@editor-platform/reuse-core';
import type { PreparedApplication } from './apply';
import type { ComponentDefinition } from './reuse-definition';
import { retainedComponent } from './reuse-apply';
import {
  previewComponentUpdate,
  type ComponentUpdatePreview,
  type ComponentUpdateSelection,
} from './reuse-update';
import type { NativeContent } from './types';

export interface ComponentBatchTarget {
  name: string;
  state: Snapshot<NativeContent>;
  identity: Identity;
  selections: ComponentUpdateSelection[];
}
export interface ComponentBatchResult {
  artifactId: string;
  name: string;
  status: 'prepared' | 'unchanged' | 'conflict' | 'failed' | 'applied';
  changes: ComponentUpdatePreview['changes'];
  prepared?: PreparedApplication;
  error?: string;
}
export interface PreparedComponentBatch {
  requestId: string;
  results: ComponentBatchResult[];
}

/** One reviewed native operation per artifact; no distributed transaction or history. */
export async function prepareComponentBatch(options: {
  requestId: string;
  definition: ComponentDefinition;
  closure: LockedClosure<unknown>;
  targets: ComponentBatchTarget[];
}): Promise<PreparedComponentBatch> {
  options = clone(options);
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(options.requestId) ||
    !options.targets.length ||
    options.targets.length > 100 ||
    new Set(options.targets.map((t) => t.state.artifactId)).size !== options.targets.length
  )
    rejectReuse('batch-target', 'Choose 1–100 unique artifacts and a stable request ID');
  const results: ComponentBatchResult[] = [];
  for (const [index, target] of options.targets.entries()) {
    const result: ComponentBatchResult = {
      artifactId: target.state.artifactId,
      name: target.name,
      status: 'failed',
      changes: [],
    };
    try {
      const preview = await previewComponentUpdate({
        ...target,
        selections: target.selections.map((selection) =>
          selection.choice === 'adopt' &&
          Object.keys(selection).every((key) => ['instanceId', 'choice'].includes(key)) &&
          retainedComponent(target.state.content, selection.instanceId).instance.ref.hash ===
            options.definition.hash
            ? { ...selection, choice: 'pin' }
            : selection,
        ),
        definition: options.definition,
        closure: options.closure,
        requestId: `${options.requestId}_${index}`,
      });
      Object.assign(result, {
        changes: preview.changes,
        ...(preview.prepared ? { prepared: preview.prepared } : {}),
        status: preview.conflicts.length ? 'conflict' : preview.prepared ? 'prepared' : 'unchanged',
      });
    } catch (error) {
      result.error = (error as Error).message;
    }
    results.push(result);
  }
  return { requestId: options.requestId, results };
}

/** The Host submits through its existing per-artifact authority/local session.
 * The callback must deduplicate the prepared request, including lost responses.
 * A retry reuses the same operation and skips known successes. A stale failure
 * stays failed until separately re-prepared; it never silently changes the preview. */
export async function applyComponentBatch(
  batch: PreparedComponentBatch,
  apply: (prepared: PreparedApplication) => Promise<void>,
  onResult?: (result: ComponentBatchResult) => void,
): Promise<PreparedComponentBatch> {
  const results: ComponentBatchResult[] = [];
  for (const previous of batch.results) {
    const result = { ...previous };
    if (result.prepared && ['prepared', 'failed'].includes(result.status)) {
      try {
        await apply(result.prepared);
        result.status = 'applied';
        delete result.error;
      } catch (error) {
        result.status = 'failed';
        result.error = (error as Error).message;
      }
    }
    results.push(result);
    onResult?.(result);
  }
  return { requestId: batch.requestId, results };
}
