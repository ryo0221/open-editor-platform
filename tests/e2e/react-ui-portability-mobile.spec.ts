import { test } from './fixtures';
import { portabilityFlow } from './react-ui-portability-flow';
test('mobile Library/Inspector empty-slot edit, Undo, save/reload and deterministic formatted ZIP', async ({
  page,
}, info) => portabilityFlow(page, info));
