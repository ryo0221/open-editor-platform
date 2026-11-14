import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

// VS3 (docs/cad/vehicle-simulation.md): runs an OpenFOAM wind-tunnel case that `aeroCase`
// (packages/geometry-cfd/src/openfoam.ts) wrote from a checked job, in an empty folder, with the
// fixed steps `aeroCommands` gives. Each step is a program and its arguments passed to `exec` as
// they are (never through a shell string); the OpenFOAM environment comes from a shell file
// (`bashrc`: OpenFOAM's etc/bashrc, or a file that activates a conda-forge OpenFOAM — that one's
// own etc/bashrc puts /lib on the library path and can load another OpenFOAM's libraries).
// Used by the reference Host and by the opt-in test against a real OpenFOAM.

/** `bash -c 'source <bashrc>; exec "$@"'`: the step's words reach the program unchanged. */
const wrapped = (bashrc, program, args) => ({
  command: 'bash',
  args: ['-c', 'source "$0" >/dev/null 2>&1; exec "$@"', bashrc, program, ...args],
});

/**
 * Writes `files` (path → text, relative paths without `..`) into `dir` and runs `commands` in
 * order. Resolves with the tail of each log; rejects on the first step that fails, on the time
 * limit or when `signal` aborts (the running step is killed).
 */
export async function runOpenFoamCase({
  dir,
  files,
  commands,
  bashrc = '/usr/share/openfoam/etc/bashrc',
  timeoutMs,
  signal,
  onPhase,
}) {
  for (const [rel, text] of Object.entries(files)) {
    if (signal?.aborted) throw new Error('cancelled');
    const target = path.resolve(dir, rel);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`bad path ${rel}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const started = Date.now();
  const logs = {};
  for (const step of commands) {
    if (signal?.aborted) throw new Error('cancelled');
    onPhase?.(step.program);
    // The observer may cancel; an abort is not replayed to a listener added later.
    if (signal?.aborted) throw new Error('cancelled');
    const { command, args: argv } = wrapped(bashrc, step.program, step.args);
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) throw new Error('timeout');
    const out = await new Promise((resolve) => {
      const child = spawn(command, argv, {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME ?? dir,
          OMP_NUM_THREADS: '1',
          // Open MPI refuses root unless told (the reference Host may run as root in a
          // container); MPICH ignores these.
          OMPI_ALLOW_RUN_AS_ROOT: '1',
          OMPI_ALLOW_RUN_AS_ROOT_CONFIRM: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a timeout or a cancel stops the whole step (mpirun and the
        // solvers it started), not only the shell.
        detached: true,
      });
      let tail = '';
      const keep = (c) => (tail = (tail + c.toString('utf8')).slice(-6000));
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const kill = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => {
        tail += '\ntimeout';
        kill();
      }, left);
      signal?.addEventListener('abort', kill, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, tail: String(e) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        resolve({ code, tail });
      });
    });
    logs[step.program] = out.tail;
    const fatal = /FOAM FATAL (IO )?ERROR[\s\S]{0,600}/.exec(out.tail)?.[0];
    if (out.code !== 0 || fatal) {
      if (signal?.aborted) throw new Error('cancelled');
      throw new Error(
        `${step.program} failed${fatal ? `: ${fatal.replace(/\s+/g, ' ').trim()}` : ` (exit ${out.code})`}`.slice(
          0,
          600,
        ),
      );
    }
  }
  return { logs, elapsedMs: Date.now() - started };
}

/** The force coefficients' file and the body's pressure sample under `postProcessing/`. */
export async function readAeroOutputs(dir) {
  const find = async (root, test) => {
    const out = [];
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (test(p)) out.push(p);
      }
    };
    await walk(root);
    return out.sort();
  };
  const post = path.join(dir, 'postProcessing');
  const coeffs = await find(path.join(post, 'forceCoeffs'), (p) => /coefficient\.dat$/.test(p));
  const pressure = await find(path.join(post, 'bodyPressure'), (p) => /[/\\]p_body\.raw$/.test(p));
  const shear = await find(path.join(post, 'bodyPressure'), (p) =>
    /[/\\]wallShearStress_body\.raw$/.test(p),
  );
  if (coeffs.length === 0) throw new Error('no force coefficients were written');
  const text = async (files) => (files.length ? await readFile(files.at(-1), 'utf8') : '');
  return {
    coefficients: await text(coeffs),
    pressure: await text(pressure),
    shear: await text(shear),
  };
}
