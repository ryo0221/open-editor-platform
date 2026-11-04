# Private planar predicate oracle (R1-a)

`planar-oracle.json` is reviewed test source, not a runtime dependency or a ring-validity certificate. The independent public planar entrypoint wraps these internals; its ring contract is tested separately in `src/planar.test.ts`. The 96 cases cover orientation, a point against a closed segment, closed segment relations, and algebraic area sign. Each coordinate is its exact 16-digit binary64 bit pattern, including signed zero and subnormal values.

The oracle uses Python `Fraction.from_float` and rational line parameters/dot products. It neither imports the TypeScript implementation nor copies its binary-to-BigInt decomposition. The 32 named examples include hand-checkable contact/overlap/point segments, rounded-product cancellation, underflow, overflow, mixed extremes and lost increments at a large origin. Another 64 finite-bit cases use seed `0x596a`. Expected values describe represented inputs, not intended values before rounding. An algebraic area of zero does not prove that a ring is degenerate: the bow-tie example is not a validated ring.

Generation is explicitly pinned to **CPython 3.12.14**, standard library only. From the repository root:

```sh
python3 packages/geometry-core/test-fixtures/generate-planar-oracle.py --write
npx prettier --write packages/geometry-core/test-fixtures/planar-oracle.json
python3 packages/geometry-core/test-fixtures/generate-planar-oracle.py --check
npm test -- packages/geometry-core/src/planar/predicates.test.ts
```

`--check` compares parsed JSON so Prettier whitespace is allowed. Case order, bit patterns, expectations, generator SHA-256, Python version and seed must still match. When the generator or pin changes, regenerate explicitly and review the golden diff. The Node tests verify the generator's source hash and consume the committed JSON; ordinary `npm test` never invokes Python. No new npm dependency is required.

The tests also exercise every finite exponent field with power-of-two triangles, exact representable scale/translation, endpoint reversal, segment exchange, ring cyclic shift/reversal (area only), snapshots, malformed/nonfinite input and getters that must not execute. These are functional checks, not benchmarks or a claim of exhaustive enumeration of all binary64 point combinations. No time/memory budget or Editor responsiveness is certified here.

## Exactness invariant

For normal finite inputs, the bit fields encode `(-1)^sign × (2^52 + fraction) × 2^(biasedExponent-1075)`; for subnormals they encode `(-1)^sign × fraction × 2^-1074`. Removing factors of two from the integer significand is exact. Choosing the minimum resulting exponent across all nonzero coordinates makes every shift nonnegative. Zero needs no exponent and both signed zeros become integer zero.

The decoded integers therefore represent all input coordinates at one common positive scale. Orientation determinants and shoelace sums differ from the represented rational values only by the positive factor `2^(2E)`, so their signs agree. Coordinate subtraction and multiplication occur in BigInt, not in binary64. The `number` arithmetic on exponent fields is bounded integer arithmetic. Mixed MIN_VALUE/MAX_VALUE inputs can still require 2098-bit coordinates before differences; common scaling is not a worst-case response-time solution. BigInt avoids fixed-width numeric overflow, but memory exhaustion and arbitrary external Proxy behavior are outside this data contract.

This explains the numeric range; golden/property checks supply regression evidence rather than enumerating every possible input. No public ring vertex budget, map capacity, Canvas range or UI guarantee follows from it.
