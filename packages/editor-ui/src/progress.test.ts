import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProgressStatus, progressClock } from './progress';

describe('#16 progress status', () => {
  it('reads the clock its start time came from (Codex on #31)', () => {
    expect(progressClock(Date.now())).toBe(Date.now);
    expect(progressClock(1234)).not.toBe(Date.now);
    // Started 10 min ago by the epoch clock, half done: about 10 min left.
    const html = renderToStaticMarkup(
      createElement(ProgressStatus, {
        label: 'Checking',
        progress: { done: 1, total: 2, startedAt: Date.now() - 600_000 },
      }),
    );
    expect(html).toMatch(/1 of 2 · about 10 min left/);
    // A clock given by the Host wins.
    const given = renderToStaticMarkup(
      createElement(ProgressStatus, {
        label: 'Checking',
        progress: { done: 1, total: 4, startedAt: 0 },
        clock: () => 120_000,
      }),
    );
    expect(given).toMatch(/1 of 4 · about 6 min left/);
  });
});
