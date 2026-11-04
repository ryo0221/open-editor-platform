# Exact numeric evidence

`numeric-oracle.json` contains 96 deterministic examples: 24 point-near, 24 segment-distance, 24 minimum-area and 24 ties-to-even snap cases. Inputs are finite represented binary64 values, including subnormals, signed zeros, negative coordinates, hard bounds and very large finite thresholds.

Regenerate with `python3 packages/fiction-map/test-fixtures/generate-numeric-oracle.py`. The standard-library Python `Fraction.from_float` oracle uses rational dot products/projection, area and banker rounding; it does not import the TypeScript implementation or reproduce its binary-to-integer conversion. Ordinary Vitest consumes the checked-in JSON and requires no Python. The generator is a correctness tool, not a performance workload.

B1-10a–i native-ring diagnostics are fixed in `src/admission.test.ts`, matching the existing public planar F04/F08/F10/F11/F05/F06 contract. D1-specific profile/hit/command tests do not change that shared library.

Run guard mutations alone with `node scripts/verify-fiction-map-mutations.mjs /tmp/fiction-map-mutations-new`. The output directory must be new and outside the checkout. The script temporarily disables native ring, canonical/raw UTF-8, revision, canonical base, permission, consumed and final apply checks one at a time; each corresponding unit must fail by assertion. It restores exact original source bytes in a finally block, records before/after hashes and reruns the integrated units. Do not edit or run other source consumers concurrently. Raw logs, reports and bundles are not committed.
