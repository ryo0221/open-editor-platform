import { canonicalJson } from '@editor-platform/artifact-core';
import { requireAnimation as check } from '../model';

/** Only called on owned JSON or a native snapshot obtained from a prepared token.
 * Replacing a null placeholder must retain the complete owning-JSON limits. */
export function embedJsonSize(value: unknown) {
  let nodes = 0,
    chars = 0,
    depth = 0;
  const visit = (v: unknown, level: number) => {
    nodes++;
    depth = Math.max(depth, level);
    if (typeof v === 'string') chars += v.length;
    else if (v && typeof v === 'object')
      for (const child of Object.values(v)) visit(child, level + 1);
  };
  visit(value, 0);
  return { nodes, chars, depth, bytes: new TextEncoder().encode(canonicalJson(value)).byteLength };
}
export function checkEmbedJsonSize(
  wrapper: ReturnType<typeof embedJsonSize>,
  snapshot: ReturnType<typeof embedJsonSize>,
) {
  check(wrapper.bytes - 4 + snapshot.bytes <= 32 * 1024 * 1024, 'byte-limit', 'json-copy');
  check(
    wrapper.nodes - 1 + snapshot.nodes <= 500000 &&
      wrapper.chars + snapshot.chars <= 8000000 &&
      Math.max(wrapper.depth, snapshot.depth + 1) <= 64,
    'input-limit',
    '$',
  );
}
