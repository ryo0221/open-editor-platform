import type { Buffer } from 'node:buffer';
export function elements(bytes: Uint8Array): { id: number; data: Buffer }[];
export function integer(value: bigint, signed?: boolean): Buffer;
export function encode(elements: { id: number; data: Uint8Array }[]): Buffer;
