/**
 * The HAT+ ID EEPROM image (PB8): the bytes the Raspberry Pi reads from a HAT+'s EEPROM at
 * boot, in the public format of `raspberrypi/utils` eeptools (format version 2, HAT+). The
 * editor writes the same image `eepmake` makes from a settings file, and the settings file
 * itself, so a board maker can check one against the other. Little-endian throughout:
 *
 * - header (12 bytes): "R-Pi", version 2, reserved 0, atom count (u16), total length (u32);
 * - each atom: type (u16), index (u16), data length + 2 (u32), data, CRC-16 of all of it;
 * - vendor atom (1): UUID as four u32 (least significant first), product ID and version (u16),
 *   the two string lengths (u8) and the strings; device tree atom (3): the overlay's name;
 *   custom atoms (4); power supply atom (6): the current the board supplies, mA (when not 0).
 */

export interface PcbHatEeprom {
  /** The product's UUID, `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`; not all zero. */
  productUuid: string;
  productId: number;
  productVersion: number;
  vendor: string;
  product: string;
  /** The device tree overlay the Pi loads for the board; absent for none. */
  dtOverlay?: string;
  /** Vendor data, each its own atom. */
  custom?: Uint8Array[];
  /** What the board supplies to the Pi, mA; 0 or absent for none. */
  currentSupplyMa?: number;
}

export class PcbHatEepromError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const atomType = { vendor: 1, dt: 3, custom: 4, power: 6 } as const;
/** A 24C32 holds 4 KiB. */
export const hatEepromBytesMax = 4096;

/** CRC-16/ARC (polynomial 0x8005 reflected, start 0), as eeptools checks each atom. */
export function hatEepromCrc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

/**
 * Printable ASCII without `"` or `#`, not empty: eepmake drops each line from its first `#` (a comment, even
 * inside quotes) and reads a quoted string up to the first `"`, so a name with either would not
 * give the same image from the settings file.
 */
const ascii = (s: string, what: string) => {
  // At least one character: eepmake's `%255[^"]` reads nothing from `""`.
  if (!/^[\x20\x21\x24-\x7e]+$/.test(s) || s.length > 255) throw new PcbHatEepromError(what);
  return new TextEncoder().encode(s);
};

function uuidWords(uuid: string): number[] {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(uuid);
  if (!m) throw new PcbHatEepromError('uuid');
  const hex = m.slice(1).join('');
  // serial[3] is the most significant word.
  const words = [0, 1, 2, 3].map((i) => Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16));
  if (words.every((w) => w === 0)) throw new PcbHatEepromError('uuid');
  return words.reverse();
}

const u16 = (v: number, what: string) => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new PcbHatEepromError(what);
  return v;
};

/** The EEPROM image; throws `PcbHatEepromError` naming a bad field. */
export function hatEepromImage(spec: PcbHatEeprom): Uint8Array {
  const vendor = ascii(spec.vendor, 'vendor');
  const product = ascii(spec.product, 'product');
  const serial = uuidWords(spec.productUuid);
  const vinf = new Uint8Array(22 + vendor.length + product.length);
  const v = new DataView(vinf.buffer);
  serial.forEach((w, i) => v.setUint32(i * 4, w, true));
  v.setUint16(16, u16(spec.productId, 'productId'), true);
  v.setUint16(18, u16(spec.productVersion, 'productVersion'), true);
  v.setUint8(20, vendor.length);
  v.setUint8(21, product.length);
  vinf.set(vendor, 22);
  vinf.set(product, 22 + vendor.length);
  const atoms: [number, Uint8Array][] = [[atomType.vendor, vinf]];
  if (spec.dtOverlay !== undefined) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(spec.dtOverlay)) throw new PcbHatEepromError('dtOverlay');
    atoms.push([atomType.dt, ascii(spec.dtOverlay, 'dtOverlay')]);
  }
  for (const c of spec.custom ?? []) atoms.push([atomType.custom, c]);
  const current = spec.currentSupplyMa ?? 0;
  if (!Number.isInteger(current) || current < 0 || current > 0xffffffff)
    throw new PcbHatEepromError('currentSupplyMa');
  if (current) {
    const p = new Uint8Array(4);
    new DataView(p.buffer).setUint32(0, current, true);
    atoms.push([atomType.power, p]);
  }
  const length = 12 + atoms.reduce((n, [, d]) => n + 10 + d.length, 0);
  if (length > hatEepromBytesMax) throw new PcbHatEepromError('too-large');
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x2d, 0x50, 0x69], 0);
  view.setUint8(4, 2);
  view.setUint8(5, 0);
  view.setUint16(6, atoms.length, true);
  view.setUint32(8, length, true);
  let at = 12;
  atoms.forEach(([type, data], i) => {
    const start = at;
    view.setUint16(at, type, true);
    view.setUint16(at + 2, i, true);
    view.setUint32(at + 4, data.length + 2, true);
    out.set(data, at + 8);
    at += 8 + data.length;
    view.setUint16(at, hatEepromCrc16(out.subarray(start, at)), true);
    at += 2;
  });
  return out;
}

