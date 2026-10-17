import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
export async function assertOutsideCheckout(repo, output) {
  const checkout = await realpath(repo),
    target = path.resolve(output),
    parent = path.dirname(target);
  const resolved = await realpath(parent);
  assert.equal(resolved, parent, 'symlink output parent is not admitted');
  const relative = path.relative(checkout, resolved);
  assert.ok(
    relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
    'output parent must be outside checkout',
  );
  return target;
}
