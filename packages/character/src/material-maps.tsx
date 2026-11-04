import { useRef } from 'react';
import type { CharacterAssetRef, CharacterMaterial } from '@editor-platform/character-core';

/**
 * C4c: a part's materials with their colour image. An image is chosen from a PNG or JPEG file
 * (its bytes go to the Host first) and drawn with the part's UVs; "Remove image" clears it.
 */
export function MaterialMaps({
  materials,
  assets,
  editable,
  busy,
  onImage,
  onClear,
}: {
  materials: readonly CharacterMaterial[];
  assets: readonly CharacterAssetRef[];
  /** False when read-only or the Host keeps no new assets. */
  editable: boolean;
  busy: boolean;
  onImage(materialId: string, file: File): void;
  onClear(materialId: string): void;
}) {
  return (
    <ul className="character-materials" aria-label="Materials">
      {materials.map((m) => (
        <MaterialRow
          key={m.id}
          material={m}
          image={assets.find((a) => a.id === m.maps.color)}
          editable={editable}
          busy={busy}
          onImage={onImage}
          onClear={onClear}
        />
      ))}
    </ul>
  );
}

function MaterialRow({
  material: m,
  image,
  editable,
  busy,
  onImage,
  onClear,
}: {
  material: CharacterMaterial;
  image: CharacterAssetRef | undefined;
  editable: boolean;
  busy: boolean;
  onImage(materialId: string, file: File): void;
  onClear(materialId: string): void;
}) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <li>
      <span className="character-swatch" style={{ background: m.color }} aria-hidden="true" />
      <span className="character-material-name">{m.name}</span>
      <span className="character-material-image" data-testid={`material-image-${m.id}`}>
        {image
          ? `${image.kind === 'texture-png' ? 'PNG' : 'JPEG'} image · ${kib(image.byteLength)}`
          : 'No image'}
      </span>
      {editable && (
        <span className="character-material-actions">
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg"
            hidden
            aria-label={`Color image for ${m.name}`}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onImage(m.id, f);
            }}
          />
          <button type="button" disabled={busy} onClick={() => file.current?.click()}>
            {image ? 'Replace image' : 'Add image'}
          </button>
          {image && (
            <button type="button" disabled={busy} onClick={() => onClear(m.id)}>
              Remove image
            </button>
          )}
        </span>
      )}
    </li>
  );
}

const kib = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);
