import type { Context } from '@editor-platform/extension-contract/draft2';
import type { ControlledSurfaceController } from '@editor-platform/extension-contract/controlled-surface';
import { createControlledExecution } from './controlled-execution';
export function createControlledSurfaceController<T, Ref>(
  context: Context<T, Ref>,
  options: { beforeMutation?(): void; onError(error: unknown): void },
): ControlledSurfaceController<T> {
  return createControlledExecution(context, options);
}
