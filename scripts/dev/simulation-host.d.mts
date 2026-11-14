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
  /** VS3b: wind-tunnel jobs (`kind: 'aero'`); without it they are refused. */
  aero?: AeroRunner;
}): {
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void>;
  close(): Promise<void>;
};
export interface AeroRunner {
  bashrc: string;
  prepare(value: never): Promise<{
    files: Record<string, string>;
    commands: { program: string; args: string[] }[];
    timeoutMs?: number;
    [meta: string]: unknown;
  }>;
  read(dir: string, meta: never): Promise<unknown>;
}
export function openFoamBuild(bashrc?: string): string | null;
export function referenceAero(
  load: (module: string) => Promise<unknown>,
  bashrc: string,
): AeroRunner;
export function simulationReferenceHost(options?: {
  command?: string;
  enabled?: boolean;
  openFoamBashrc?: string;
}): Plugin;
