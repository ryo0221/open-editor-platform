/** Read only a bounded moov box, skipping media payload by declared file offsets. */
export async function metadataBlob(source: Blob, signal: AbortSignal): Promise<Blob> {
  let offset = 0,
    boxes = 0,
    selected: Blob | undefined;
  while (offset < source.size) {
    signal.throwIfAborted();
    if (++boxes > 10000 || offset + 8 > source.size) throw Error('MP4 root bounds');
    const head = new Uint8Array(await source.slice(offset, offset + 16).arrayBuffer());
    signal.throwIfAborted();
    const view = new DataView(head.buffer),
      type = String.fromCharCode(...head.slice(4, 8));
    let size = view.getUint32(0);
    if (size === 1) {
      if (head.length < 16) throw Error('MP4 extended header');
      const large = view.getBigUint64(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('MP4 size overflow');
      size = Number(large);
    }
    if (size === 0) size = source.size - offset;
    if (size < 8 || offset + size > source.size) throw Error('MP4 root size');
    if (!['ftyp', 'wide', 'free', 'mdat', 'moov'].includes(type))
      throw Error('Unsupported/fragmented MP4 root declaration: ' + type);
    if (type === 'moov') {
      if (selected || size > 8 * 1024 * 1024 || view.getUint32(0) === 1)
        throw Error('MP4 metadata quota/profile');
      selected = source.slice(offset, offset + size);
    }
    offset += size;
  }
  if (!selected) throw Error('Missing moov');
  return selected;
}
