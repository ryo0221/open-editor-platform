// The Playground's record handling per kind (kinds/record-kind.ts), paired with the same
// definitions as the registry. No React, so app/records.ts and app/import-artifact.ts use it.
import { engineeringDefinitions } from './engineering';
import { engineeringRecords } from './engineering/records';
import { officeDefinitions } from './office';
import { officeRecords } from './office/records';
import { pairKinds } from './pair-kinds';
import { ordinaryRecordHooks, type RecordKindEntry } from './record-kind';

const records = pairKinds(
  [...officeDefinitions, ...engineeringDefinitions],
  [...officeRecords, ...engineeringRecords],
  'Record handling',
);

/** How records of a stored kind are kept; a kind this Host does not know is handled ordinarily. */
export function recordHooks(kind: string): RecordKindEntry['hooks'] {
  return records.get(kind)?.hooks ?? ordinaryRecordHooks;
}
