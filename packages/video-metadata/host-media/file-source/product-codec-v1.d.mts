import type { CodecV1 } from './host-v1';
export const productCodecV1: CodecV1 & { provenance(bytes: Blob): unknown };
