import { retainedBytes, type CadAssembly, type CadController } from '../src';

/** One part job, from the assembly port's request to the kernel's result (ms since navigation). */
export interface PerfJob {
  hash: string;
  startMs: number;
  endMs: number;
  status: string;
}
/** Main-thread mesh bytes: the largest seen, and how often the budget was passed. */
export interface PerfMain {
  maxBytes: number;
  over: number;
  samples: number;
}

/**
 * ?perf=1 (docs/verification/cad-r2b-performance/protocol.md, R2b-U8): records each part job's
 * time and the part and editor mesh bytes as meshes arrive and as the view draws, on
 * window.cadPerf. It only wraps the Host's port and mesh callback; the Surface is unchanged.
 */
export function cadPerf(budgetBytes: number) {
  const jobs: PerfJob[] = [];
  let main: PerfMain = { maxBytes: 0, over: 0, samples: 0 };
  let attached: { controller: CadController; assembly: CadAssembly } | undefined;
  /** Part meshes the assembly keeps (standard and coarse), and the editor's own. */
  const held = () => {
    if (!attached) return { parts: 0, own: 0 };
    const { controller, assembly } = attached;
    // The stores are private to CadAssembly; the measurement reads them without changing them.
    const stores = [assembly['meshStore'], assembly['coarseStore']];
    return {
      parts: retainedBytes(stores.flatMap((s) => [...s.values()].flat())),
      own: controller.retainedMeshBytes,
    };
  };
  const sample = (extra = 0) => {
    const { parts, own } = held();
    const bytes = parts + own + extra;
    main.samples++;
    main.maxBytes = Math.max(main.maxBytes, bytes);
    if (bytes > budgetBytes) main.over++;
  };
  const api = {
    jobs,
    attach(controller: CadController, assembly: CadAssembly) {
      attached = { controller, assembly };
    },
    /** Wraps the kernel port the assembly port sends part jobs to. */
    timed<T extends object>(port: T): T {
      return new Proxy(port, {
        get(target, key) {
          const value = Reflect.get(target, key, target) as unknown;
          if (typeof value !== 'function') return value;
          if (key !== 'evaluatePart') return value.bind(target);
          return async (request: { baseHash: string }, ...rest: unknown[]) => {
            const startMs = performance.now();
            try {
              const result = (await value.call(target, request, ...rest)) as { status: string };
              jobs.push({
                hash: request.baseHash,
                startMs,
                endMs: performance.now(),
                status: result.status,
              });
              return result;
            } catch (error) {
              jobs.push({
                hash: request.baseHash,
                startMs,
                endMs: performance.now(),
                status: 'thrown',
              });
              throw error;
            }
          };
        },
      });
    },
    /** Before meshes are taken: what is held plus the arriving buffers (the budget counts them). */
    arriving(meshes: Parameters<typeof retainedBytes>[0]) {
      sample(retainedBytes(meshes));
    },
    /** After meshes are taken, and on each draw (the harness calls it from the WebGL clear). */
    sample: () => sample(),
    /** The bytes now, the largest seen since the last reset, and the simplified versions. */
    read() {
      const now = held();
      return {
        ...main,
        partsBytes: now.parts,
        ownBytes: now.own,
        simplified: attached?.assembly.getSnapshot().simplified.size ?? 0,
      };
    },
    reset() {
      main = { maxBytes: 0, over: 0, samples: 0 };
      sample();
    },
  };
  return api;
}
