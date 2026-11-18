import { ccc } from '@ckb-ccc/core'

type Hex = `0x${string}`

/**
 * The price tag on registration (decision 0014). Mirrors `cells-core`, and the two
 * must agree byte for byte: the contract reads what this encodes.
 *
 * The fee schedule in the contract is a ceiling. One on-chain price cell holds a
 * discount factor in basis points that applies to every tier at once; the contract
 * charges `fee x factor / 10 000`, rounding down, and charges the full fee whenever
 * the cell is absent or unreadable. The cell's own type script bounds how the factor
 * may change: a sixteenth per update, one update every six hours, never below the
 * floor. A quarter a day was the first rule; this is the same ceiling on what a stolen
 * key can do in a day, in four moves rather than one, so the keeper can follow the coin.
 */

/** Price cell data: `version (1) ‖ factor (4, little-endian, basis points)`. */
export const PRICE_DATA_VERSION = 1
export const PRICE_DATA_LEN = 5
/** No discount: the schedule as written. */
export const PRICE_FACTOR_MAX = 10_000
/** 63 CKB on the 5+ line, the smallest output the treasury lock can hold. */
export const PRICE_FACTOR_MIN = 126
/** A price cell may change at most once every six hours. */
export const PRICE_COOLDOWN_SECS = 21_600
/** And by at most a sixteenth, either way. */
export const PRICE_STEP_PERCENT = 6.25

/** Encode a factor as price cell data. */
export function priceData(bps: number): Hex {
  if (!Number.isInteger(bps) || bps < PRICE_FACTOR_MIN || bps > PRICE_FACTOR_MAX)
    throw new Error(`cells: a price factor is ${PRICE_FACTOR_MIN} to ${PRICE_FACTOR_MAX} basis points`)
  const b = new Uint8Array(PRICE_DATA_LEN)
  b[0] = PRICE_DATA_VERSION
  b[1] = bps & 0xff
  b[2] = (bps >>> 8) & 0xff
  b[3] = (bps >>> 16) & 0xff
  b[4] = (bps >>> 24) & 0xff
  return ccc.hexFrom(b) as Hex
}

/** The factor a price cell holds, or null when its data is not one (the contract then charges the full price). */
export function parsePriceFactor(data: Hex | string | Uint8Array): number | null {
  const b = ccc.bytesFrom(data)
  if (b.length !== PRICE_DATA_LEN || b[0] !== PRICE_DATA_VERSION) return null
  const bps = (b[1] | (b[2] << 8) | (b[3] << 16) | (b[4] << 24)) >>> 0
  if (bps < PRICE_FACTOR_MIN || bps > PRICE_FACTOR_MAX) return null
  return bps
}

/** A fee in shannons after the factor, exactly as the contract computes it: integer, rounding down. */
export function applyPriceFactor(feeShannons: bigint, bps: number): bigint {
  const f = BigInt(Math.min(Math.max(0, Math.trunc(bps)), PRICE_FACTOR_MAX))
  return (feeShannons * f) / BigInt(PRICE_FACTOR_MAX)
}

/** Within a sixteenth either way: `new x 16` inside `[old x 15, old x 17]`. */
export function priceStepOk(oldBps: number, newBps: number): boolean {
  return newBps * 16 >= oldBps * 15 && newBps * 16 <= oldBps * 17
}

/** The furthest one update may move `current` toward `target`, inside the band. */
export function priceStepToward(current: number, target: number): number {
  const lo = Math.ceil((current * 15) / 16)
  const hi = Math.floor((current * 17) / 16)
  const step = Math.max(lo, Math.min(hi, Math.round(target)))
  return Math.max(PRICE_FACTOR_MIN, Math.min(PRICE_FACTOR_MAX, step))
}

/**
 * The factor that prices a fee of `feeCkb` at about `targetUsd`, given today's rate,
 * clamped to the band. `usdPerCkb` is a display-side number (decision 0009); nothing
 * on chain depends on it, which is the whole point of the design.
 */
export function factorForTarget(feeCkb: number, targetUsd: number, usdPerCkb: number): number {
  if (!(feeCkb > 0) || !(targetUsd > 0) || !(usdPerCkb > 0)) return PRICE_FACTOR_MAX
  const bps = Math.round((targetUsd / (feeCkb * usdPerCkb)) * PRICE_FACTOR_MAX)
  return Math.max(PRICE_FACTOR_MIN, Math.min(PRICE_FACTOR_MAX, bps))
}
