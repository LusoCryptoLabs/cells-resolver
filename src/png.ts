import { deflateSync, crc32 } from 'node:zlib'

/**
 * A minimal PNG writer, for the one image this service has to draw itself.
 *
 * A name that publishes no picture still needs a shareable image, because a link preview
 * with an empty square is worse than no preview. The mark is drawn from the account id,
 * so it can be rendered here, but it has to be a raster: link crawlers do not accept SVG
 * for `og:image`, which is exactly the case the mark covers.
 *
 * Written out rather than pulled in. The whole need is "flat colour blocks on a tile",
 * which is a few hundred bytes of zlib and CRC, both of which node already has. A PNG
 * library would be a dependency, a supply chain and an update treadmill for this.
 */

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed) >>> 0)
  return Buffer.concat([len, typed, crc])
}

/**
 * Encode 8-bit truecolour pixels. `px` is width*height*3 bytes, row-major RGB.
 *
 * Every scanline is prefixed with filter type 0 (none), which the format requires and
 * which costs nothing here: flat blocks deflate well without a predictor.
 */
export function encodePng(px: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const src = y * width * 3
    const dst = y * (1 + width * 3)
    raw[dst] = 0
    Buffer.from(px.buffer, px.byteOffset + src, width * 3).copy(raw, dst + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Fill a rectangle in an RGB buffer, clipped to the canvas. */
export function fillRect(
  px: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  [r, g, b]: [number, number, number],
): void {
  const xs = Math.max(0, Math.round(x0))
  const ys = Math.max(0, Math.round(y0))
  const xe = Math.min(width, Math.round(x0 + w))
  const ye = Math.min(height, Math.round(y0 + h))
  for (let y = ys; y < ye; y++) {
    let i = (y * width + xs) * 3
    for (let x = xs; x < xe; x++) {
      px[i++] = r
      px[i++] = g
      px[i++] = b
    }
  }
}

/** `#rrggbb` to a triple. */
export function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
