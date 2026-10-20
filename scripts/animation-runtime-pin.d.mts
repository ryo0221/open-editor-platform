import type { Plugin } from 'vite';
export function buildAnimationRuntimePin(
  overrides?: Record<string, string>,
): Promise<{ hash: string; inputs: string[] }>;
export function animationRuntimePin(): Plugin;
