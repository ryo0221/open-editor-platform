import { command } from '@editor-platform/editor-core';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  assertVideoContentV3,
  add,
  subtract,
  time,
  videoCommandV3,
  type VideoContentV3,
  type TextClipV3,
} from '@editor-platform/video-core';
import type { ExportFontProfile } from '@editor-platform/export-core';
import type { HostExtension } from '../host-media/m2/host-v2';
import { parseCaptions, serializeCaptions, type CaptionCue, type CaptionFormat } from './captions';
import { loadFixedFontAsset, readFixedFontAsset, assertFixedText } from './fixed-font';
const seconds = (value: string) => {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(value);
  if (!m) throw Error('Use nonnegative rational title seconds');
  return time(Number(m[1]), Number(m[2] ?? 1));
};
/** Native title controls and one aggregate IME/flush boundary, using existing Host authority. */
export function mountTitleControls(host: HostExtension<VideoContentV3>, manifestUrl: string) {
  const panel = document.createElement('section');
  panel.innerHTML =
    '<h2>Japanese title / caption</h2><label>Text kind <select id="title-kind"><option value="title">Title</option><option value="caption">Caption</option></select></label><label>Retained fixed font <select id="title-font"></select></label><fieldset id="title-fields" disabled><label>Title text <textarea id="title-text" rows="3"></textarea></label><label>Title start (seconds) <input id="title-start" value="0"></label><label>Title end (seconds) <input id="title-end" value="1"></label><label>Title track <select id="title-track"></select></label><label>Title size (fraction of height) <input id="title-size" value="0.04"></label><label>Title color <input id="title-color" type="color" value="#ffffff"></label></fieldset><p id="title-status" role="status">Load a retained fixed font before typing. Missing glyphs are refused.</p>';
  host.root.querySelector('#actions')!.before(panel);
  const find = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const text = find<HTMLTextAreaElement>('#title-text'),
    fontChoice = find<HTMLSelectElement>('#title-font'),
    trackChoice = find<HTMLSelectElement>('#title-track'),
    status = find('#title-status');
  const prepared = new Map<string, ExportFontProfile>();
  const fields = find<HTMLFieldSetElement>('#title-fields');
  const ready = () => {
    fields.disabled = !prepared.has(fontChoice.value);
  };
  let preparedTitle: TextClipV3 | undefined;
  let dirty = false,
    composing = false,
    target: TextClipV3 | undefined,
    base = canonicalJson(host.read().revision),
    closed = false;
  const refresh = () => {
    for (const [choice, items] of [
      [
        fontChoice,
        host
          .read()
          .content.sources.filter((s) => 'kind' in s && s.kind === 'font')
          .map((s) => ({ id: s.id, label: 'weight' in s ? s.weight : '' })),
      ],
      [
        trackChoice,
        host
          .read()
          .content.sequence.tracks.filter((t) => t.kind === 'visual')
          .map((t) => ({ id: t.id, label: t.id })),
      ],
    ] as const) {
      const previous = choice.value;
      choice.replaceChildren();
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        choice.append(option);
      }
      if ([...choice.options].some((o) => o.value === previous)) choice.value = previous;
    }
    if (!dirty) {
      base = canonicalJson(host.read().revision);
      if (target) {
        const current = host.read().content.sequence.clips.find((c) => c.id === target!.id);
        if (current?.kind === 'title' || current?.kind === 'caption') showTitle(current);
        else {
          target = undefined;
          text.value = '';
        }
      }
    }
    ready();
  };
  function candidate(cue?: CaptionCue): TextClipV3 {
    const manifest = prepared.get(fontChoice.value);
    if (!manifest) throw Error('Prepare the retained title font first');
    const value = cue?.text ?? text.value.replace(/\r\n?/g, '\n');
    assertFixedText(value, manifest);
    const start = cue?.start ?? seconds(find<HTMLInputElement>('#title-start').value),
      end = cue?.end ?? seconds(find<HTMLInputElement>('#title-end').value),
      duration = subtract(end, start);
    return {
      ...(!cue && target ? target : {}),
      id: (!cue && target?.id) || 'text:' + crypto.randomUUID(),
      kind: cue ? 'caption' : (find<HTMLSelectElement>('#title-kind').value as 'title' | 'caption'),
      sourceId: fontChoice.value,
      trackId: trackChoice.value,
      text: value,
      start,
      duration,
      sourceIn: (!cue && target?.sourceIn) || time(0),
      sourceOut: add((!cue && target?.sourceIn) || time(0), duration),
      rate: time(1),
      style: {
        x: 0.05,
        y: 0.8,
        width: 0.9,
        height: 0.15,
        align: 'center',
        ...(!cue && target ? target.style : {}),
        size: Number(find<HTMLInputElement>('#title-size').value),
        color: find<HTMLInputElement>('#title-color').value,
      },
    };
  }
  const binding = host.bindInputs({
    label: 'Japanese title',
    read: () => ({ dirty, composing }),
    focus: () => text.focus(),
    prepare(snapshot) {
      if (composing) throw Error('Finish Japanese composition before committing');
      if (canonicalJson(snapshot.revision) !== base)
        throw Error('Title input base changed; apply or discard explicitly');
      const next = candidate(),
        expected = target && canonicalJson(target);
      if (
        target?.linkGroupId &&
        (canonicalJson(next.start) !== canonicalJson(target.start) ||
          canonicalJson(next.duration) !== canonicalJson(target.duration))
      )
        throw Error('Linked text timing: use linked move/explicit trim, or unlink first');
      const cmd = target
        ? command<VideoContentV3>('video.prototype.v3.title-edit', 'Edit title', (content) => {
            const result = structuredClone(content),
              at = result.sequence.clips.findIndex((c) => c.id === next.id);
            if (at < 0 || canonicalJson(result.sequence.clips[at]) !== expected)
              throw Error('Title changed');
            if (
              result.sequence.tracks.find((t) => t.id === result.sequence.clips[at].trackId)
                ?.locked ||
              result.sequence.tracks.find((t) => t.id === next.trackId)?.locked
            )
              throw Error('Locked title track');
            result.sequence.clips[at] = next;
            assertVideoContentV3(result);
            return result;
          })
        : videoCommandV3({ type: 'insert', clip: next });
      preparedTitle = next;
      return {
        baseRevision: snapshot.revision,
        command: expected === canonicalJson(next) ? null : cmd,
      };
    },
    committed(snapshot) {
      dirty = false;
      base = canonicalJson(snapshot.revision);
      target = snapshot.content.sequence.clips.find(
        (c): c is TextClipV3 =>
          (c.kind === 'title' || c.kind === 'caption') && c.id === preparedTitle?.id,
      );
      target = target && structuredClone(target);
      status.textContent = 'Title committed; Undo restores the previous native state.';
    },
  });
  const changed = () => {
    if (!text.value && !target && !composing) return;
    if (!dirty) base = canonicalJson(host.read().revision);
    ready();
    dirty = true;
    binding.changed();
  };
  for (const input of fields.querySelectorAll('input, select, textarea'))
    input.addEventListener('input', changed);
  find<HTMLSelectElement>('#title-kind').addEventListener('input', changed);
  fontChoice.addEventListener('input', () => {
    ready();
    if (text.value || target) changed();
  });
  text.addEventListener('compositionstart', () => {
    composing = true;
    changed();
  });
  text.addEventListener('compositionend', () => {
    composing = false;
    changed();
  });
  const unsubscribe = host.subscribe(refresh);
  refresh();
  for (const weight of ['regular', 'bold'] as const)
    host.button('Load fixed Japanese ' + weight + ' font', () =>
      host.work('Load fixed font', async (signal) => {
        if (dirty) throw Error('Apply or discard title edits before loading a font');
        const { bytes, plan } = await loadFixedFontAsset(manifestUrl, weight, signal);
        const decoded = await readFixedFontAsset(bytes, plan, signal);
        const id = await host.adoptOriginal(
          new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
          plan,
          (content, asset, sourceId) => {
            const result = structuredClone(content);
            result.sources.push({
              id: sourceId,
              kind: 'font',
              asset,
              fontProfile: plan.fontProfile,
              weight,
            });
            assertVideoContentV3(result);
            return result;
          },
          signal,
        );
        if (closed) return;
        prepared.set(id, decoded.manifest);
        refresh();
        fontChoice.value = id;
        ready();
        status.textContent =
          'Fixed font, manifest and original copyright notice retained in the project.';
      }),
    );
  host.button('Prepare retained title font', () =>
    host.work('Prepare title font', async (signal) => {
      const id = fontChoice.value,
        original = host.original(id);
      if (original.plan.profile !== 'font-v3') throw Error('Select a retained fixed font');
      const decoded = await readFixedFontAsset(
        new Uint8Array(await original.bytes.arrayBuffer()),
        original.plan,
        signal,
      );
      if (closed) return;
      prepared.set(id, decoded.manifest);
      ready();
      status.textContent = 'Retained fixed font ready.';
    }),
  );
  function showTitle(clip: TextClipV3) {
    target = structuredClone(clip);
    find<HTMLSelectElement>('#title-kind').value = clip.kind;
    fontChoice.value = clip.sourceId;
    trackChoice.value = clip.trackId;
    text.value = clip.text;
    find<HTMLInputElement>('#title-start').value = `${clip.start.value}/${clip.start.timescale}`;
    const end = add(clip.start, clip.duration);
    find<HTMLInputElement>('#title-end').value = `${end.value}/${end.timescale}`;
    find<HTMLInputElement>('#title-size').value = String(clip.style.size);
    find<HTMLInputElement>('#title-color').value = clip.style.color;
    base = canonicalJson(host.read().revision);
    ready();
  }
  host.button('Edit selected title', () => {
    if (dirty) throw Error('Apply or discard title edits first');
    const id = host.root.querySelector<HTMLSelectElement>('#selected')!.value;
    const clip = host.read().content.sequence.clips.find((c) => c.id === id);
    if (clip?.kind !== 'title' && clip?.kind !== 'caption') throw Error('Select a native title');
    showTitle(clip);
    status.textContent = 'Editing the selected native title.';
  });
  host.button('New title', () => {
    if (dirty || composing) throw Error('Apply or discard title edits first');
    target = undefined;
    preparedTitle = undefined;
    text.value = '';
    base = canonicalJson(host.read().revision);
    status.textContent = 'New title input; no native changes yet.';
  });
  host.button('Apply title', () => host.applyInputs());
  host.button('Discard title edits', () => {
    dirty = false;
    composing = false;
    target = undefined;
    text.value = '';
    base = canonicalJson(host.read().revision);
    binding.changed();
    status.textContent = 'Title input discarded; native content unchanged.';
  });
  const captionFile = document.createElement('input');
  captionFile.type = 'file';
  captionFile.id = 'caption-file';
  captionFile.accept = '.srt,.vtt';
  const captionLabel = document.createElement('label');
  captionLabel.textContent = 'Plain SRT/WebVTT file ';
  captionLabel.append(captionFile);
  panel.append(captionLabel);
  host.button('Import captions', async () => {
    if (dirty || composing) throw Error('Apply or discard text edits before importing captions');
    const file = captionFile.files?.[0];
    if (!file || file.size > 1024 * 1024) throw Error('Caption file/byte limit');
    const format = file.name.endsWith('.srt')
      ? 'srt'
      : file.name.endsWith('.vtt')
        ? 'vtt'
        : undefined;
    if (!format) throw Error('Unsupported caption file extension');
    const token = host.token();
    let clips: TextClipV3[] = [];
    await host.work('Read captions', async (signal) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal.throwIfAborted();
      clips = parseCaptions(bytes, format).map((cue) => candidate(cue));
    });
    host.executeAt(
      token,
      command<VideoContentV3>('video.prototype.v3.caption-import', 'Import captions', (content) => {
        const result = structuredClone(content);
        for (const clip of clips) {
          if (result.sequence.tracks.find((t) => t.id === clip.trackId)?.locked)
            throw Error('Locked caption track');
          result.sequence.clips.push(structuredClone(clip));
        }
        assertVideoContentV3(result);
        return result;
      }),
    );
    status.textContent = `Imported ${clips.length} captions atomically.`;
  });
  for (const format of ['srt', 'vtt'] as CaptionFormat[])
    host.button('Export captions ' + format.toUpperCase(), () =>
      host.work('Caption export', async () => {
        if (dirty || composing) host.applyInputs();
        const clips = host
          .read()
          .content.sequence.clips.filter((c): c is TextClipV3 => c.kind === 'caption');
        for (const clip of clips) host.original(clip.sourceId);
        const bytes = serializeCaptions(clips, format);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'captions.' + format;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    );
  const linkLabel = document.createElement('label');
  linkLabel.textContent = 'Link selected text to clip ID ';
  const linkTarget = document.createElement('input');
  linkTarget.id = 'caption-link-target';
  linkLabel.append(linkTarget);
  panel.append(linkLabel);
  host.button('Link selected text explicitly', () => {
    const selected = host.root.querySelector<HTMLSelectElement>('#selected')!.value;
    const clip = host.read().content.sequence.clips.find((c) => c.id === selected);
    if (clip?.kind !== 'title' && clip?.kind !== 'caption') throw Error('Select a text clip');
    host.executeAt(
      host.token(),
      videoCommandV3({
        type: 'link',
        clipIds: [selected, linkTarget.value],
        groupId: 'text-link:' + crypto.randomUUID(),
      }),
    );
  });
  return () => {
    closed = true;
    unsubscribe();
    binding.unregister();
    prepared.clear();
  };
}
