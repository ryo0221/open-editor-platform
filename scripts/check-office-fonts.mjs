import process from 'node:process';
import { resolve } from 'node:path';
import { verifyOfficeFonts } from './office-fonts.mjs';

try {
  if (process.argv.length > 3)
    throw Error('Usage: node scripts/check-office-fonts.mjs [font-directory]');
  await verifyOfficeFonts(process.argv[2] ? resolve(process.argv[2]) : undefined);
  process.stdout.write('Fixed Office fonts: all four SHA-256 checks passed.\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
