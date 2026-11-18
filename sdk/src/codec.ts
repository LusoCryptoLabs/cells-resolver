// Cells wire codec, the TypeScript mirror of `crates/cells-core`.
//
// This is the single place the SDK encodes/decodes AccountCell bytes. It is
// drift-checked against real Rust-built, on-chain bytes in `test/codec.test.ts`,
// so the browser/Node read+write path and the contract can never disagree.
import { ccc } from '@ckb-ccc/core'

export type Hex = string

// --- AccountCell.data fixed layout, v3 (decision 0015) ------------------------
//
// Mirrors cells-core exactly. One layout with a version byte first; the id is not
// stored (it is `blake2b(label)[..20]`); owner, manager and the namespace are the
// first twenty bytes of the hashes they name; the witness hash stays at thirty-two;
// the expiry takes five bytes. The manager is always present and equals the owner
// when the name is not delegated.
export const VERSION_V3 = 0x03
export const ID_LEN = 20
/** An owner or manager identity: the first twenty bytes of a lock-script hash. */
export const OWNER_HASH_LEN = 20
/** The namespace in the type script's args: the first twenty bytes of the genesis token's type hash. */
export const NAMESPACE_LEN = 20
export const EXPIRY_LEN = 5
export const MAX_EXPIRED_AT = 2 ** 40 - 1
export const OFF_VERSION = 0 //        [0]
export const OFF_WITNESS_HASH = 1 //   [1..33]
export const OFF_NEXT = 33 //          [33..53]
export const OFF_EXPIRED_AT = 53 //    [53..58]
export const OFF_OWNER = 58 //         [58..78]
export const OFF_MANAGER = 78 //       [78..98]
export const OFF_ACCOUNT = 98 //       [98..]
export const DATA_HEADER_LEN = OFF_ACCOUNT

export const ROOT_ID: Hex = '0x' + '00'.repeat(ID_LEN)
export const ROOT_OWNER: Hex = '0x' + '00'.repeat(OWNER_HASH_LEN)

/**
 * The identity a lock hash is stored as: its first twenty bytes. Every comparison
 * between a name's owner or manager and a wallet's `script.hash()` must go through
 * this on the wallet side, or it is comparing twenty bytes to thirty-two and is
 * silently false. Accepts a value that is already an identity.
 */
export function ownerId(lockHash: Hex): Hex {
  const b = ccc.bytesFrom(lockHash)
  if (b.length !== 32 && b.length !== OWNER_HASH_LEN)
    throw new Error(`cells: an identity is 20 bytes or a 32-byte lock hash, got ${b.length}`)
  return ccc.hexFrom(b.slice(0, OWNER_HASH_LEN))
}

/** The namespace as the type script carries it: the first twenty bytes of the token's type hash. */
export function namespaceArgs(configTypeHash: Hex): Hex {
  const b = ccc.bytesFrom(configTypeHash)
  if (b.length !== 32 && b.length !== NAMESPACE_LEN)
    throw new Error(`cells: a namespace is 20 bytes or a 32-byte type hash, got ${b.length}`)
  return ccc.hexFrom(b.slice(0, NAMESPACE_LEN))
}

export interface RecordEntry {
  key: string // dotted key, e.g. "address.60"
  label: string
  value: Hex // raw bytes (0x…), e.g. a 20-byte address
  ttl: number
}
export interface WitnessData {
  records: RecordEntry[]
}

