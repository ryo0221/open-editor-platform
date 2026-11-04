/** Functional guard checks only. Run alone; temporarily changes and always restores source. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] && resolve(process.argv[2]);
if (
  !output ||
  !isAbsolute(output) ||
  !relative(root, output).startsWith('..') ||
  existsSync(output)
)
  throw Error('Pass a new output directory outside the checkout');
mkdirSync(output, { recursive: true });
const prefix = 'packages/fiction-map/src/';
const mutations = [
  {
    id: 'ring-limit',
    test: 'admission.test.ts',
    edits: [
      ['input.ts', 'max = 65;', 'max = 1001;'],
      ['admission.ts', "g.type === 'polygon' ? 65 :", "g.type === 'polygon' ? 1001 :"],
      ['geometry-validation.ts', 'maxVertices: 64', 'maxVertices: 1000'],
    ],
  },
  {
    id: 'canonical-utf8-limit',
    test: 'admission.test.ts',
    edits: [
      ['input.ts', 'if (bytes > budget.bytes)', 'if (false && bytes > budget.bytes)'],
      [
        'input.ts',
        'if (v.length + 2 > budget.bytes - bytes)',
        'if (false && v.length + 2 > budget.bytes - bytes)',
      ],
      [
        'input.ts',
        'if (key.length + 2 > budget.bytes - bytes)',
        'if (false && key.length + 2 > budget.bytes - bytes)',
      ],
      [
        'admission.ts',
        'if (bytes > limits.nativeBytes)',
        'if (false && bytes > limits.nativeBytes)',
      ],
    ],
  },
  {
    id: 'raw-utf8-limit',
    test: 'admission.test.ts',
    edits: [
      [
        'json.ts',
        'if (input.length > limits.inputBytes)',
        'if (false && input.length > limits.inputBytes)',
      ],
      ['json.ts', 'if (size > limits.inputBytes)', 'if (false && size > limits.inputBytes)'],
      [
        'json.ts',
        'if (input.byteLength > limits.inputBytes)',
        'if (false && input.byteLength > limits.inputBytes)',
      ],
    ],
  },
  {
    id: 'revision',
    test: 'commands.test.ts',
    edits: [
      [
        'commands.ts',
        'if (!sameLocalRevision(session.revision, state.revision))',
        'if (false && !sameLocalRevision(session.revision, state.revision))',
      ],
    ],
  },
  {
    id: 'canonical-base',
    test: 'commands.test.ts',
    edits: [
      [
        'commands.ts',
        'if (canonicalJson(current) !== state.canonicalBase)',
        'if (false && canonicalJson(current) !== state.canonicalBase)',
      ],
    ],
  },
  {
    id: 'permission',
    test: 'commands.test.ts',
    edits: [
      [
        'commands.ts',
        "if (!result) fail('permission-denied', '');",
        "if (false && !result) fail('permission-denied', '');",
      ],
    ],
  },
  {
    id: 'consumed',
    test: 'commands.test.ts',
    edits: [
      [
        'commands.ts',
        "if (state.consumed || state.active) fail('prepared-consumed', '/prepared');",
        "if (false) fail('prepared-consumed', '/prepared');",
      ],
      [
        'commands.ts',
        "if (state.consumed) fail('prepared-consumed', '/prepared');",
        "if (false) fail('prepared-consumed', '/prepared');",
      ],
    ],
  },
  {
    id: 'apply-final-check',
    test: 'commands.test.ts',
    edits: [
      [
        'commands.ts',
        '            finalCheck(state);',
        '            // mutation: final publication check removed',
      ],
    ],
  },
];
const originals = new Map();
for (const m of mutations)
  for (const [name] of m.edits) {
    const file = prefix + name;
    if (!originals.has(file)) originals.set(file, readFileSync(resolve(root, file)));
  }
const hash = (b) => createHash('sha256').update(b).digest('hex');
const hashes = () =>
  Object.fromEntries([...originals.keys()].map((p) => [p, hash(readFileSync(resolve(root, p)))]));
const before = hashes();
const restore = () => {
  for (const [p, b] of originals) writeFileSync(resolve(root, p), b);
};
const run = (files, log) => {
  try {
    const out = execFileSync('npm', ['test', '--', ...files.map((p) => prefix + p)], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    writeFileSync(log, out);
    return { exit: 0, text: out };
  } catch (error) {
    const out = String(error.stdout ?? '') + String(error.stderr ?? '');
    writeFileSync(log, out);
    return { exit: error.status ?? -1, text: out };
  }
};
const report = [];
try {
  for (const mutation of mutations) {
    restore();
    for (const [name, from, to] of mutation.edits) {
      const file = resolve(root, prefix + name),
        s = readFileSync(file, 'utf8');
      if (s.split(from).length !== 2) throw Error(`Mutation source moved: ${mutation.id}/${name}`);
      writeFileSync(file, s.replace(from, to));
    }
    const result = run([mutation.test], resolve(output, mutation.id + '.log'));
    const detected = result.exit !== 0 && /Tests\s+\d+ failed/u.test(result.text);
    report.push({ id: mutation.id, expected: 'FAIL', detected, exit: result.exit });
    process.stdout.write(JSON.stringify(report.at(-1)) + '\n');
    if (!detected) throw Error('Mutant survived or failed to run: ' + mutation.id);
  }
} finally {
  restore();
  const after = hashes();
  writeFileSync(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        before,
        after,
        restored: JSON.stringify(before) === JSON.stringify(after),
        mutations: report,
      },
      null,
      2,
    ) + '\n',
  );
}
const final = run(
  ['admission.test.ts', 'geometry.test.ts', 'commands.test.ts', 'diagnostics.test.ts'],
  resolve(output, 'restored-final.log'),
);
if (final.exit !== 0) throw Error('Restored source tests failed');
process.stdout.write('Original source restored; final integrated units PASS\n');
