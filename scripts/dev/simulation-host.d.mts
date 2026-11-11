import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
export function calculixBuild(command?: string): string | null;
export function createSimulationJobs(options: {
  toInp(value: unknown): Promise<{ inp: string }>;
  command?: string;
  limits: { bytes: number };
  timeoutMs?: number;
  maxJobs?: number;
  keepMs?: number;
  resultBytes?: number;
}): {
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void>;
  close(): Promise<void>;
};
export function simulationReferenceHost(options?: { command?: string; enabled?: boolean }): Plugin;
