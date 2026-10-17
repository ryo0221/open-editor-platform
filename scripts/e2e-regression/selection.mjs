import assert from 'node:assert/strict';

// Membership is the launch cohort, not the mutable progress state of each case.
export function selectRegressionCases(ledger, lane) {
  const ids = ledger.regressionTargetIds;
  assert(Array.isArray(ids) && ids.length === 33, 'Expected 33 immutable regression target IDs');
  assert(
    ids.every((id) => typeof id === 'string' && id.length > 0),
    'Invalid regression target ID',
  );
  assert.equal(new Set(ids).size, ids.length, 'Duplicate regression target ID');
  assert(Array.isArray(ledger.cases), 'Missing ledger cases');
  const casesById = new Map();
  for (const entry of ledger.cases) {
    assert(!casesById.has(entry.id), `Duplicate ledger case ID: ${entry.id}`);
    casesById.set(entry.id, entry);
  }
  const targets = ids.map((id) => {
    assert(casesById.has(id), `Missing regression target case: ${id}`);
    return casesById.get(id);
  });
  const selected = targets.filter((entry) => lane === 'all' || entry.lane === lane);
  assert(selected.length, 'Unknown or empty lane');
  return selected;
}
