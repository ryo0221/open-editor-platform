import { expect, it } from 'vitest';
import { validateReactPreviewBootstrap } from './index';
it('validates transport readiness separately from render attestation, retaining exact sender and strict plain data', () => {
  const source = {},
    origin = 'https://preview.example.test';
  const event = { source, origin, data: { protocol: 1, type: 'host-ready' } };
  expect(validateReactPreviewBootstrap(event, { source, origin }, 'host-ready')).toEqual(
    event.data,
  );
  expect(() =>
    validateReactPreviewBootstrap({ ...event, source: {} }, { source, origin }, 'host-ready'),
  ).toThrow();
  expect(() =>
    validateReactPreviewBootstrap(
      { ...event, origin: 'https://other.example.test' },
      { source, origin },
      'host-ready',
    ),
  ).toThrow();
  expect(() =>
    validateReactPreviewBootstrap(event, { source, origin }, 'host-ready-request'),
  ).toThrow();
  expect(() =>
    validateReactPreviewBootstrap(
      { ...event, data: { ...event.data, document: {} } },
      { source, origin },
      'host-ready',
    ),
  ).toThrow();
  let read = false;
  expect(() =>
    validateReactPreviewBootstrap(
      {
        ...event,
        data: {
          protocol: 1,
          get type() {
            read = true;
            return 'host-ready';
          },
        },
      },
      { source, origin },
      'host-ready',
    ),
  ).toThrow();
  expect(read).toBe(false);
});
