import type { FictionMapCode, FictionMapDiagnostic, FictionMapResult } from './types';

export class FictionMapFailure extends Error {
  constructor(readonly diagnostic: FictionMapDiagnostic) {
    super(diagnostic.code);
  }
}
export function fail(
  code: FictionMapCode,
  path = '',
  detail: Omit<Partial<FictionMapDiagnostic>, 'code' | 'path'> = {},
): never {
  throw new FictionMapFailure({ source: 'input', ...detail, code, path });
}
export function attempt<T>(
  source: FictionMapDiagnostic['source'],
  run: () => T,
): FictionMapResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (!(error instanceof FictionMapFailure)) throw error;
    return {
      ok: false,
      diagnostic: {
        ...error.diagnostic,
        source: error.diagnostic.source === 'input' ? source : error.diagnostic.source,
      },
    };
  }
}
export function unwrap<T>(result: FictionMapResult<T>): T {
  if (!result.ok) throw new FictionMapFailure(result.diagnostic);
  return result.value;
}
export const pointer = (parent: string, key: string | number) =>
  parent + '/' + String(key).replaceAll('~', '~0').replaceAll('/', '~1');
