import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkCrashJob, crashResultJson, runCrashJob } from './crash-job';
import { ExplicitError } from './explicit';

/**
 * VS8a: the reference Host's crash run in its own Node process (bundled by the Host, never part of
 * the browser's build): reads `job.json` in the folder given, checks it again, runs it, prints
 * `progress <time> <endTime>` lines (s) and writes `result.json`. A refusal prints `error <text>`
 * and exits 1. The Host kills the process to cancel it.
 */
const dir = process.argv[2];
if (!dir) {
  process.stdout.write('error no job folder\n');
  process.exit(1);
}
try {
  const job = checkCrashJob(JSON.parse(readFileSync(path.join(dir, 'job.json'), 'utf8')));
  let last = 0;
  const result = runCrashJob(job, (time, endTime) => {
    const now = Date.now();
    if (now - last < 250 && time < endTime) return;
    last = now;
    process.stdout.write(`progress ${time} ${endTime}\n`);
  });
  writeFileSync(path.join(dir, 'result.json'), crashResultJson(result));
  process.stdout.write('done\n');
} catch (e) {
  const text =
    e instanceof ExplicitError ? `${e.problem}: ${e.detail}` : String((e as Error)?.message ?? e);
  process.stdout.write(`error ${text.replace(/\s+/g, ' ').slice(0, 500)}\n`);
  process.exit(1);
}
