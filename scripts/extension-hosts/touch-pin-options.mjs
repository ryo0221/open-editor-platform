import assert from 'node:assert/strict';

const defaultPin = '082c698740cf30f78ec4f9a293e663633ba86f0a';
const defaultProvenance = '8ec2cef23877ac8e3810984fed598b2a0a2fa1b224501addf88926257cc10e66';

// Trust only the historical pair or an explicitly supplied pair, never kit contents.
// Keep each caller's existing three positional path arguments in their original order.
export function parseTouchPinOptions(argv, modes = []) {
  assert(argv.length >= 3, 'Expected three positional paths before options');
  const paths = argv.slice(0, 3);
  assert(
    paths.every((value) => value && !value.startsWith('--')),
    'Expected three positional paths before options',
  );
  let pin, provenance, mode;
  for (let i = 3; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--expected-pin' || flag === '--expected-provenance') {
      const value = argv[++i];
      if (flag === '--expected-pin') {
        assert(pin === undefined, 'Duplicate --expected-pin');
        assert(
          typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value),
          '--expected-pin requires a full 40-digit hex SHA',
        );
        pin = value.toLowerCase();
      } else {
        assert(provenance === undefined, 'Duplicate --expected-provenance');
        assert(
          typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value),
          '--expected-provenance requires a 64-digit hex SHA256',
        );
        provenance = value.toLowerCase();
      }
    } else {
      assert(modes.includes(flag), `Unknown option: ${flag}`);
      assert(mode === undefined, 'Only one touch mode may be selected');
      mode = flag;
    }
  }
  assert(
    (pin === undefined) === (provenance === undefined),
    'Supply --expected-pin and --expected-provenance together',
  );
  return {
    paths,
    expectedPin: pin ?? defaultPin,
    expectedProvenance: provenance ?? defaultProvenance,
    mode,
  };
}
