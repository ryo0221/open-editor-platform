// Shared only with the hash-pinned local AAC patch. One encoder job per realm.
let current;
export function beginEncoding(count) {
  if (current) throw Error('Encoder realm busy');
  current = { validEnd: count, rawPackets: [], encoders: new Set() };
  return current;
}
export function encodingState() {
  if (!current) throw Error('No encoder job');
  return current;
}
export function endEncoding(owner) {
  if (current === owner) current = undefined;
}

/** Bypass a rejected library serializer to definitively terminate any retained worker. */
export function closeOwnedEncoders(owner) {
  for (const encoder of owner.encoders) encoder.close();
  if (owner.encoders.size) throw Error('Encoder ownership did not release');
}
