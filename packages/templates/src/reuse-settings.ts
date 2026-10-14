import { ownReuseOptions } from './reuse-owned';
import { evaluate } from '@editor-platform/collaboration-core';
import { rejectReuse } from '@editor-platform/reuse-core';
import { prepareComponentProperties, retainedComponent } from './reuse-apply';
import { previewComponentUpdate } from './reuse-update';
import { prepareNativeApplication, templateCodec } from './apply';
import type { Domain } from './types';

/** One reviewed transaction for the Inspector's typed values, variant and explicit mode. */
export async function prepareComponentSettings(
  options: Parameters<typeof prepareComponentProperties>[0] & { mode?: string | null },
) {
  options = ownReuseOptions(options);
  const retained = retainedComponent(options.state.content, options.instanceId);
  if (options.mode === undefined || (options.mode ?? undefined) === retained.instance.mode)
    return prepareComponentProperties(options);
  const diff = await previewComponentUpdate({
    state: options.state,
    identity: options.identity,
    definition: retained.definition,
    closure: retained.closure,
    selections: [{ instanceId: options.instanceId, choice: 'adopt', mode: options.mode }],
  });
  if (!diff.prepared || diff.conflicts.length)
    rejectReuse(
      'mode-conflict',
      diff.conflicts.map((c) => c.message).join('\n') || 'Mode change requires a new preview',
    );
  const interim = evaluate(
    templateCodec(options.state.domain as Domain),
    options.state,
    diff.prepared.operation.actions,
    options.identity.actorId,
  ).state;
  const properties = await prepareComponentProperties({ ...options, state: interim });
  return prepareNativeApplication({
    state: options.state,
    identity: options.identity,
    id: options.requestId ?? crypto.randomUUID(),
    summary: `${retained.definition.name} の入力・表示・モードを変更`,
    definition: properties.definition,
    actions: [...diff.prepared.operation.actions, ...properties.operation.actions],
    reads: [
      ...new Set(
        [...diff.prepared.operation.conditions, ...properties.operation.conditions].map(
          (c) => c.key,
        ),
      ),
    ],
    notices: [...diff.prepared.notices, ...properties.notices],
  });
}
