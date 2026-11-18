/**
 * The pattern a name draws for itself, from its own account id.
 *
 * A name that publishes no picture is not blank: it shows a shape worked out from the id
 * the chain already gave it. Nothing is fetched, nothing is stored, and two people looking
 * at the same name see the same thing, because the id is the only input.
 *
 * The square mark (`ui/src/Mark.tsx`, and again in the resolver) has always done this. The
 * band across the top of a page now does it too, and the geometry lives here so the app and
 * the resolver draw from one description instead of two that drift.
 */

/** The default pair: lime on dark olive, the same one the mark uses. */
export const MARK_INK = '#cbf34d'
export const MARK_TILE = '#2b3512'

/** A bar of the generated band, in the box it was asked for. */
export interface CoverBar {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Fourteen bars, mirrored down the middle, each hanging from the top or standing on the
 * bottom. Seven of the id's hex digits choose the heights and seven bits choose the
 * directions: 16^7 x 2^7, about 34 billion bands.
 *
 * Fewer and wider than the first attempt, which used twenty-four. Two dozen thin bars
 * filled the band and every name came out looking like the same equaliser; an identicon is
 * only recognisable if its features are large enough to be a silhouette. The directions do
 * the rest of that work: a column that drops from the top is the difference between two
 * skylines that would otherwise be a similar row of heights.
 *
 * The mirror is the square mark's own idea, and it is what keeps this composed rather than
 * random. The digits are taken from further along the id than the mark's (which uses the
 * first seventeen), so a name's band and its mark are not two drawings of one number: they
 * are two parts of one identity that happen to share a source.
 */
const COLS = 14
const HALF = COLS / 2
/** Where the band's digits start, past the seventeen the square mark consumes. */
const OFFSET = 17

export function coverBars(id: string, width: number, height: number): CoverBar[] {
  const hex = id.replace(/^0x/, '')
  const len = Math.max(hex.length, 1)
  const digit = (i: number) => parseInt(hex[(OFFSET + i) % len] ?? '0', 16) || 0
  // The direction bits come from digits further on again, so height and direction are not
  // the same number read twice: a tall column would always fall the same way.
  const down = (i: number) => (digit(HALF + 1 + i) & 1) === 1

  const pad = height * 0.1
  const inner = height - pad * 2
  const slot = width / COLS
  const gap = slot * 0.22
  const w = slot - gap
  const bars: CoverBar[] = []
  for (let col = 0; col < COLS; col++) {
    // Column 7 mirrors 6, 8 mirrors 5, and so on, so the band is symmetric.
    const src = col < HALF ? col : COLS - 1 - col
    // Never nothing and never the whole height: a bar at either extreme reads as a glitch
    // rather than as a choice, and full-height bars would close the band into a block.
    const h = inner * (0.15 + (digit(src) / 15) * 0.75)
    bars.push({ x: col * slot + gap / 2, y: down(src) ? pad : height - pad - h, w, h })
  }
  return bars
}
