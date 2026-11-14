export interface OpenFoamStep {
  program: string;
  args: string[];
}

export function runOpenFoamCase(options: {
  dir: string;
  files: Record<string, string>;
  commands: OpenFoamStep[];
  bashrc?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onPhase?: (program: string) => void;
}): Promise<{ logs: Record<string, string>; elapsedMs: number }>;

export function readAeroOutputs(
  dir: string,
): Promise<{ coefficients: string; pressure: string; shear: string }>;
