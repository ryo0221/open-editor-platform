import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  canonicalJson,
  commitVersion,
  MemoryStorage,
  updateDraft,
  type Artifact,
} from '@editor-platform/artifact-core';
import { createStoryBoardSample } from './sample';
import { StoryBoardController } from './controller';
import { createBoardSettingsData } from './settings';
import { filterStoryBoard } from './filter';
import { BoardMapPanel, BoardTimelinePanel, BoardEventCard, boardPositionLabel } from './panels';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { BoardReading } from './reading';

async function fixture() {
  const storage = new MemoryStorage<Artifact<unknown>>(),
    sample = await createStoryBoardSample(storage);
  const access = { namespace: 'panels', mayRead: () => true, mayEdit: () => true };
  const open = () => StoryBoardController.open(storage, sample.settingsId, sample.links, access);
  const c = await open(),
    result = await c.read();
  if (result.state !== 'ready') throw Error('fixture');
  return { storage, sample, open, c, reading: result };
}
function map(reading: BoardReading, day = 3) {
  const view = filterStoryBoard(reading, {
    ...reading.opened.settings.presets[0].filter,
    time: { kind: 'point', clock: reading.opened.settings.clock, value: day },
  });
  const markup = renderToStaticMarkup(
    createElement(
      'svg',
      null,
      createElement(BoardMapPanel, {
        reading,
        view,
        width: 470,
        height: 400,
        mode: 'content',
        actions: {
          select() {
            throw Error('render wrote selection');
          },
          point() {
            throw Error('render moved cursor');
          },
          source() {
            throw Error('render opened source');
          },
        },
      }),
    ),
  );
  return { markup, view };
}
it('SB03/04/09: fixed-map rendering shows only confirmed point records; uncertain and region records are not precise markers', async () => {
  const f = await fixture(),
    before = canonicalJson(await f.storage.list());
  const { markup, view } = map(f.reading);
  expect(markup.match(/data-board-map-marker=/g)).toHaveLength(3);
  expect(markup).not.toContain('data-board-map-marker="place-3"');
  expect(markup).not.toContain('ユイ');
  expect(
    boardPositionLabel(f.reading, view.positions.find((p) => p.individual.character === 'CH-010')!),
  ).toContain('候補');
  const unknown = map(f.reading, 7);
  expect(unknown.markup).not.toContain('data-board-map-marker=');
  expect(
    unknown.view.positions.every((p) => boardPositionLabel(f.reading, p).includes('記録なし')),
  ).toBe(true);
  expect(canonicalJson(await f.storage.list())).toBe(before);
  expect(f.c.boardSnapshot.canUndo).toBe(false);
});
it('SB04/09: a saved feature subset removes markers and distinguishes known off-view places from unknown presence', async () => {
  const f = await fixture();
  const settings = structuredClone(f.reading.opened.settings);
  settings.map.featureIds = ['place-1'];
  const config = (await f.storage.get(f.sample.settingsId))!;
  await f.storage.put(
    await commitVersion(updateDraft(config, createBoardSettingsData(settings)), null, null),
  );
  const c = await f.open(),
    result = await c.read();
  if (result.state !== 'ready') throw Error('fixture');
  const { markup, view } = map(result);
  expect(markup.match(/data-board-map-marker=/g)).toHaveLength(1);
  expect(markup).not.toContain('アリア');
  const position = view.positions.find(
    (p) => p.individual.character === 'CH-001' && p.individual.origin === 'WL-A',
  )!;
  expect(boardPositionLabel(result, position)).toContain('表示範囲外');
  expect(boardPositionLabel(result, position)).not.toContain('記録なし');
});

it('SB03/05: an event card shows places in the active time scope, not the same event future presence', async () => {
  const f = await fixture(),
    view = filterStoryBoard(f.reading, f.reading.opened.settings.presets[0].filter);
  const event = view.events.find((e) => e.ref.itemId === 'EV-400')!;
  const markup = renderToStaticMarkup(
    createElement(
      'svg',
      null,
      createElement(BoardEventCard, {
        reading: f.reading,
        view,
        event,
        width: 270,
        height: 240,
        mode: 'content',
        actions: { select() {}, point() {}, source() {} },
      }),
    ),
  );
  expect(markup).toContain('王都');
  expect(markup).not.toContain('石橋');
});

it('SB04: a native uncertain range remains identified as a time candidate in the timeline', async () => {
  const f = await fixture(),
    artifact = (await f.storage.get('sb660-story-ledger-A'))!;
  const data = structuredClone(artifact.draft.content) as StructuredData;
  const row = data.rows.find((r) => r.id === 'EV-400')!;
  row.values['tl1.time.kind'] = 'range';
  row.values['tl1.time.end'] = 3;
  await f.storage.put(await commitVersion(updateDraft(artifact, data), null, null));
  const c = await f.open(),
    reading = await c.read();
  if (reading.state !== 'ready') throw Error('fixture');
  const view = filterStoryBoard(reading, reading.opened.settings.presets[0].filter);
  const markup = renderToStaticMarkup(
    createElement(
      'svg',
      null,
      createElement(BoardTimelinePanel, {
        reading,
        view,
        width: 600,
        height: 400,
        mode: 'content',
        actions: { select() {}, point() {}, source() {} },
      }),
    ),
  );
  expect(markup).toContain('アリアの3日目（時点候補）を選択');
});
