import { f75Pi5Board, pcbDefaultNetClass } from './fixtures';
import { generateFootprint } from './generators';
import { pcbGpioPin } from './hat';
import type { PcbComponent, PcbDocument, PcbFootprint, PcbNet, PcbTrack, Vec2 } from './model';

/**
 * F75 with its parts (PB8): the Raspberry Pi 5 form factor with the connectors where the public
 * mechanical drawing (RP-008347-DS-1, reference only) puts them, and the main ICs where product
 * photos show them, as a visual reference only (their sizes are this editor's generic shapes).
 * The only nets are the 40-pin header's public pinout: ground joined by an inner plane, the two
 * 3V3 pins and the two 5V pins joined by short inner tracks, every GPIO a one-pin net. The Pi's
 * own circuit and routing are not public and are not drawn.
 */

/** The 40-pin header's public pinout: pin → net name. */
export const pcbGpioPinout: readonly string[] = [
  '3V3', '5V', 'GPIO2', '5V', 'GPIO3', 'GND', 'GPIO4', 'GPIO14', 'GND', 'GPIO15',
  'GPIO17', 'GPIO18', 'GPIO27', 'GND', 'GPIO22', 'GPIO23', '3V3', 'GPIO24', 'GPIO10', 'GND',
  'GPIO9', 'GPIO25', 'GPIO11', 'GPIO8', 'GND', 'GPIO7', 'ID_SD', 'ID_SC', 'GPIO5', 'GND',
  'GPIO6', 'GPIO12', 'GPIO13', 'GND', 'GPIO19', 'GPIO16', 'GPIO26', 'GPIO20', 'GND', 'GPIO21',
]; // prettier-ignore

/** How far the right-edge connectors' mating faces sit inside the edge (their flanges fit). */
const rightFace = 85 - 2.3;

export function f75Pi5Example(): PcbDocument {
  const base = f75Pi5Board();
  const footprints: PcbFootprint[] = [
    generateFootprint('fp-gpio', 'pin-header', { rows: 2, pinsPerRow: 20 }),
    generateFootprint('fp-usb-c', 'usb-c'),
    generateFootprint('fp-micro-hdmi', 'micro-hdmi'),
    generateFootprint('fp-usb-a', 'usb-a-stack'),
    generateFootprint('fp-rj45', 'rj45'),
    generateFootprint('fp-fpc22', 'fpc', { pins: 22 }),
    generateFootprint('fp-fpc16', 'fpc', { pins: 16 }),
    generateFootprint('fp-fan', 'jst-sh', { pins: 4 }),
    generateFootprint('fp-soc', 'bga', {
      rows: 16,
      cols: 16,
      pitch: 0.8,
      ball: 0.4,
      bodyX: 15,
      bodyY: 15,
      height: 1.4,
    }),
    generateFootprint('fp-ram', 'bga', {
      rows: 12,
      cols: 8,
      pitch: 0.8,
      ball: 0.35,
      bodyX: 10,
      bodyY: 14.5,
      height: 1.0,
    }),
    generateFootprint('fp-rp1', 'qfn', {
      size: 7,
      pinsPerSide: 12,
      pitch: 0.4,
      padLength: 0.6,
      exposedPad: 5,
      height: 0.9,
    }),
    generateFootprint('fp-pmic', 'qfn', { size: 5, pinsPerSide: 8, height: 0.9 }),
  ];
  const part = (
    id: string,
    ref: string,
    value: string,
    footprint: string,
    at: Vec2,
    rotationDeg = 0,
  ): PcbComponent => ({ id, ref, value, footprint, at, rotationDeg, side: 'top', locked: false });
  const components: PcbComponent[] = [
    part('j8', 'J8', 'GPIO 2×20', 'fp-gpio', pcbGpioPin(1)),
    // Bottom edge: power and the two displays.
    part('j-usbc', 'J1', 'USB-C power', 'fp-usb-c', [11.2, 0.3]),
    part('j-hdmi0', 'J2', 'Micro HDMI 0', 'fp-micro-hdmi', [25.8, 0.3]),
    part('j-hdmi1', 'J3', 'Micro HDMI 1', 'fp-micro-hdmi', [39.2, 0.3]),
    // Right edge: Ethernet, USB 3.0 and USB 2.0, their faces off the board.
    part('j-rj45', 'J4', 'Ethernet', 'fp-rj45', [rightFace, 10.2], 90),
    part('j-usb3', 'J5', 'USB 3.0 ×2', 'fp-usb-a', [rightFace, 29.1], 90),
    part('j-usb2', 'J6', 'USB 2.0 ×2', 'fp-usb-a', [rightFace, 47], 90),
    // Camera/display flex connectors, PCIe flex on the left edge, fan header (visual reference).
    part('j-cam0', 'J7', 'MIPI 0', 'fp-fpc22', [50, 12], 90),
    part('j-cam1', 'J9', 'MIPI 1', 'fp-fpc22', [56, 12], 90),
    part('j-pcie', 'J10', 'PCIe', 'fp-fpc16', [0.6, 30], 270),
    part('j-fan', 'J11', 'Fan', 'fp-fan', [60, 44]),
    // Main ICs (visual reference only: places from photos, generic sizes).
    part('u-soc', 'U1', 'SoC (visual reference)', 'fp-soc', [30, 30]),
    part('u-ram', 'U2', 'Memory (visual reference)', 'fp-ram', [12, 30]),
    part('u-rp1', 'U3', 'I/O controller (visual reference)', 'fp-rp1', [60, 27]),
    part('u-pmic', 'U4', 'Power management (visual reference)', 'fp-pmic', [20, 13]),
  ];
  const byName = new Map<string, [string, string][]>();
  pcbGpioPinout.forEach((name, i) => {
    const pins = byName.get(name) ?? [];
    pins.push(['j8', String(i + 1)]);
    byName.set(name, pins);
  });
  const nets: PcbNet[] = [...byName].map(([name, pins]) => ({
    id: `n-${name.toLowerCase().replace(/_/g, '-')}`,
    name,
    class: 'nc-default',
    pins,
  }));
  const track = (id: string, net: string, from: Vec2, to: Vec2): PcbTrack => ({
    id,
    net,
    layer: 'In2.Cu',
    widthMm: 0.4,
    from,
    to,
  });
  // Pins 1 and 17 (3V3) under the odd row; pins 2 and 4 (5V) along the edge row.
  const tracks: PcbTrack[] = [
    track('t-3v3-1', 'n-3v3', pcbGpioPin(1), [8.37, 49.6]),
    track('t-3v3-2', 'n-3v3', [8.37, 49.6], [28.69, 49.6]),
    track('t-3v3-3', 'n-3v3', [28.69, 49.6], pcbGpioPin(17)),
    track('t-5v-1', 'n-5v', pcbGpioPin(2), pcbGpioPin(4)),
  ];
  return {
    ...base,
    footprints,
    components,
    netClasses: [pcbDefaultNetClass()],
    nets,
    tracks,
    zones: [
      {
        id: 'z-gnd',
        net: 'n-gnd',
        layer: 'In1.Cu',
        outline: base.board.outline,
        priority: 0,
        clearanceMm: 0.25,
        padConnection: 'thermal',
        thermalGapMm: 0.3,
        spokeWidthMm: 0.3,
      },
    ],
  };
}
