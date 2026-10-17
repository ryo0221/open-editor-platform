import { requireAnimation as check } from './model';

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
    this.bytes(2);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) this.bytes(2);
      else if (c < 32) this.bytes(6);
      else if (c < 128) this.bytes(1);
      else if (c < 2048) this.bytes(2);
      else if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < value.length &&
        value.charCodeAt(i + 1) >= 0xdc00 &&
        value.charCodeAt(i + 1) <= 0xdfff
      ) {
        this.bytes(4);
        i++;
      } else if (c >= 0xd800 && c <= 0xdfff) this.bytes(6);
      else this.bytes(3);
    }
  }
}
