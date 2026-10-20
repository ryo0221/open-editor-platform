import { requireAnimation as check } from './model';

const plainAscii = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;
/** Internal copy budget; injected small limits are for functional boundary tests only. */
export class JsonBudget {
  constructor(
    public bytesRemaining = 32 * 1024 * 1024,
    public nodesRemaining = 500000,
  ) {}
  bytes(count: number): void {
    check(count <= this.bytesRemaining, 'byte-limit', 'json-copy');
    this.bytesRemaining -= count;
  }
  node(): void {
    check(this.nodesRemaining > 0, 'input-limit', 'json-copy');
    this.nodesRemaining--;
  }
  /** Exact UTF-8 JSON string cost, including escapes, without serializing the input. */
  string(value: string): void {
    // Printable ASCII without quotes/backslashes (IDs, base64, most names) costs one
    // byte per character; the native scan avoids a per-character loop on assets.
    if (plainAscii.test(value)) return this.bytes(value.length + 2);
    let cost = 2;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) cost += 2;
      else if (c < 32) cost += 6;
      else if (c < 128) cost += 1;
      else if (c < 2048) cost += 2;
      else if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < value.length &&
        value.charCodeAt(i + 1) >= 0xdc00 &&
        value.charCodeAt(i + 1) <= 0xdfff
      ) {
        cost += 4;
        i++;
      } else if (c >= 0xd800 && c <= 0xdfff) cost += 6;
      else cost += 3;
    }
    // Costs are positive, so one aggregate check rejects exactly the inputs the
    // per-character checks rejected.
    this.bytes(cost);
  }
}
