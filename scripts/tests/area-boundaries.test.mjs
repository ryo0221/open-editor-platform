import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { areaCrossings, checkBoundaries, officeKindImports } from '../check-area-boundaries.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('the repository has no area crossings beyond the known list', () => {
  assert.deepEqual(checkBoundaries(root), { unexpected: [], resolved: [] });
});

test('a crossing is reported, and a resolved known crossing too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'area-boundaries-'));
  const manifest = (name, dependencies) => {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    writeFileSync(
      join(dir, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@editor-platform/${name}`, dependencies }),
    );
  };
  manifest('document', { '@editor-platform/cad-core': '*', '@editor-platform/editor-core': '*' });
  manifest('editor-core', {});
  manifest('cad-core', { '@editor-platform/editor-core': '*' });
  assert.deepEqual(
    areaCrossings(dir).map((entry) => entry.edge),
    ['document -> cad-core'],
  );
  const result = checkBoundaries(dir, ['cad-core -> slide']);
  assert.deepEqual(
    result.unexpected.map((entry) => entry.edge),
    ['document -> cad-core'],
  );
  assert.deepEqual(result.resolved, ['cad-core -> slide']);
});

test('office kinds import no engineering code', () => {
  assert.deepEqual(officeKindImports(root), []);
});

test('an office kind importing engineering code is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-kinds-'));
  const file = (path, text) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  file(
    'apps/host/src/kinds/office.ts',
    "import { documentKind } from '@editor-platform/document/kind';\n" +
      "import { cadKind } from '@editor-platform/cad/kind';\n",
  );
  file(
    'apps/host/src/kinds/office/estimate.tsx',
    [
      "import type { CadDocument } from '@editor-platform/cad-core';",
      "import { storage } from '../../app/records';",
      "import { playgroundEstimateGeometry } from '../../app/estimate-bim';",
      "import { cadDefinition } from '../engineering';",
      "import { cadSurface } from '../engineering/cad';",
      "const CadHost = import('../../cad/host');",
      "import { GeoSurface } from '../../geo/surface';",
      "const BimView = import('../../bim');",
      "import { ArtifactEstimate } from '../../estimate';",
      "export { x } from '@editor-platform/bim';",
    ].join('\n'),
  );
  file('apps/host/src/kinds/engineering/cad.tsx', "import '@editor-platform/cad';\n");
  assert.deepEqual(officeKindImports(dir), [
    'apps/host/src/kinds/office.ts -> @editor-platform/cad/kind',
    'apps/host/src/kinds/office/estimate.tsx -> @editor-platform/cad-core',
    'apps/host/src/kinds/office/estimate.tsx -> ../../app/estimate-bim',
    'apps/host/src/kinds/office/estimate.tsx -> ../engineering',
    'apps/host/src/kinds/office/estimate.tsx -> ../engineering/cad',
    'apps/host/src/kinds/office/estimate.tsx -> ../../cad/host',
    'apps/host/src/kinds/office/estimate.tsx -> ../../bim',
    'apps/host/src/kinds/office/estimate.tsx -> @editor-platform/bim',
  ]);
});
