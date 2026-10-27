import { mountDissolveControls } from '../host-visual/dissolve-host';
import { mountTitleControls } from '../host-visual/title-host';
import { inspectImageOriginalV3, prepareImageImportV3 } from '../host-visual/image-source';
/** Private ordinary Video host adapter, retaining the existing toolbar and SaveCoordinator. */
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  assertVideoContentV3,
  mediaContentV3,
  time,
  videoCommandV3,
  updateAnimationClipV3,
  type VideoContentV3,
  type AnimationClipV3,
} from '@editor-platform/video-core';
import {
  createPreparedAnimationEmbed2,
  prepareAnimation2,
  type AnimationEmbed2,
} from '@editor-platform/animation-core/v2';
import {
  emptyV2,
  mountNativeVideoHost,
  type NativeHostOptions,
  type NativeHostVariant,
  type PersistenceFactoryV2,
  type CodecV2,
} from '../host-media/m2/host-v2';
import { assertControlledVideoCapacity } from '../host-media/m2/capacity-v2';
import { prepareAnimationTimelineV3 } from './timeline-v3';
import { prepareVideoAnimationPin } from './native-pin';
export interface AnimationSourcePort {
  /** Existing Host catalog only. Choices name immutable versions, never a latest alias. */
  list(signal: AbortSignal): Promise<{ label: string; source: AnimationEmbed2['source'] }[]>;
  /** Holds the exact native version until release. Snapshot is copied into native Video history. */
  retain(
    source: AnimationEmbed2['source'],
    signal: AbortSignal,
  ): Promise<{
    snapshot: unknown;
    assertAuthorized(): void;
    release(): void;
  }>;
}
export const emptyV3 = (): VideoContentV3 => ({ ...emptyV2(), schema: 'video-core-prototype-v3' });
export const mediaProjectionV3 = mediaContentV3;
export function validateHostV3(value: unknown): value is VideoContentV3 {
  try {
    assertVideoContentV3(value);
    assertControlledVideoCapacity(value);
    prepareAnimationTimelineV3(value);
    return true;
  } catch {
    return false;
  }
}
export function mountV3Host(
  root: HTMLElement,
  factory: PersistenceFactoryV2<VideoContentV3> | undefined,
  codec: CodecV2<VideoContentV3>,
  sources: AnimationSourcePort,
  file?: Blob,
  options: NativeHostOptions = {},
) {
  const variant: NativeHostVariant<VideoContentV3> = {
    schema: 'video-core-prototype-v3',
    empty: emptyV3,
    validate: validateHostV3,
    command: videoCommandV3,
    visualFade: (clipId, fadeIn, fadeOut) =>
      videoCommandV3({ type: 'visual-fade', clipId, fadeIn, fadeOut }),
    media: mediaProjectionV3,
    imageImport: { inspect: inspectImageOriginalV3, prepare: prepareImageImportV3 },
    withMedia(content, media) {
      const result: VideoContentV3 = {
        ...media,
        schema: 'video-core-prototype-v3',
        sources: [...media.sources, ...content.sources.filter((s) => 'kind' in s)],
        sequence: {
          ...media.sequence,
          ...(content.sequence.transitions
            ? { transitions: structuredClone(content.sequence.transitions) }
            : {}),
          clips: [
            ...media.sequence.clips.map((c) => {
              const previous = content.sequence.clips.find((p) => p.id === c.id);
              if (previous?.linkGroupId) c = { ...c, linkGroupId: previous.linkGroupId };
              return c.kind === 'video' && previous?.kind === 'video' && previous.visualFade
                ? { ...c, visualFade: structuredClone(previous.visualFade) }
                : c;
            }),
            ...content.sequence.clips.filter(
              (c) =>
                c.kind === 'animation' ||
                c.kind === 'image' ||
                c.kind === 'title' ||
                c.kind === 'caption',
            ),
          ],
        },
      };
      assertVideoContentV3(result);
      return result;
    },
    extend(host) {
      const disposeDissolves = mountDissolveControls(host);
      const disposeTitles = mountTitleControls(
        host,
        new URL('/office-fonts/manifest.json', location.href).href,
      );
      const layers = document.createElement('section');
      layers.innerHTML =
        '<h2>Visual tracks (bottom to top)</h2><label>Visual track <select id="visual-track"></select></label>';
      host.root.querySelector('#actions')!.before(layers);
      const trackChoice = layers.querySelector<HTMLSelectElement>('#visual-track')!;
      const refreshTracks = () => {
        const previous = trackChoice.value;
        trackChoice.replaceChildren();
        for (const track of host
          .read()
          .content.sequence.tracks.filter((t) => t.kind === 'visual')) {
          const option = document.createElement('option');
          option.value = track.id;
          option.textContent = track.id + (track.locked ? ' (locked)' : '');
          trackChoice.append(option);
        }
        if ([...trackChoice.options].some((o) => o.value === previous))
          trackChoice.value = previous;
      };
      const unsubscribeTracks = host.subscribe(refreshTracks);
      host.button('Add visual track', () => {
        const trackId = 'visual:' + crypto.randomUUID();
        host.executeAt(host.token(), videoCommandV3({ type: 'visual-track-add', trackId }));
        refreshTracks();
        trackChoice.value = trackId;
      });
      host.button('Move selected visual clip to track', () => {
        const clipId = host.root.querySelector<HTMLSelectElement>('#selected')!.value;
        host.executeAt(
          host.token(),
          videoCommandV3({ type: 'visual-track-assign', clipId, trackId: trackChoice.value }),
        );
      });
      for (const [label, direction] of [
        ['Raise visual track', 1],
        ['Lower visual track', -1],
      ] as const)
        host.button(label, () => {
          host.executeAt(
            host.token(),
            videoCommandV3({ type: 'visual-track-shift', trackId: trackChoice.value, direction }),
          );
          refreshTracks();
        });
      refreshTracks();
      const panel = document.createElement('section');
      panel.innerHTML =
        '<h2>Animation</h2><label>Saved source version <select id="animation-source"></select></label><label>Placement (whole seconds) <input id="animation-start" type="number" min="0" step="1" value="0"></label><p id="animation-preview" role="status">Select a saved version and preview before applying.</p>';
      host.root.querySelector('#actions')!.before(panel);
      const select = panel.querySelector<HTMLSelectElement>('#animation-source')!;
      const status = panel.querySelector('#animation-preview')!;
      let choices: Awaited<ReturnType<AnimationSourcePort['list']>> = [];
      let pending:
        | {
            token: string;
            lifetime: AbortController;
            old?: AnimationClipV3;
            next: AnimationClipV3;
            lease: Awaited<ReturnType<AnimationSourcePort['retain']>>;
            sourceIndex: string;
            start: string;
          }
        | undefined;
      const clear = () => {
        pending?.lifetime.abort();
        pending?.lease.release();
        pending = undefined;
      };
      const authorized = () => {
        if (options.allowed && !options.allowed('artifact:read'))
          throw Error('Animation source read denied');
      };
      host.button('Refresh Animation versions', () =>
        host.work('Animation sources', async (signal) => {
          clear();
          authorized();
          const result = await sources.list(signal);
          signal.throwIfAborted();
          authorized();
          choices = structuredClone(result);
          select.replaceChildren();
          choices.forEach((choice, i) => {
            const option = document.createElement('option');
            option.value = String(i);
            option.textContent = choice.label + ' / ' + choice.source.versionId;
            select.append(option);
          });
        }),
      );
      async function preview(update: boolean) {
        await host.work('Animation preview', async (signal) => {
          clear();
          authorized();
          const token = host.token();
          const sourceIndex = select.value,
            start = panel.querySelector<HTMLInputElement>('#animation-start')!.value;
          const chosen = choices[Number(sourceIndex)];
          if (!chosen || sourceIndex === '') throw Error('Select an exact saved version');
          const old = update
            ? host
                .read()
                .content.sequence.clips.find(
                  (c) => c.id === host.root.querySelector<HTMLSelectElement>('#selected')!.value,
                )
            : undefined;
          if (update && old?.kind !== 'animation') throw Error('Select an Animation clip');
          const lifetime = new AbortController();
          const cancel = () => lifetime.abort(signal.reason);
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
          let lease: Awaited<ReturnType<AnimationSourcePort['retain']>> | undefined;
          try {
            lease = await sources.retain(structuredClone(chosen.source), lifetime.signal);
            signal.throwIfAborted();
            authorized();
            lease.assertAuthorized();
            const pin = prepareVideoAnimationPin(chosen.source, lease.snapshot);
            const embed = createPreparedAnimationEmbed2(
              pin.source,
              prepareAnimation2(pin.snapshot),
              chosen.label,
            );
            const composition = embed.snapshot.compositions.find(
              (c) => c.id === embed.source.compositionId,
            )!;
            if (!update && (!start.trim() || !Number.isSafeInteger(Number(start))))
              throw Error('Enter whole placement seconds');
            const next: AnimationClipV3 =
              old?.kind === 'animation'
                ? { ...old, embed }
                : {
                    id: 'animation:' + crypto.randomUUID(),
                    kind: 'animation',
                    trackId: 'visual',
                    start: time(Number(start)),
                    duration: time(composition.duration, embed.snapshot.ticksPerSecond),
                    sourceIn: time(0),
                    sourceOut: time(composition.duration, embed.snapshot.ticksPerSecond),
                    rate: time(1),
                    embed,
                  };
            const cmd =
              old?.kind === 'animation'
                ? updateAnimationClipV3(old.id, old.embed.source, embed)
                : videoCommandV3({ type: 'insert', clip: next });
            if (!validateHostV3(cmd.apply(host.read().content)))
              throw Error('Animation exceeds Host capacity/subset');
            if (token !== host.token()) throw Error('Stale Animation preview');
            pending = {
              token,
              lifetime,
              old: old?.kind === 'animation' ? structuredClone(old) : undefined,
              next,
              lease,
              sourceIndex,
              start,
            };
            status.textContent =
              (update ? 'Update' : 'Insert') +
              ' ' +
              canonicalJson(embed.source) +
              '; placement retained on update. Apply explicitly.';
          } finally {
            signal.removeEventListener('abort', cancel);
            if (!lease || pending?.lease !== lease) {
              lifetime.abort();
              lease?.release();
            }
          }
        });
      }
      host.button('Preview Animation placement', () => preview(false));
      host.button('Preview Animation update', () => preview(true));
      host.button('Apply Animation preview', () => {
        const prepared = pending;
        if (!prepared) throw Error('Preview required');
        try {
          authorized();
          prepared.lease.assertAuthorized();
          if (
            prepared.old &&
            host.root.querySelector<HTMLSelectElement>('#selected')!.value !== prepared.old.id
          )
            throw Error('Selected clip changed');
          if (
            select.value !== prepared.sourceIndex ||
            panel.querySelector<HTMLInputElement>('#animation-start')!.value !== prepared.start
          )
            throw Error('Preview inputs changed');
          const cmd = prepared.old
            ? updateAnimationClipV3(prepared.old.id, prepared.old.embed.source, prepared.next.embed)
            : videoCommandV3({ type: 'insert', clip: prepared.next });
          host.executeAt(prepared.token, cmd);
          status.textContent =
            'Applied; the exact native snapshot is retained in Video history. Undo restores the previous pin.';
        } finally {
          clear();
        }
      });
      host.button('Cancel Animation preview', () => {
        clear();
        status.textContent = 'Preview cancelled';
      });
      return () => {
        clear();
        unsubscribeTracks();
        disposeTitles();
        disposeDissolves();
      };
    },
  };
  return mountNativeVideoHost(root, factory, codec, variant, file, options);
}
