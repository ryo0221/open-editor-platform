import { describe, expect, it } from 'vitest';
import { createMockTableHost, createMockWorkItemHost } from './mock-host';

const signal = () => new AbortController().signal;

describe('Structured Data external read ports', () => {
  it('reads a padded synthetic table and marks a cut read incomplete', async () => {
    const host = createMockTableHost();
    const [source] = await host.read.listSources(signal());
    const read = await host.read.readTable({ sourceHandle: source.handle }, signal());
    expect(read.complete).toBe(true);
    expect(read.rows.every((row) => row.length === read.columnCount)).toBe(true);
    host.controls.setComplete(false);
    const cut = await host.read.readTable({ sourceHandle: source.handle }, signal());
    expect(cut).toMatchObject({ complete: false, resolvedRange: 'Budget!A1:E3' });
    expect(cut.rows).toHaveLength(3);
  });

  it('signals a provider change and returns the edited content afterwards', async () => {
    const host = createMockTableHost();
    const [source] = await host.read.listSources(signal());
    const notices: unknown[] = [];
    host.read.watch!((n) => notices.push(n));
    host.controls.changeSource();
    expect(notices).toEqual([{ kind: 'changed', sourceHandle: source.handle }]);
    const read = await host.read.readTable({ sourceHandle: source.handle }, signal());
    expect(read.rows[2][2]).toBe(950);
  });

  it('reads work items with partial labels and refuses handles of an old account', async () => {
    const host = createMockWorkItemHost();
    const [source] = await host.read.listSources(signal());
    const read = await host.read.readWorkItems({ sourceHandle: source.handle }, signal());
    expect(read.items.find((i) => i.number === 2)).toMatchObject({
      kind: 'pullRequest',
      labelsComplete: false,
    });
    host.controls.failReads(true);
    await expect(
      host.read.readWorkItems({ sourceHandle: source.handle }, signal()),
    ).rejects.toThrow(/could not be read/);
    host.controls.failReads(false);
    host.controls.switchAccount();
    await expect(
      host.read.readWorkItems({ sourceHandle: source.handle }, signal()),
    ).rejects.toThrow(/no longer connected/);
  });

  it('rejects an aborted read', async () => {
    const host = createMockWorkItemHost();
    const [source] = await host.read.listSources(signal());
    const controller = new AbortController();
    const pending = host.read.readWorkItems({ sourceHandle: source.handle }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/Aborted/);
  });
});
