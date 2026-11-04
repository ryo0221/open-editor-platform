/**
 * The image work a GLB's textures need (issue #663, texture stage 3), in the browser: glTF keeps
 * roughness and metalness in one image (green and blue) and reads normal maps as OpenGL, while a
 * texture set has them as separate images and may hold a DirectX normal map. The pixel work is
 * pure; decoding and PNG encoding use the browser's ImageBitmap and OffscreenCanvas.
 */

import { geometryTextureImageSize, geometryTextureLimits } from '@editor-platform/geometry-core';

/** RGBA pixels, four bytes each, top row first. */
export interface ViewPixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * glTF's metal/roughness pixels: green from `roughness`'s green and blue from `metalness`'s blue
 * (what three.js reads of each map), 255 where a map is not given; red 255 (no occlusion) and
 * opaque. Both are given at the same size.
 */
export function packMetallicRoughnessPixels(
  roughness: ViewPixels | undefined,
  metalness: ViewPixels | undefined,
): ViewPixels {
  const { width, height } = (roughness ?? metalness)!;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = roughness ? roughness.data[i + 1]! : 255;
    data[i + 2] = metalness ? metalness.data[i + 2]! : 255;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

/** A normal map's pixels with green flipped (DirectX ↔ OpenGL), opaque. */
export function flipGreenPixels(normal: ViewPixels): ViewPixels {
  const data = new Uint8ClampedArray(normal.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i + 1] = 255 - data[i + 1]!;
    data[i + 3] = 255;
  }
  return { ...normal, data };
}

/** An image to convert, as the document stores it. */
export interface ViewImageFile {
  bytes: Uint8Array;
  mediaType: string;
}

/**
 * Decodes an image to its stored pixel values (no colour conversion), at a size if given. An
 * image over the import limit (2048 px) is refused from its header before it is decoded, as the
 * view refuses it (Codex).
 */
async function pixelsOf(file: ViewImageFile, size?: [number, number]): Promise<ViewPixels> {
  const header = geometryTextureImageSize(file.bytes);
  const limit = geometryTextureLimits.imagePixels;
  if (!header || Math.max(...header) > limit || Math.min(...header) < 1)
    throw new Error('texture-image-size');
  const image = await createImageBitmap(
    new Blob([file.bytes as BlobPart], { type: file.mediaType }),
    {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    },
  );
  try {
    if (Math.max(image.width, image.height) > limit) throw new Error('texture-image-size');
    const pixels = storedPixels(image);
    return size && (size[0] !== pixels.width || size[1] !== pixels.height)
      ? resizedPixels(pixels, size)
      : pixels;
  } finally {
    image.close();
  }
}

/**
 * An image's stored RGBA values, read back through WebGL without premultiplying: a 2D canvas
 * composites the image and loses the colour under transparent pixels, which the view's maps
 * still read (Codex). Top row first.
 */
function storedPixels(image: ImageBitmap): ViewPixels {
  const { width, height } = image;
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
  if (!gl) throw new Error('texture-image-webgl');
  try {
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const data = new Uint8ClampedArray(width * height * 4);
    // The framebuffer's row 0 is the texture's first row: the image's top row.
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return { data, width, height };
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** Pixels scaled to a size by their nearest stored pixel, so values are kept as stored. */
export function resizedPixels(pixels: ViewPixels, [width, height]: [number, number]): ViewPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(pixels.height - 1, Math.floor(((y + 0.5) * pixels.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(pixels.width - 1, Math.floor(((x + 0.5) * pixels.width) / width));
      const from = (sy * pixels.width + sx) * 4;
      data.set(pixels.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

async function png(pixels: ViewPixels): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(pixels.width, pixels.height);
  const context = canvas.getContext('2d')!;
  context.putImageData(
    new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height),
    0,
    0,
  );
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The browser's image tools for a GLB's textures: each returns a PNG. A metalness map of
 * another size is scaled to the roughness map's.
 */
export const viewTextureImageTools = {
  async packMetallicRoughness(roughness?: ViewImageFile, metalness?: ViewImageFile) {
    const r = roughness && (await pixelsOf(roughness));
    const m = metalness && (await pixelsOf(metalness, r && [r.width, r.height]));
    return png(packMetallicRoughnessPixels(r, m));
  },
  async flipNormalGreen(normal: ViewImageFile) {
    return png(flipGreenPixels(await pixelsOf(normal)));
  },
};

/** Whether this browser has what `viewTextureImageTools` needs. */
export const viewTextureImageToolsAvailable = () =>
  typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