export interface Account {
  name: string // "alice.cell"
  label: string // "alice"
  id: Hex
  next: Hex
  expiredAt: number // unix seconds
  ownerLockHash: Hex // the owner identity: the first twenty bytes of a lock hash (see ownerId)
  managerLockHash: Hex // a delegate that may edit records; equal to the owner when undelegated
  witnessHash: Hex
  records: RecordEntry[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const u8 = (h: Hex) => ccc.bytesFrom(h)
const hx = (b: Uint8Array) => ccc.hexFrom(b)

/** `id = ckb-blake2b(label)[0..20]` (the type script's `account_id`). */
export function accountId(label: string): Hex {
  return ccc.hashCkb(enc.encode(label)).slice(0, 2 + ID_LEN * 2)
}

/** Max label length (bytes == chars; the charset is ASCII). */
export const MAX_LABEL_LEN = 40

/**
 * Registrable-label rule, mirroring the on-chain `validate_label`: 1..=40 chars,
 * charset `[a-z0-9-]`, no leading/trailing hyphen. The contract enforces this too;
 * this is just so clients reject early with the same verdict.
 */
export function isValidLabel(label: string): boolean {
  if (label.length === 0 || label.length > MAX_LABEL_LEN) return false
  // Dot-separated parts (decision 0008): a plain name is the one-part case.
  const parts = label.split('.')
  // One level of nesting only: `shop.telmo` yes, `a.shop.telmo` no.
  if (parts.length > MAX_LABEL_DEPTH) return false
  return parts.every((p) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p))
}

/** How many dot-separated parts a name may have: `telmo` or `shop.telmo`, no more. */
export const MAX_LABEL_DEPTH = 2

/**
 * Why `label` cannot be registered, in words the person who typed it can act on,
 * or null if it can.
 *
 * `isValidLabel` answers yes or no, which is all the contract needs. A person needs
 * to know which character is the problem, so this walks the same rules in the same
 * order and names the one that failed. Three screens used to each recite the whole
 * rule instead, in three different and partly untrue wordings.
 */
export function whyInvalid(label: string): string | null {
  if (label.length === 0) return 'Type a name.'
  if (label.length > MAX_LABEL_LEN)
    return `A name can be ${MAX_LABEL_LEN} characters at most, and this one is ${label.length}.`

  const parts = label.split('.')
  if (parts.length > MAX_LABEL_DEPTH)
    return 'Names go only one level deep: shop.alice, not desk.shop.alice.'
  if (parts.length === MAX_LABEL_DEPTH) {
    if (parts[0] === '') return 'A name cannot start with a dot.'
    if (parts[1] === '') return 'A name cannot end with a dot.'
  }

  for (const part of parts) {
    if (part.startsWith('-') || part.endsWith('-'))
      return 'A name cannot start or end with a hyphen.'
    // Name the first character that is not allowed, rather than reciting the charset
    // and leaving them to find it. A space is worth saying out loud: it is the one
    // people type on purpose, and it is invisible in the field.
    const bad = [...part].find((c) => !/[a-z0-9-]/.test(c))
    if (bad !== undefined) {
      if (bad === ' ') return 'A name cannot contain a space. Try a hyphen instead.'
      if (/[A-Z]/.test(bad)) return `Names are all lowercase, so use ${label.toLowerCase()}.`
      return `A name cannot contain "${bad}". Lowercase letters, numbers and hyphens only.`
    }
  }
  return null
}

/**
 * The parent of a sub-name: everything after the FIRST dot, or null for a plain
 * name. `shop.telmo` -> `telmo`.
 *
 * It peels one level from anything, including a label `isValidLabel` refuses. The
 * depth rule lives in one place rather than smeared across every helper.
 */
export function parentLabel(label: string): string | null {
  const i = label.indexOf('.')
  return i === -1 ? null : label.slice(i + 1)
}

/**
 * Minimum CKB a new name must lock, mirrors the on-chain `price_floor`. **Flat.**
 * The CKB is refundable rent, reclaimed on recycle, so a graduated deposit deterred
 * nothing; `registrationFeeCkb` is the part that does not come back, and it still
 * slopes by length.
 */
export function priceFloorCkb(_label: string): number {
  return 240
}

/**
 * The least capacity an AccountCell can hold, by CKB's own rule that a cell must
 * contain its own size: the 8-byte capacity field, the lock (32 + 1 + args), the type
 * (32 + 1 + the 32-byte namespace id), and the data.
 *
 * Sized for a v2 cell by default, which is what a name needs to be delegated later
 * without a top-up. Pass `v2: false` for the bare v1 minimum.
 */
export function minAccountCellCkb(label: string, opts: { lockArgsLen?: number } = {}): number {
  return 8 + (32 + 1 + (opts.lockArgsLen ?? 0)) + (32 + 1 + NAMESPACE_LEN) + DATA_HEADER_LEN + label.length
}

/**
 * What a registration has to fund. The protocol floor and CKB's own minimum are two
 * separate rules and BOTH apply, so this takes whichever is larger.
 *
 * They crossed once: the old graduated floor returned 250 CKB for a label of 33
 * characters or more while consensus wanted 251, so the contract accepted a
 * transaction the node then rejected and those names could not be registered at all.
 * Deriving the number rather than hard-coding it means the layout can grow again
 * without repeating that.
 */
export function registerCapacityCkb(label: string): number {
  return Math.max(priceFloorCkb(label), minAccountCellCkb(label))
}

// --- the term, and what it costs (decision 0009) ---------------------------

/** Seconds in a year as the protocol counts one: 365 days flat, matching the contract. */
export const SECONDS_PER_YEAR = 365 * 86_400

/**
 * How long after expiry a name is still its owner's: **thirty days**.
 *
 * During it the cell is still live, so the name still resolves and anybody may still
 * renew it. What the period buys is only that nobody else may take it. After it, recycling
 * is permissionless and the name is genuinely free.
 *
 * The authority is `GRACE_SECONDS` in `contracts/contracts/account-cell-type/src/main.rs`,
 * which is what the chain enforces; this is a copy for a browser to reason with, and
 * `drift.test.ts` fails if the two ever part company. Saying "free" of a name still in
 * grace would be telling somebody to try to take a name that cannot be taken.
 */
export const GRACE_SECONDS = 30 * 86_400

/**
 * Where a name stands against its expiry: `live` while the term runs, `grace` for the
 * thirty days after it (still the owner's, still resolving, renewable by anyone, not
 * takeable), and `free` once anybody may recycle it.
 *
 * The two boundaries are the chain's and the resolver's, not this file's: a name is live
 * through the very second its term ends, because `/resolve` and `/primary` say `expired`
 * only strictly after it; and it is free from the very second the grace ends, because the
 * contract's recycle check is `since >= expired_at + grace`. `now` is in seconds, as
 * `expiredAt` is.
 */
export type NameState = 'live' | 'grace' | 'free'
export function nameState(expiredAt: number, nowSeconds = Math.floor(Date.now() / 1000)): NameState {
  if (nowSeconds <= expiredAt) return 'live'
  if (nowSeconds >= expiredAt + GRACE_SECONDS) return 'free'
  return 'grace'
}

/**
 * The `since` a recycle must carry, in seconds like `expiredAt`: the contract admits the
 * transaction only when the target input's absolute-timestamp `since` is at least
 * `expired_at + grace` (`require_expired_since` in account-cell-type), and the node holds
 * the transaction until the chain's clock has passed that value. Until 2026-09-26 the
 * client wrote `expired_at` alone, which the contract refuses every time it is asked, so
 * nothing the app built could clear a name.
 */
export function recycleSince(expiredAt: number): number {
  return expiredAt + GRACE_SECONDS
}

/** A name is bought for whole years, at least one and at most ten. */
export const MIN_TERM_YEARS = 1
export const MAX_TERM_YEARS = 10

/**
 * The registration fee in CKB for `years` whole years, mirroring the on-chain
 * `registration_fee`.
 *
 * This is **not** `priceFloorCkb`. That is refundable rent, held in the name's own
 * cell and returned when the name is recycled. This is paid to the treasury and does
 * not come back. Both are due at registration; only this one is due again at renewal.
 */
export function registrationFeeCkb(label: string, years = 1): number {
  // A sub-name is priced from its parent and then divided, mirroring the contract:
  // `shop.telmo` is charged a fifth of `telmo`. The child's own length buys nothing,
  // so `a.telmo` and `warehouse.telmo` cost the same.
  const dot = label.indexOf('.')
  const base = dot === -1 ? label : label.slice(dot + 1)
  const perYear = (() => {
    switch (base.length) {
      case 0:
        throw new Error('cells: an empty label has no price')
      case 1:
        return 500_000
      case 2:
        return 200_000
      case 3:
        return 80_000
      case 4:
        return 20_000
      default:
        return 5_000
    }
  })()
  const full = perYear * billedYears(years)
  // Every figure in the schedule divides by five exactly, so this stays a whole
  // number of CKB and never disagrees with the contract by a shannon.
  return dot === -1 ? full : full / SUBNAME_DIVISOR
}

/** What a sub-name's fee is divided by, mirroring `SUBNAME_DIVISOR` in cells-core. */
export const SUBNAME_DIVISOR = 5

/** One year in every five is free, mirroring `YEARS_PER_FREE_YEAR` in cells-core. */
export const YEARS_PER_FREE_YEAR = 5

/**
 * Whole years actually charged for a term of `years`: ten are billed as eight.
 *
 * Four years and five cost the same, and so do nine and ten. At the step there is
 * never a reason to buy the shorter term, which is the point of offering the longer.
 */
export function billedYears(years: number): number {
  return years - Math.floor(years / YEARS_PER_FREE_YEAR)
}

/** The inviter's share of a registration fee, in percent (decision 0011). */
export const REFERRAL_PERCENT = 10

/**
 * What an inviter earns on a registration, mirroring `referral_cut` in cells-core.
 *
 * It comes off the treasury's share, not on top of the price: a name costs the buyer
 * the same whether anyone invited them or not.
 */
export function referralCutCkb(label: string, years = 1): number {
  return (registrationFeeCkb(label, years) / 100) * REFERRAL_PERCENT
}

/**
 * The protocol's share of a sale, in percent (decision 0012).
 *
 * One since 2026-09-14, lowered from ten. This must equal `SALE_FEE_PERCENT` in
 * cells-core, because the contract enforces that one and this is what the app shows and
 * what every transaction is built against: a disagreement here is a transaction the
 * chain rejects, or worse, a seller shown a figure they do not receive.
 */
export const SALE_FEE_PERCENT = 1

/**
 * The smallest a cell under the treasury's lock may be, in CKB.
 *
 * Named and scaled exactly like `TREASURY_MIN_SHANNONS` in cells-core on purpose: the
 * drift test compares constants the two languages share **by name**, so a copy under a
 * different name or in a different unit would sit outside the one check meant to catch
 * it. And `treasury-floor.test.ts` measures the real lock, so neither copy can drift
 * from the thing they both describe. Below a share this size the protocol takes nothing
 * at all: see `saleSplitCkb`.
 */
export const TREASURY_MIN_SHANNONS = 63 * 100_000_000

/**
 * The most of a sale the protocol will ever take, in percent. Must equal
 * `SALE_FEE_MAX_PERCENT` in cells-core, which the drift test enforces. It is what decides
 * where the flat-cell band starts: below `TREASURY_MIN / this`, a whole cell would be a
 * larger share than this and nothing is charged.
 */
export const SALE_FEE_MAX_PERCENT = 10
/** The same floor in whole CKB, which is the unit the sale split works in. */
const TREASURY_MIN_CKB = TREASURY_MIN_SHANNONS / 100_000_000

/**
 * What the protocol is owed on a sale at `price` shannons: `sale_fee` in cells-core, all
 * three bands, in the same integers. One percent is the price divided by a hundred and
 * rounded down, so the odd shannons go to the seller.
 *
 * Getting this wrong in only one of the two languages builds a transaction the chain
 * refuses, or shows a seller a figure they do not receive. Until 2026-09-27 it was done
 * in floating-point CKB, and a price with odd shannons, or past 2^53 of them, was paid a
 * shannon off: the node refused the purchase and the name could not be bought.
 */
export function saleFeeShannons(price: bigint): bigint {
  const floor = BigInt(TREASURY_MIN_SHANNONS)
  const onePercent = (price / 100n) * BigInt(SALE_FEE_PERCENT)
  if (onePercent >= floor) return onePercent
  if (price >= floor * (100n / BigInt(SALE_FEE_MAX_PERCENT))) return floor
  return 0n
}

/**
 * The two halves of a sale at `price` shannons: what the protocol takes and what the
 * seller receives for the name. This is what a purchase pays.
 *
 * The fee comes out of the seller's proceeds, never on top of the price, so these
 * always add back up to what the buyer pays. A name listed at ten thousand is bought
 * for ten thousand and the seller receives 9,900; at a thousand the fee is the flat
 * 63 CKB cell and the seller receives 937.
 */
export function saleSplitShannons(price: bigint): { toSeller: bigint; toTreasury: bigint } {
  const toTreasury = saleFeeShannons(price)
  return { toSeller: price - toTreasury, toTreasury }
}

/**
 * The same split at `priceCkb`, in CKB, for showing. The fee is worked out in shannons
 * by `saleFeeShannons`; a transaction is built from `saleSplitShannons`, never from these.
 */
export function saleSplitCkb(priceCkb: number): { toSeller: number; toTreasury: number } {
  if (!Number.isFinite(priceCkb)) return { toSeller: NaN, toTreasury: NaN }
  const toTreasury = Number(saleFeeShannons(BigInt(Math.round(priceCkb * 100_000_000)))) / 100_000_000
  return { toSeller: priceCkb - toTreasury, toTreasury }
}

/**
 * Where the three bands of `saleSplitCkb` begin and end, in whole CKB, for the pages that
 * explain the fee in words.
 *
 * They were typed by hand in four prose blocks (the market, the sell screen, the name
 * page's sale panel and the help), and they are not free-standing facts: each follows
 * from the constants above. The percentage was lowered from ten to one on 2026-09-14, so
 * every one of those numbers has already changed once, and a copy that is missed shows a
 * seller a figure they do not receive. `sale-bands.test.ts` proves these are the
 * boundaries the split function actually uses, and that no page types them again.
 */
export function saleFeeBands(): { percent: number; flatCkb: number; flatFrom: number; flatTo: number } {
  return {
    percent: SALE_FEE_PERCENT,
    flatCkb: TREASURY_MIN_CKB,
    // Below this, even a whole flat cell would be a bigger share than the protocol will
    // ever take, so nothing is taken.
    flatFrom: (TREASURY_MIN_CKB * 100) / SALE_FEE_MAX_PERCENT,
    // Above this, the percentage itself is at least a whole cell, so it applies.
    flatTo: (TREASURY_MIN_CKB * 100) / SALE_FEE_PERCENT,
  }
}

/** Whole years covered by a term in seconds, rounded up: no part of a term is free. */
export function yearsForTerm(seconds: number): number {
  return Math.ceil(seconds / SECONDS_PER_YEAR)
}

/**
 * Where the registration fee goes (decision 0009). Its hash must equal the
 * `TREASURY_LOCK_HASH` compiled into the contract, or every registration fails; the
 * SDK test suite asserts that rather than leaving it to a failed transaction.
 */
export const TREASURY_LOCK = {
  codeHash: '0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac' as Hex,
  hashType: 'type' as const,
  args: '0x000140911fa94eaef8c1d0eca81b23e1972ecb0548dc' as Hex,
}

/** The hash the contract checks against. Kept beside the script it belongs to. */
export const TREASURY_LOCK_HASH =
  '0xd9d177037d0888e09330bf0dd18e98c534ea3479b4376911d0a5279ead21e0f8' as Hex

// --- Commit-reveal (anti front-running, decision 0004) ---------------------

/** Reveal-secret length (bytes). */
export const SECRET_LEN = 32
/** Minimum CommitCell age (seconds) before reveal; mirrors `COMMIT_MIN_DELAY`. */
export const COMMIT_MIN_DELAY = 60

/**
 * The CommitCell commitment: `ckb-blake2b(namespace_id ‖ label ‖ owner ‖ secret)`,
 * the exact bytes the contract recomputes in `require_commit`. Hides the label,
 * binds the owner (so a reveal can't be stolen) and the namespace.
 */
export function commitment(namespaceId: Hex, label: string, ownerLockHash: Hex, secret: Hex): Hex {
  // Both identities are stored truncated, so the commitment binds the truncated
  // form; a caller may pass the full hash and gets the same bytes the contract does.
  const ns = u8(namespaceArgs(namespaceId))
  const ow = u8(ownerId(ownerLockHash))
  const sc = u8(secret)
  if (sc.length !== SECRET_LEN) throw new Error('cells: secret must be 32 bytes')
  const lb = enc.encode(label)
  const buf = new Uint8Array(ns.length + lb.length + ow.length + sc.length)
  buf.set(ns, 0)
  buf.set(lb, ns.length)
  buf.set(ow, ns.length + lb.length)
  buf.set(sc, ns.length + lb.length + ow.length)
  return ccc.hashCkb(buf)
}

/** A fresh 32-byte reveal secret (caller stores it between commit and reveal). */
export function randomSecret(): Hex {
  return hx(crypto.getRandomValues(new Uint8Array(SECRET_LEN)))
}

// --- reverse records (primary name, decision 0006) -------------------------
// A user's primary name lives in a small **reverse-record cell** under their own
// wallet lock: data = REVERSE_TAG ‖ label. It needs no type script, a claim is
// only trusted after a forward lookup confirms the name's owner is that same wallet
// (so a forged claim resolves to nothing). The tag identifies the cell among a
// wallet's ordinary cells.
const REVERSE_TAG = enc.encode('cells:rev:') // 10 bytes
/** How long the tag every reverse record starts with is, so a search can ask for no shorter. */
export const REVERSE_TAG_LENGTH = REVERSE_TAG.length

/** Encode a reverse-record cell's data for `label` (the user's primary name). */
export function encodeReverse(label: string): Hex {
  const lb = enc.encode(label)
  const out = new Uint8Array(REVERSE_TAG.length + lb.length)
  out.set(REVERSE_TAG, 0)
  out.set(lb, REVERSE_TAG.length)
  return hx(out)
}

/** Decode a cell's data as a reverse record → the label, or null if not tagged. */
export function decodeReverse(data: Hex): string | null {
  const d = u8(data)
  if (d.length < REVERSE_TAG.length) return null
  for (let i = 0; i < REVERSE_TAG.length; i++) if (d[i] !== REVERSE_TAG[i]) return null
  return dec.decode(d.slice(REVERSE_TAG.length))
}

// --- fiber records: a name as a payment endpoint ---------------------------
// A name can publish where to pay it over Fiber, CKB's payment-channel network:
// `fiber.node` is the node's public key (who to pay), `fiber.addr` its dial
// multiaddr (how to reach it to open/route a channel). Invoices deliberately stay
// off-record, they are per-payment and short-lived, a name is neither.

export const FIBER_NODE_KEY = 'fiber.node'
export const FIBER_ADDR_KEY = 'fiber.addr'

/**
 * The name's CKB on-chain address (SLIP-0044 coin type 309). Stored as the UTF-8
 * address string, so it carries its own network prefix (`ckb1…` / `ckt1…`) and a
 * human can check it by eye. This is the fallback payment route: it needs no node
 * online, where a Fiber endpoint does.
 */
export const CKB_ADDRESS_KEY = 'address.309'

export interface FiberEndpoint {
  node: Hex // node public key
  addr: string | null // `/ip4/…/tcp/…/p2p/…`, if published
}

/** Record values are raw bytes; textual ones (a multiaddr) go through UTF-8. */
export function textToValue(s: string): Hex {
  return hx(enc.encode(s))
}
export function valueToText(v: Hex): string {
  return dec.decode(u8(v))
}

/** The record entries that publish `ep` under a name. */
export function fiberRecords(ep: FiberEndpoint, ttl = 300): RecordEntry[] {
  if (u8(ep.node).length === 0) throw new Error('cells: fiber node public key is empty')
  const out: RecordEntry[] = [{ key: FIBER_NODE_KEY, label: '', value: ep.node, ttl }]
  if (ep.addr) out.push({ key: FIBER_ADDR_KEY, label: '', value: textToValue(ep.addr), ttl })
  return out
}

/** Read a Fiber endpoint back out of a name's records, or null if it publishes none. */
export function parseFiber(records: RecordEntry[]): FiberEndpoint | null {
  const node = records.find((r) => r.key === FIBER_NODE_KEY)?.value
  if (!node) return null
  const addr = records.find((r) => r.key === FIBER_ADDR_KEY)?.value
  return { node, addr: addr ? valueToText(addr) : null }
}

/** What a name publishes for Lightning, or null if it publishes neither. */
export interface LightningPayee {
  /** `name@domain`, what almost every wallet accepts today. */
  address: string | null
  /** A BOLT12 offer, `lno1…`, reusable and non-expiring. */
  offer: string | null
}

/**
 * Lightning, read off the records. Two independent answers rather than one, because
 * a wallet supports one or the other and neither is a fallback for the other.
 */
export function parseLightning(records: RecordEntry[]): LightningPayee | null {
  const at = (k: string) => {
    const v = records.find((r) => r.key === k)?.value
    return v ? valueToText(v) : null
  }
  const address = at('lightning.address')
  const offer = at('lightning.offer')
  return address || offer ? { address, offer } : null
}

// --- WitnessData (records-only since decision 0002) ------------------------

/**
 * The most a record set may be, in bytes on the wire.
 *
 * Not a storage limit: the bytes are fee-only. There are two walls above this number and
 * the lower one was missed for a long time.
 *
 * **The block.** A transfer carries the records, so an oversized set can make a name
 * impossible to hand over. `sdk/scripts/payload-ceiling.ts` measured that: an edit fits
 * about 582 KB and a sale about 580 KB. That is where the old 500 KB came from.
 *
 * **The type script, which binds nine times sooner.** `account-cell-type` loads the
 * witness with `ckb_std`'s `load_data`, one allocation of the whole thing, and does it
 * more than once per run. The buddy allocator rounds each request to a power of two, so
 * the moment a witness crosses 64 KiB every one of those allocations doubles to 128 KiB
 * and the 516 KB heap runs out. The script exits -1, which says nothing about size.
 *
 * Measured 2026-09-12 against Pudge with `test_tx_pool_accept`, which runs the scripts
 * and broadcasts nothing (`scripts/probe-editrecords-ceiling.mjs`), through the real
 * `editRecords` path: a witness of **64,593 B is accepted and 65,617 B is rejected**.
 * The boundary is 65,536 exactly. `payload-ceiling.ts` never saw it because it builds
 * transactions and measures their length without asking a node to run anything, and its
 * header said plainly that nothing is signed or sent.
 *
 * 52 KB leaves room under that wall for the witness framing and for a signature in the
 * same witness, including a post-quantum one, which is eight kilobytes on its own.
 */
export const MAX_RECORDS_BYTES = 52 * 1024

export function encodeWitness(w: WitnessData): Hex {
  const out: number[] = []
  // One key, one record. Two records under the same key encode fine and decode fine, and
  // then every reader has to invent its own rule for which one wins; refusing here means
  // nothing we write is ever ambiguous.
  const seen = new Set<string>()
  for (const r of w.records) {
    if (seen.has(r.key)) throw new Error(`cells: ${r.key} appears twice; a key may only be published once`)
    seen.add(r.key)
  }
  pushU16(out, w.records.length)
  for (const r of w.records) {
    // A record's value is BYTES, written as hex. Passing readable text is the first
    // mistake anybody makes, and until this was here the answer came from two
    // dependencies down, `Invalid Hex character encountered at position 0`, naming
    // neither the record nor the fix. It is caught here, where the key is still in hand,
    // and the message names `textToValue`, which is in this package and is exactly what
    // the caller wanted. Measured against the published 0.1.1 by making the mistake.
    if (typeof r.value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(r.value))
      throw new Error(
        `cells: the value of "${r.key}" must be bytes as hex ("0x…", an even number of hex digits), not ${JSON.stringify(
          String(r.value).slice(0, 40),
        )}. For readable text use textToValue("…") from this package; for an address use setAddressRecord.`,
      )
    pushBytes(out, enc.encode(r.key), 1)
    pushBytes(out, enc.encode(r.label), 1)
    pushBytes(out, u8(r.value), 2)
    pushU32(out, r.ttl)
  }
  if (out.length > MAX_RECORDS_BYTES)
    throw new Error(
      `cells: this record set is ${(out.length / 1024).toFixed(1)} KB, over the ${MAX_RECORDS_BYTES / 1024} KB limit. ` +
        `Records travel with the name in every transfer, so an oversized set would make it impossible to hand over.`,
    )
  return hx(Uint8Array.from(out))
}

export function decodeWitness(witness: Hex): WitnessData {
  const b = u8(witness)
  const c = { o: 0 }
  const n = readU16(b, c)
  const records: RecordEntry[] = []
  for (let i = 0; i < n; i++) {
    const key = dec.decode(readBytes(b, c, 1))
    const label = dec.decode(readBytes(b, c, 1))
    const value = hx(readBytes(b, c, 2))
    const ttl = readU32(b, c)
    records.push({ key, label, value, ttl })
  }
  if (c.o !== b.length) throw new Error('cells: trailing bytes in witness')
  return { records }
}

/**
 * One record per key, the first of each: the rule every reader follows. `encodeWitness`
 * never writes a key twice, but the contract does not read records, so a witness written
 * by another tool can. Readers used to pick differently, the pay box the first and the
 * profile the last, so one name paid one address and showed another (2026-09-27).
 */
export function oneRecordPerKey(records: RecordEntry[]): RecordEntry[] {
  const seen = new Set<string>()
  return records.filter((r) => !seen.has(r.key) && !!seen.add(r.key))
}

// --- AccountCell.data ------------------------------------------------------

export function buildAccountData(
  witnessHash: Hex,
  next: Hex,
  expiredAt: number,
  ownerLockHash: Hex,
  managerLockHash: Hex,
  label: string,
): Hex {
  if (!Number.isInteger(expiredAt) || expiredAt < 0 || expiredAt > MAX_EXPIRED_AT)
    throw new Error(`cells: expiredAt must fit in ${EXPIRY_LEN} bytes`)
  const out: number[] = [VERSION_V3]
  push(out, u8(witnessHash), 32)
  push(out, u8(next), ID_LEN)
  pushU40(out, expiredAt)
  push(out, u8(ownerId(ownerLockHash)), OWNER_HASH_LEN)
  push(out, u8(ownerId(managerLockHash)), OWNER_HASH_LEN)
  append(out, enc.encode(label))
  return hx(Uint8Array.from(out))
}

/**
 * Build `{ data, witness }` for a new or updated account. There is no id argument:
 * the id is the label's. An undelegated name passes its owner as the manager too.
 */
export function buildAccount(
  w: WitnessData,
  next: Hex,
  expiredAt: number,
  ownerLockHash: Hex,
  managerLockHash: Hex,
  label: string,
): { data: Hex; witness: Hex } {
  const witness = encodeWitness(w)
  const witnessHash = ccc.hashCkb(witness)
  return { data: buildAccountData(witnessHash, next, expiredAt, ownerLockHash, managerLockHash, label), witness }
}

/** Parse + integrity-check an AccountCell from its on-chain `data` and `witness`. */
export function parseAccount(data: Hex, witness: Hex): Account {
  const d = u8(data)
  if (d.length < DATA_HEADER_LEN || d[OFF_VERSION] !== VERSION_V3) throw new Error('cells: malformed account data')
  const witnessHash = hx(d.slice(OFF_WITNESS_HASH, OFF_NEXT))
  if (ccc.hashCkb(witness) !== witnessHash) throw new Error('cells: witness_hash mismatch')
  const label = dec.decode(d.slice(OFF_ACCOUNT))
  return {
    name: label + '.cell',
    label,
    // Not stored: the label's hash, and the root sentinel's zero id by definition,
    // since blake2b of nothing is not zero.
    id: label === '' ? ROOT_ID : accountId(label),
    next: hx(d.slice(OFF_NEXT, OFF_EXPIRED_AT)),
    expiredAt: readU40At(d, OFF_EXPIRED_AT),
    ownerLockHash: hx(d.slice(OFF_OWNER, OFF_MANAGER)),
    managerLockHash: hx(d.slice(OFF_MANAGER, OFF_ACCOUNT)),
    witnessHash,
    records: oneRecordPerKey(decodeWitness(witness).records),
  }
}

/** The label written in an AccountCell's `data`, without touching its witness. */
export interface AccountLite {
  label: string
  id: Hex
  next: Hex
  expiredAt: number
  ownerLockHash: Hex
  managerLockHash: Hex
}

/**
 * Parse only the parts of an AccountCell that live in `data`: the label, its
 * linked-list position, and the expiry. Reads no witness, so it costs nothing to
 * fetch. Enough to find a name by label, or a predecessor by (id, next), before
 * paying for the one cell you actually want.
 */
export function parseAccountLite(data: Hex): AccountLite {
  const d = u8(data)
  if (d.length < DATA_HEADER_LEN || d[OFF_VERSION] !== VERSION_V3) throw new Error('cells: malformed account data')
  const label = dec.decode(d.slice(OFF_ACCOUNT))
  return {
    label,
    id: label === '' ? ROOT_ID : accountId(label),
    next: hx(d.slice(OFF_NEXT, OFF_EXPIRED_AT)),
    expiredAt: readU40At(d, OFF_EXPIRED_AT),
    ownerLockHash: hx(d.slice(OFF_OWNER, OFF_MANAGER)),
    managerLockHash: hx(d.slice(OFF_MANAGER, OFF_ACCOUNT)),
  }
}

// --- linked-list ordering (mirrors cells-core `covers` / `between`) --------
// 20-byte ids compared as fixed-width lowercase 0x-hex → lexicographic == byte order.

/** half-open `(lo, hi]`, wraparound-aware (lo>=hi wraps / is the root). */
export function covers(lo: Hex, hi: Hex, id: Hex): boolean {
  return lo < hi ? lo < id && id <= hi : id > lo || id <= hi
}
/** strictly inside `(lo, hi)`, can a new id be inserted into predecessor lo? */
export function between(lo: Hex, hi: Hex, id: Hex): boolean {
  return lo < hi ? lo < id && id < hi : (id > lo || id < hi) && id !== lo && id !== hi
}

// --- byte helpers ----------------------------------------------------------

/**
 * Append every byte of `b` to `out`.
 *
 * Written as a loop, not `out.push(...b)`. Spreading passes each byte as its own
 * argument, and a record value may be tens of thousands of bytes: past roughly a hundred
 * thousand the call blows the stack, so encoding a name with a few images crashed instead
 * of producing a transaction. It failed in the encoder, before anything could report a
 * size, which made it look like a bug in whatever called it.
 */
function append(out: number[], b: Uint8Array) {
  for (let i = 0; i < b.length; i++) out.push(b[i])
}
function push(out: number[], b: Uint8Array, len: number) {
  if (b.length !== len) throw new Error(`cells: expected ${len} bytes, got ${b.length}`)
  append(out, b)
}
/**
 * A length-prefixed byte string: one byte of length for a key or label, two for a value.
 *
 * The length is checked rather than masked. `pushU16` keeps the low sixteen bits, so a
 * value of 70,000 bytes used to be written with a length of 4,464 and the rest of the
 * record set decoded as garbage from there on: the name would have committed to bytes
 * that say something other than what was published, and nothing would have said so until
 * a reader tripped over it. Refusing is the only honest option, since the wire format
 * cannot express it.
 */
function pushBytes(out: number[], b: Uint8Array, lenBytes: 1 | 2) {
  const max = lenBytes === 1 ? 0xff : 0xffff
  if (b.length > max)
    throw new Error(`cells: ${b.length} bytes does not fit a ${lenBytes}-byte length prefix (max ${max})`)
  if (lenBytes === 1) out.push(b.length)
  else pushU16(out, b.length)
  append(out, b)
}
function pushU16(out: number[], n: number) {
  out.push(n & 0xff, (n >> 8) & 0xff)
}
function pushU32(out: number[], n: number) {
  out.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff)
}
function pushU64(out: number[], n: number) {
  let v = BigInt(n)
  for (let i = 0; i < 8; i++) {
    out.push(Number(v & 0xffn))
    v >>= 8n
  }
}
function readU16(b: Uint8Array, c: { o: number }): number {
  if (c.o + 2 > b.length) throw new Error('cells: short witness')
  const v = b[c.o] | (b[c.o + 1] << 8)
  c.o += 2
  return v
}
function readU32(b: Uint8Array, c: { o: number }): number {
  if (c.o + 4 > b.length) throw new Error('cells: short witness')
  const v = (b[c.o] | (b[c.o + 1] << 8) | (b[c.o + 2] << 16) | (b[c.o + 3] << 24)) >>> 0
  c.o += 4
  return v
}
function pushU40(out: number[], v: number) {
  for (let i = 0; i < EXPIRY_LEN; i++) out.push(Math.floor(v / 2 ** (8 * i)) & 0xff)
}
function readU40At(b: Uint8Array, off: number): number {
  let v = 0
  for (let i = EXPIRY_LEN - 1; i >= 0; i--) v = v * 256 + b[off + i]
  return v
}
function readU64At(b: Uint8Array, off: number): bigint {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i])
  return v
}
function readBytes(b: Uint8Array, c: { o: number }, lenBytes: 1 | 2): Uint8Array {
  const n = lenBytes === 1 ? b[c.o++] : readU16(b, c)
  if (c.o + n > b.length) throw new Error('cells: short witness')
  const v = b.slice(c.o, c.o + n)
  c.o += n
  return v
}
