import { ccc } from '@ckb-ccc/core'
import { stripInvisible } from './profile.ts'

/**
 * A meal: a payment made to a name, saying which name it was for and, if the payer
 * wants, a note. It is what feeds the being of a name held as a deed.
 *
 * A payment on its own cannot say that. The address a name publishes is often its
 * owner's everyday wallet, and on testnet 43 names shared 6 addresses (measured
 * 2026-09-26), so counting every transfer into the address would put the owner's whole
 * income on the name's page and give each name its neighbours' payments. Only a payment
 * that carries this witness is a meal, and only for the name it names.
 *
 * The payload is an extra witness, after the inputs' own. Witness 0 is the payer's lock,
 * and its `output_type` is not free: a JoyID sub key keeps its unlock proof there, and
 * the JoyID signer skips adding that proof when the field is already set.
 */

const MEAL_TAG = 'cells:meal:1'

/** A note is one line, cut to this many characters. */
export const NOTE_MAX = 80

export interface Meal {
  /** The name the payment was for, with `.cell`. */
  to: string
  /** What the payer said with it, cleaned; empty when nothing was said. */
  note: string
}

// A name as the payload carries it: labels of letters, digits and hyphens, joined by
// dots for a sub-name, ending in .cell. Anything else is not a meal for a name.
const NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.cell$/

/**
 * A note as it can be shown: every invisible or direction-changing character a space
 * (profile.ts, `stripInvisible`), spaces collapsed, at most `NOTE_MAX` characters
 * counted as a reader counts them. Applied when writing and again when reading,
 * because a transaction can be built by anyone.
 */
export function cleanNote(s: string): string {
  const flat = stripInvisible(s, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(flat)
  return chars.length > NOTE_MAX ? chars.slice(0, NOTE_MAX).join('').trimEnd() : flat
}

/** The witness bytes of a meal: the tag, a zero, then `{ to, note }` as JSON. */
export function mealWitness(meal: Meal): ccc.Hex {
  const note = cleanNote(meal.note)
  const body = JSON.stringify(note ? { to: meal.to, note } : { to: meal.to })
  return ccc.hexFrom(ccc.bytesConcat(ccc.bytesFrom(MEAL_TAG, 'utf8'), new Uint8Array([0]), ccc.bytesFrom(body, 'utf8')))
}

export function parseMealWitness(data: string): Meal | null {
  let b: Uint8Array
  try {
    b = ccc.bytesFrom(data)
  } catch {
    return null
  }
  const tag = ccc.bytesFrom(MEAL_TAG, 'utf8')
  if (b.length < tag.length + 2) return null
  for (let i = 0; i < tag.length; i++) if (b[i] !== tag[i]) return null
  if (b[tag.length] !== 0) return null
  try {
    const j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b.slice(tag.length + 1))) as unknown
    if (!j || typeof j !== 'object') return null
    const { to, note } = j as { to?: unknown; note?: unknown }
    if (typeof to !== 'string' || !NAME.test(to)) return null
    if (note !== undefined && typeof note !== 'string') return null
    return { to, note: cleanNote(note ?? '') }
  } catch {
    return null
  }
}

/** The meal a transaction carries, if any of its witnesses is one. */
export function mealIn(witnesses: readonly string[]): Meal | null {
  for (const w of witnesses) {
    const m = parseMealWitness(w)
    if (m) return m
  }
  return null
}

/**
 * Put a meal on a payment. Call it once the inputs are chosen and before the fee is
 * completed, so the fee pays for the bytes (the order that bit both DOB Studio and this
 * project when a payload went in after the fee).
 *
 * The meal goes after the witnesses of the inputs chosen so far. If completing the fee
 * then adds an input, the meal becomes the witness slot of that input, which belongs to
 * the payer's own lock group: the lock reads the group's first witness and only hashes
 * the others, so the meal is still signed and still found.
 */
export function addMeal(tx: ccc.Transaction, meal: Meal): void {
  if (tx.inputs.length === 0) throw new Error('cells: add the meal once the inputs are chosen')
  while (tx.witnesses.length < tx.inputs.length) tx.witnesses.push('0x')
  tx.witnesses.push(mealWitness(meal))
}