/** One atom read back: its type, index, data and whether its CRC holds. */
export interface PcbHatEepromAtom {
  type: number;
  index: number;
  data: Uint8Array;
  crcOk: boolean;
}

/** Reads an image back (the checks `eepdump` makes); throws `PcbHatEepromError` when malformed. */
export function readHatEepromImage(bytes: Uint8Array): {
  version: number;
  atoms: PcbHatEepromAtom[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'R-Pi')
    throw new PcbHatEepromError('signature');
  if (view.getUint32(8, true) !== bytes.length) throw new PcbHatEepromError('length');
  const count = view.getUint16(6, true);
  const atoms: PcbHatEepromAtom[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    if (at + 10 > bytes.length) throw new PcbHatEepromError('atom');
    const dlen = view.getUint32(at + 4, true);
    const end = at + 8 + dlen;
    if (dlen < 2 || end > bytes.length) throw new PcbHatEepromError('atom');
    atoms.push({
      type: view.getUint16(at, true),
      index: view.getUint16(at + 2, true),
      data: bytes.slice(at + 8, end - 2),
      crcOk: hatEepromCrc16(bytes.subarray(at, end - 2)) === view.getUint16(end - 2, true),
    });
    at = end;
  }
  if (at !== bytes.length) throw new PcbHatEepromError('length');
  return { version: view.getUint8(4), atoms };
}

/** The same content as an `eepmake` settings file (HAT+ format); throws as `hatEepromImage`. */
export function hatEepromSettings(spec: PcbHatEeprom): string {
  // The same checks as the image, so the two never say different things.
  hatEepromImage(spec);
  const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`;
  const lines = [
    '# HAT+ EEPROM settings (eepmake, format version 2), written by the PCB editor',
    `product_uuid ${spec.productUuid.toLowerCase()}`,
    `product_id ${hex(spec.productId)}`,
    `product_ver ${hex(spec.productVersion)}`,
    `vendor "${spec.vendor}"`,
    `product "${spec.product}"`,
    `current_supply ${spec.currentSupplyMa ?? 0}`,
  ];
  if (spec.dtOverlay !== undefined) lines.push(`dt_blob "${spec.dtOverlay}"`);
  for (const c of spec.custom ?? [])
    lines.push('custom_data', [...c].map((b) => b.toString(16).padStart(2, '0')).join(' '), 'end');
  return `${lines.join('\n')}\n`;
}

/** F76's EEPROM: this example's own vendor and product, no overlay of its own. */
export function f76HatEeprom(): PcbHatEeprom {
  return {
    productUuid: '6e2f4c1a-8b3d-4f5e-9a71-0c2d4e6f8a10',
    productId: 0x0001,
    productVersion: 0x0001,
    vendor: 'Editor Platform example',
    product: 'Sensor HAT+ (F76)',
    currentSupplyMa: 0,
  };
}
