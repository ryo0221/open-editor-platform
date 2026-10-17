import {
  add,
  validateVideoContent,
  type Time,
  type VideoContent,
} from '@editor-platform/video-core';
import {
  SCHEMA_EXPERIMENT_VERSION,
  type SchemaExperimentDefinition,
} from '@editor-platform/extension-contract/schema-experiment';

const schema = 'video-core-prototype-v0' as const;
const seconds = (t: Time) => `${t.value}/${t.timescale} s`;
/** Read-only projection of one native snapshot; no media access or persistence. */
export function videoMetadataExtension(
  packageHash: string,
): SchemaExperimentDefinition<VideoContent> {
  if (!/^[a-f0-9]{64}$/.test(packageHash)) throw new Error('Invalid package hash');
  return {
    manifest: {
      id: 'video-metadata',
      version: '0.0.0-experiment.1',
      packageHash,
      contractVersion: SCHEMA_EXPERIMENT_VERSION,
      artifactKind: 'video',
      schemaIdentity: { kind: 'literal', value: schema },
      surface: true,
      permissions: ['artifact:read'],
      addons: { lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' } },
      licenseNotices: ['Repository license applies; no additional license grant.'],
    },
    validate(value): value is VideoContent {
      return validateVideoContent(value).valid;
    },
    schemaOf(content) {
      if (content.schema !== schema) throw new Error('Unsupported video schema');
      return { kind: 'literal', value: content.schema };
    },
    mount(container, context) {
      const { lifecycle, basic } = context;
      const root = container.ownerDocument.createElement('section');
      root.setAttribute('aria-label', 'Video metadata');
      root.style.overflowWrap = 'anywhere';
      let disposed = false;
      const dispose = () => {
        disposed = true;
        lifecycle.signal.removeEventListener('abort', dispose);
        root.remove();
      };
      const current = () => {
        lifecycle.assertCurrent();
        if (disposed || lifecycle.signal.aborted) throw new Error('Video scope revoked');
      };
      const sameScope = (a: typeof basic.scope, b: typeof basic.scope) =>
        a.artifactId === b.artifactId &&
        a.sessionId === b.sessionId &&
        a.generation === b.generation;
      const line = (tag: 'h2' | 'h3' | 'p', text: string) => {
        const element = container.ownerDocument.createElement(tag);
        element.textContent = text;
        root.append(element);
      };
      try {
        current();
        if (!sameScope(basic.scope, lifecycle.scope)) throw new Error('Video scope mismatch');
        lifecycle.signal.addEventListener('abort', dispose, { once: true });
        lifecycle.registerDisposable('video-metadata-surface', dispose);
        current();
        const snapshot = basic.read();
        current();
        if (!sameScope(snapshot.scope, basic.scope))
          throw new Error('Video snapshot scope mismatch');
        line('h2', 'Video metadata — read-only');
        line(
          'p',
          'No media playback, editing, saving or export. Source bytes are not read or verified.',
        );
        const result = validateVideoContent(snapshot.content);
        if (!result.valid) {
          line('h3', 'First validation failure');
          line('p', result.reason);
        } else {
          const { sequence, sources } = snapshot.content;
          line('p', `Native schema: ${snapshot.content.schema}`);
          line(
            'p',
            `Sequence ${sequence.id}; duration ${seconds(sequence.duration)}; frame rate ${sequence.frameRate.value}/${sequence.frameRate.timescale} fps`,
          );
          line(
            'p',
            `${sequence.tracks.length} tracks; ${sequence.clips.length} clips; ${sources.length} sources`,
          );
          line('h3', 'Timeline — half-open intervals');
          for (const track of sequence.tracks) {
            line(
              'p',
              `Track ${track.id}: ${track.kind}; enabled=${track.enabled}; locked=${track.locked}`,
            );
            for (const clip of sequence.clips.filter((c) => c.trackId === track.id)) {
              line(
                'p',
                `Clip ${clip.id}: ${clip.kind}; [${seconds(clip.start)}, ${seconds(add(clip.start, clip.duration))}); source=${clip.sourceId}/${clip.streamId}; link=${clip.linkGroupId ?? 'none'}`,
              );
              line(
                'p',
                clip.kind === 'video'
                  ? `Source window [${seconds(clip.sourceIn)}, ${seconds(clip.sourceOut)}); rate=${clip.rate.value}/${clip.rate.timescale}`
                  : `Source samples [${clip.sampleIn}, ${clip.sampleOut})`,
              );
            }
          }
          line('h3', 'Declared source metadata — not probed');
          for (const source of sources) {
            line(
              'p',
              `Source ${source.id}; asset=${source.asset.assetId}; bytes=${source.asset.byteLength}; SHA-256=${source.asset.sha256}`,
            );
            for (const stream of source.streams) {
              line(
                'p',
                `Stream ${stream.id}: ${stream.kind}; presentation origin=${seconds(stream.presentationOrigin)}`,
              );
              line(
                'p',
                stream.kind === 'video'
                  ? `PTS [${stream.startPts}, ${stream.endPts}); timebase=${seconds(stream.timebase)}`
                  : `Sample rate=${stream.sampleRate} Hz; sample count=${stream.sampleCount}`,
              );
            }
          }
          line('p', 'Native structure valid; media availability and decodability are not checked.');
        }
        current();
        container.append(root);
        current();
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}
