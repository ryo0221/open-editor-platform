import { useState } from 'react';
import { type Bounds } from '@editor-platform/editor-core';
export function downloadSvg(name: string, svg: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function downloadPng(
  name: string,
  svg: string,
  width: number,
  height: number,
): Promise<void> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Image export failed'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Image export failed'))),
        'image/png',
      ),
    );
    const download = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = download;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(download), 1000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
export function PropertyFields({
  bounds,
  onChange,
}: {
  bounds: Bounds;
  onChange: (patch: Partial<Bounds>) => void;
}) {
  return (
    <div className="geometry-fields">
      {(['x', 'y', 'width', 'height'] as const).map((key) => (
        <label key={key}>
          {key}
          <input
            aria-label={`Element ${key}`}
            type="number"
            value={Math.round(bounds[key])}
            min={key === 'width' || key === 'height' ? 20 : undefined}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value))
                onChange({
                  [key]: key === 'width' || key === 'height' ? Math.max(20, value) : value,
                });
            }}
          />
        </label>
      ))}
    </div>
  );
}
export const sampleImage =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220"><rect width="320" height="220" viewBox="0 0 320 220" fill="#e6e5d5"/><circle cx="230" cy="70" r="35" fill="#d7ab68"/><path d="M0 220 L110 70 L220 220Z" fill="#567966"/><path d="M120 220 L230 115 L320 220Z" fill="#8ea18b"/></svg>',
  );
export function ImageProperty({
  value,
  onChange,
}: {
  value: string;
  onChange: (src: string) => void;
}) {
  const [error, setError] = useState('');
  return (
    <label className="image-property">
      Image asset
      <input
        aria-label="Canvas image file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > 8_000_000) {
            setError('Use an image smaller than 8 MB');
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            setError('');
            onChange(String(reader.result));
          };
          reader.readAsDataURL(file);
        }}
      />
      {value && <img src={value} alt="Selected image asset" />}
      {error && <small role="alert">{error}</small>}
    </label>
  );
}
