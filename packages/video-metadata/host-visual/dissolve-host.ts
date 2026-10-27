import {
  add,
  compare,
  time,
  videoCommandV3,
  type VideoContentV3,
} from '@editor-platform/video-core';
import type { HostExtension } from '../host-media/m2/host-v2';
export function mountDissolveControls(host: HostExtension<VideoContentV3>) {
  const panel = document.createElement('section');
  panel.innerHTML =
    '<h2>Cross-dissolve</h2><p>Select the left clip, then its adjacent right clip. Cut time and sequence duration stay unchanged.</p><label>Right clip <select id="dissolve-right"></select></label><label>Transition duration (seconds or fraction) <input id="dissolve-duration" value="1/2"></label><ol id="dissolve-list"></ol>';
  host.root.querySelector('#actions')!.before(panel);
  const selected = host.root.querySelector<HTMLSelectElement>('#selected')!;
  const right = panel.querySelector<HTMLSelectElement>('#dissolve-right')!;
  const refresh = () => {
    const content = host.read().content,
      left = content.sequence.clips.find((c) => c.id === selected.value);
    const previous = right.value;
    right.replaceChildren();
    for (const clip of content.sequence.clips.filter(
      (c) =>
        left &&
        c.kind !== 'audio' &&
        c.trackId === left.trackId &&
        compare(c.start, add(left.start, left.duration)) === 0,
    )) {
      const option = document.createElement('option');
      option.value = clip.id;
      option.textContent = `${clip.kind} at ${clip.start.value}/${clip.start.timescale}s`;
      right.append(option);
    }
    if ([...right.options].some((o) => o.value === previous)) right.value = previous;
    const list = panel.querySelector('#dissolve-list')!;
    list.replaceChildren();
    for (const edge of content.sequence.transitions ?? []) {
      const row = document.createElement('li');
      row.textContent = `Cross-dissolve ${edge.duration.value}/${edge.duration.timescale}s`;
      list.append(row);
    }
  };
  const unsubscribe = host.subscribe(refresh);
  selected.addEventListener('change', refresh);
  refresh();
  host.button('Set cross-dissolve', () => {
    const raw = panel.querySelector<HTMLInputElement>('#dissolve-duration')!.value;
    const match = /^(\d+)(?:\/(\d+))?$/.exec(raw);
    if (!match) throw Error('Use exact positive transition seconds');
    const content = host.read().content;
    const previous = content.sequence.transitions?.find(
      (e) => e.leftClipId === selected.value && e.rightClipId === right.value,
    );
    host.executeAt(
      host.token(),
      videoCommandV3({
        type: 'dissolve-set',
        edge: {
          id: previous?.id ?? 'dissolve:' + crypto.randomUUID(),
          kind: 'cross-dissolve',
          leftClipId: selected.value,
          rightClipId: right.value,
          duration: time(Number(match[1]), Number(match[2] ?? 1)),
        },
      }),
    );
  });
  host.button('Remove selected cross-dissolve', () => {
    const edge = host
      .read()
      .content.sequence.transitions?.find((e) => e.leftClipId === selected.value);
    if (!edge) throw Error('Select a left clip with a cross-dissolve');
    host.executeAt(host.token(), videoCommandV3({ type: 'dissolve-remove', edgeId: edge.id }));
  });
  return () => {
    unsubscribe();
    selected.removeEventListener('change', refresh);
  };
}
