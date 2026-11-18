// Signed payment requests (decision 0013).
//
// A request is a message the name's owner signs with their wallet. It never touches
// the chain: it travels in a link, the payer's browser verifies it against the name's
// current owner, and the only transaction is the payment itself, which carries the
// request's hash so the two can be tied together later.
import { ccc } from '@ckb-ccc/core'
import type { Hex } from './codec.ts'
import { ownerId } from './codec.ts'
import { parseLightning, randomSecret, valueToText } from './codec.ts'
import type { CellsClient, LiveAccount } from './client.ts'
import { deedOf } from './deed.ts'
import { mealIn, type Meal } from './meal.ts'
import { isAddressForCoin } from './address.ts'
import { PQ_SIGN_TYPE, pqNetworkOf, pqScript, pqVerifyMessage } from './pq.ts'
import {
  PIX_CITY_MAX,
  PIX_NAME_MAX,
  UPI_NAME_MAX,
  UPI_NOTE_MAX,
  brCode,
  isPixAccount,
  isPixCity,
  isPixName,
  isUpiAccount,
  isUpiName,
  normalisePixKey,
  normaliseVpa,
  pixText,
  upiText,
  upiUri,
  type PixAccount,
  type UpiAccount,
} from './rails.ts'

export const REQUEST_VERSION = 1 as const

/**
 * The chains a name can be asked for money on that this protocol does not itself
 * settle. A request in one of these is a signed statement of what is owed, rendered
 * for the payer as the address the name publishes plus an amount; the payment
 * happens in their own wallet, on that chain, with nothing of ours in the middle.
 *
 * `decimals` is how many of the unit's smallest pieces make one whole coin, because
 * an amount always travels as a whole number of the smallest piece, never a decimal.
 * `scheme` is the URI a wallet understands, where one exists and is worth using.
 */
export const EXTERNAL_UNITS = {
  btc: { coinType: '0', label: 'Bitcoin', ticker: 'BTC', decimals: 8, scheme: 'bitcoin' },
  eth: { coinType: '60', label: 'Ethereum', ticker: 'ETH', decimals: 18, scheme: 'ethereum' },
  sol: { coinType: '501', label: 'Solana', ticker: 'SOL', decimals: 9, scheme: 'solana' },
  // Dollars, as USDC, paid to the name's EVM address (`address.60`) on the chain the
  // unit names. The chain is inside the unit rather than in a field of its own, so it
  // is signed by the same path every other unit is, a request can never be paid on the
  // wrong chain, and no existing unit's bytes move. Contract addresses are Circle's own
  // native USDC, not a bridged USDC.e, which on Polygon in particular is a different and
  // still widely held contract. Every one of the ten contracts below was asked its own
  // `symbol()`, `name()` and `decimals()` on its own chain before being written here,
  // the first six on 2026-09-19 and the Optimism and Polygon four on 2026-09-20, and
  // every one answered USDC and 6. The same run put a contract that is not USDC through
  // the same reading and it came back WETH with 18 decimals, so the check can fail. A
  // token address that is merely copied from somewhere is an address money is sent to
  // and never seen again.
  'usdc-base': {
    coinType: '60',
    label: 'USDC on Base',
    ticker: 'USDC',
    decimals: 6,
    scheme: 'ethereum',
    chainId: 8453,
    token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    testChainId: 84532,
    testToken: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  'usdc-eth': {
    coinType: '60',
    label: 'USDC on Ethereum',
    ticker: 'USDC',
    decimals: 6,
    scheme: 'ethereum',
    chainId: 1,
    token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    testChainId: 11155111,
    testToken: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  'usdc-arb': {
    coinType: '60',
    label: 'USDC on Arbitrum',
    ticker: 'USDC',
    decimals: 6,
    scheme: 'ethereum',
    chainId: 42161,
    token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    testChainId: 421614,
    testToken: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },
  'usdc-op': {
    coinType: '60',
    label: 'USDC on Optimism',
    ticker: 'USDC',
    decimals: 6,
    scheme: 'ethereum',
    chainId: 10,
    token: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    testChainId: 11155420,
    testToken: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
  },
  'usdc-poly': {
    coinType: '60',
    label: 'USDC on Polygon',
    ticker: 'USDC',
    decimals: 6,
    scheme: 'ethereum',
    chainId: 137,
    token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    testChainId: 80002,
    testToken: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  },
} as const
/** The units that are a token on an EVM chain rather than the chain's own coin. */
/**
 * The units that are a token on a chain rather than a chain's own coin.
 *
 * Derived from the table instead of listed again, because it was listed again and then
 * a third one was added and the list did not move. A unit with a `token` field is a
 * token unit, and that is the whole definition, at compile time and at run time.
 */
export type TokenUnit = {
  [K in keyof typeof EXTERNAL_UNITS]: 'token' extends keyof (typeof EXTERNAL_UNITS)[K] ? K : never
}[keyof typeof EXTERNAL_UNITS]
export const isTokenUnit = (u: string): u is TokenUnit => isExternalUnit(u) && 'token' in EXTERNAL_UNITS[u]
/** The chain and token contract a token unit settles on, for the network in use. */
export function tokenOf(unit: TokenUnit, testnet: boolean): { chainId: number; token: string } {
  const m = EXTERNAL_UNITS[unit]
  return testnet ? { chainId: m.testChainId, token: m.testToken } : { chainId: m.chainId, token: m.token }
}
export type ExternalUnit = keyof typeof EXTERNAL_UNITS
// `in` would also answer yes for anything inherited from Object.prototype, so a
// link carrying unit "__proto__" or "constructor" would pass as a real chain and
// then read undefined fields off it. This checks the object's own keys only, and it
// matters because the value being tested comes from an untrusted link.
export const isExternalUnit = (u: string): u is ExternalUnit => Object.hasOwn(EXTERNAL_UNITS, u)

/** A whole number of the smallest unit, written the way a person reads it. */
export function baseToDecimal(amount: string, decimals: number): string {
  const s = amount.replace(/^0+(?=\d)/, '').padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/**
 * A person's decimal amount turned into a whole number of the smallest unit, by
 * string arithmetic rather than floating point, because 0.1 is not representable in
 * binary and money must not be approximate. Returns null for anything that is not a
 * plain decimal, and for an amount finer than the unit divides, which is refused
 * rather than rounded: silently dropping a digit of someone's money is worse than
 * telling them the number cannot exist.
 */
export function decimalToBase(input: string, decimals: number): string | null {
  const t = input.trim()
  if (t === '' || t === '.' || !/^\d*(\.\d*)?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  if (frac.length > decimals) return null
  const digits = (whole || '0') + frac.padEnd(decimals, '0')
  const out = digits.replace(/^0+(?=\d)/, '')
  return out === '' ? '0' : out
}

/**
 * The link a payer's wallet can open, or null when no standard is worth using.
 * Bitcoin's is understood essentially everywhere and states the amount in whole
 * coins. Ethereum's states it in wei. Solana's states it in whole coins. Where a
 * wallet ignores the link, the address and amount shown beside it still work, which
 * is why the page never depends on the link alone.
 */
export function paymentUri(unit: ExternalUnit, address: string, amount: string, memo = '', testnet = false): string | null {
  const u = EXTERNAL_UNITS[unit]
  // The address is whatever the name published, and it lands in front of the query,
  // where a '?' or '&' of its own would add parameters and a '#' would cut the query
  // off entirely. Either lets the amount a wallet prefills differ from the amount on
  // screen, which is the one thing this page must never allow, and a stray space or
  // a pasted "bitcoin:..." URI breaks an honest payment the same way. So a URI is
  // built only for an address that is well formed for its chain; anything else gets
  // no link at all, and the page falls back to showing the address and the amount.
  if (!isAddressForCoin(u.coinType, address)) return null
  // A token unit is an EIP-681 call on the token contract, on its own chain: the
  // wallet is told which contract, which chain, who receives and how much. The memo
  // has nowhere to go in that form and is left out; the request page shows it.
  if (isTokenUnit(unit)) {
    const t = tokenOf(unit, testnet)
    return `ethereum:${t.token}@${t.chainId}/transfer?address=${encodeURIComponent(address.trim())}&uint256=${amount}`
  }
  // The link is for the network the page is on, or there is none. A Bitcoin address says
  // its own network, so one from the other network gets no link. A Solana link cannot
  // name a network at all, and a wallet pays it on the one it is set to, which is the
  // real one, so the test network builds none. Ether names Sepolia on the test network,
  // the chain the app's own test payments use; without it a wallet pays on whatever
  // chain it is set to.
  if (unit === 'btc' && (/^tb1/i.test(address.trim()) || /^[mn2]/.test(address.trim())) !== testnet) return null
  if (unit === 'sol' && testnet) return null
  const chain = unit === 'eth' && testnet ? '@11155111' : ''
  const q = new URLSearchParams()
  if (unit === 'eth') q.set('value', amount)
  else q.set('amount', baseToDecimal(amount, u.decimals))
  if (memo) q.set(unit === 'btc' ? 'message' : 'memo', memo)
  return `${u.scheme}:${encodeURIComponent(address.trim())}${chain}?${q.toString()}`
}

// --- Lightning invoices -------------------------------------------------------

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

/** The BIP-173 checksum over a human-readable part and its data words: 1 when it holds. */
function bech32Polymod(hrp: string, words: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  const codes = [...hrp].map((c) => c.charCodeAt(0))
  let chk = 1
  for (const v of [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31), ...words]) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]
  }
  return chk
}

/**
 * What a BOLT 11 invoice asks for, in millisatoshis: `'any'` when it leaves the amount to
 * the payer, and null when it is not an invoice at all (not bech32, a failed checksum, a
 * currency other than Bitcoin's, a malformed amount). The amount is the one in the
 * human-readable part, which is what a wallet shows and charges, so a page that hands a
 * payer an invoice for a request compares this with what the request asked.
 */
export function bolt11Msat(invoice: string): bigint | 'any' | null {
  const s = invoice.trim()
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null
  const t = s.toLowerCase()
  const sep = t.lastIndexOf('1')
  if (sep < 1) return null
  const words: number[] = []
  for (const c of t.slice(sep + 1)) {
    const w = BECH32.indexOf(c)
    if (w < 0) return null
    words.push(w)
  }
  const hrp = t.slice(0, sep)
  if (words.length < 6 || bech32Polymod(hrp, words) !== 1) return null
  const m = /^ln(?:bcrt|tbs|bc|tb)(?:([1-9]\d*)([munp]?))?$/.exec(hrp)
  if (!m) return null
  if (m[1] === undefined) return 'any'
  const n = BigInt(m[1])
  // One bitcoin is 10^11 millisatoshis; the multiplier is a fraction of a bitcoin.
  switch (m[2]) {
    case 'm':
      return n * 100_000_000n
    case 'u':
      return n * 100_000n
    case 'n':
      return n * 100n
    case 'p':
      // A pico amount must end in 0, or it names a fraction of a millisatoshi.
      return n % 10n === 0n ? n / 10n : null
    default:
      return n * 100_000_000_000n
  }
}

// --- euros, by bank transfer (decision 0017) ----------------------------------

/**
 * A bank account a request can name, inside SEPA. It travels inside the signed
 * request and nowhere else: not in the name's records, not on the chain, not through
 * the resolver. The payer's browser verifies the signature against the name's owner
 * and shows the account beside an EPC QR code their banking app can scan.
 */
export interface SepaAccount {
  /** The IBAN, canonical: upper case, no spaces. */
  iban: string
  /** The account holder's name as their bank holds it, one to seventy characters. */
  name: string
  /** The BIC, or null: optional inside SEPA since version 002 of the EPC code. */
  bic: string | null
}

/**
 * IBAN length by country, for the countries in SEPA and the territories that use
 * their codes. A valid IBAN from outside is refused too: a SEPA credit transfer
 * cannot reach it, so a request naming it could not be paid.
 */
export const SEPA_IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GI: 23,
  GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28,
  PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
}

/**
 * The IBAN in its canonical form, or null when it is not one: wrong shape, wrong
 * length for its country, outside SEPA, or failing the ISO 13616 mod-97 check, which
 * catches any single typo and most swapped digits.
 */
export function normaliseIban(v: string): string | null {
  const s = v.replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return null
  const len = SEPA_IBAN_LENGTHS[s.slice(0, 2)]
  if (len === undefined || s.length !== len) return null
  // Country and check digits to the end, letters spelt as 10..35, and the whole
  // number modulo 97 must be 1. BigInt, because the number has up to 68 digits.
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  return BigInt(digits) % 97n === 1n ? s : null
}
export const isIban = (v: string): boolean => normaliseIban(v) !== null

/** Groups of four, the way an IBAN is printed. */
export function ibanForDisplay(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, '$1 ')
}

/**
 * The holder's name as signed: trimmed, one to seventy characters, nothing invisible,
 * and nothing a reader could take for the end of a line. The name is one line of the EPC
 * code, and U+2028 and U+2029 are not control characters but do break a line for some
 * readers, which then read the rest of the name as the amount line.
 */
export const isHolderName = (v: string): boolean =>
  v.length >= 1 && v.length <= 70 && v === v.trim() && !/[\p{C}\p{Zl}\p{Zp}]/u.test(v)

/** The BIC in its canonical form, eight or eleven characters, or null. */
export function normaliseBic(v: string): string | null {
  const s = v.replace(/\s+/g, '').toUpperCase()
  return /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(s) ? s : null
}

/** The ceiling of one SEPA credit transfer, in cents: 999,999,999.99 euros. */
export const EUR_CENTS_MAX = 99_999_999_999n
export const isEurCents = (v: string): boolean => /^\d+$/.test(v) && BigInt(v) >= 1n && BigInt(v) <= EUR_CENTS_MAX
/** The same ceiling serves every rail that counts in hundredths: reais and rupees too. */
export const isMoneyCents = isEurCents

/** Cents as euros with two decimals, always: money is not written "12.5". */
export function centsToEuro(cents: string): string {
  const s = cents.replace(/^0+(?=\d)/, '').padStart(3, '0')
  return `${s.slice(0, -2)}.${s.slice(-2)}`
}
export const centsToMoney = centsToEuro

/**
 * The characters a SEPA remittance line may carry, the Latin set every bank in the
 * scheme accepts. Accents are dropped from their letters first, so "açúcar" arrives
 * as "acucar" and not as a hole; anything else becomes a space here rather than
 * being passed on for a bank to refuse or mangle on the way.
 */
export function sepaText(v: string): string {
  return v
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * What the payer's bank carries onto the holder's statement: the memo, and the
 * request's fingerprint, which is what lets a transfer be matched to the request it
 * settles, the way a chain payment carries the hash in its witness. At most 140
 * characters, what a SEPA transfer allows; a memo longer than fits is cut, the
 * fingerprint never is.
 */
export function requestReference(req: PaymentRequest): string {
  const tag = `cells ${requestHash(req).slice(2, 14)}`
  const memo = sepaText(req.memo)
  if (!memo) return tag
  const room = 140 - tag.length - 3
  return `${memo.length > room ? memo.slice(0, room).trimEnd() : memo} (${tag})`
}

/**
 * The EPC069-12 payload, the "EPC QR code" European banking apps scan: version 002,
 * UTF-8, a SEPA credit transfer, the BIC optional, the amount in euros with two
 * decimals, no purpose code, and the reference on the unstructured remittance line.
 * Null when the payload would exceed the 331 bytes the standard allows, rather than
 * a code with something cut off, and when a field carries a character that could end
 * its line early, rather than a code whose lines a reader counts differently.
 */
export function epcQr(account: SepaAccount, cents: string | null, reference: string): string | null {
  const lines = ['BCD', '002', '1', 'SCT', account.bic ?? '', account.name, account.iban, cents ? `EUR${centsToEuro(cents)}` : '', '', '', reference]
  if (lines.some((l) => /[\p{C}\p{Zl}\p{Zp}]/u.test(l))) return null
  const payload = lines.join('\n')
  return new TextEncoder().encode(payload).length <= 331 ? payload : null
}

export interface SepaPayment {
  account: SepaAccount
  /** Cents, as signed. */
  cents: string
  /** "12.50 EUR" */
  amountText: string
  reference: string
  /** The QR payload, or null when it could not fit the standard. */
  epc: string | null
}

/** Everything the payer needs for a euro request, or null when the request is not one. */
export function sepaPayment(req: PaymentRequest): SepaPayment | null {
  if (req.unit !== 'eur' || !req.sepa) return null
  const reference = requestReference(req)
  return {
    account: req.sepa,
    cents: req.amount,
    amountText: `${centsToEuro(req.amount)} EUR`,
    reference,
    epc: epcQr(req.sepa, req.amount, reference),
  }
}

export interface PixPayment {
  account: PixAccount
  /** Centavos, as signed. */
  cents: string
  /** "12.50 BRL" */
  amountText: string
  /** The transaction id: the request's fingerprint, which the payer's app keeps with the payment. */
  reference: string
  /** The memo as field 26 carries it, plain and cut to fit. */
  description: string
  /** The BR Code: the QR payload, and the text a payer pastes as "Pix copia e cola". */
  code: string
}

/** Everything the payer needs for a Pix request, or null when the request is not one. */
export function pixPayment(req: PaymentRequest): PixPayment | null {
  if (req.unit !== 'brl' || !req.pix) return null
  const reference = `cells${requestHash(req).slice(2, 14)}`
  const amount = centsToMoney(req.amount)
  return {
    account: req.pix,
    cents: req.amount,
    amountText: `${amount} BRL`,
    reference,
    description: pixText(req.memo),
    code: brCode(req.pix, amount, req.memo, reference),
  }
}

export interface UpiPayment {
  account: UpiAccount
  /** Paise, as signed. */
  cents: string
  /** "12.50 INR" */
  amountText: string
  /** The transaction reference: the request's fingerprint. */
  reference: string
  /** The memo as the link carries it, plain and cut to fit. */
  note: string
  /** The upi://pay link: the QR payload, and what a UPI app opens. */
  uri: string
}

/** Everything the payer needs for a UPI request, or null when the request is not one. */
export function upiPayment(req: PaymentRequest): UpiPayment | null {
  if (req.unit !== 'inr' || !req.upi) return null
  const reference = `cells${requestHash(req).slice(2, 14)}`
  const amount = centsToMoney(req.amount)
  return {
    account: req.upi,
    cents: req.amount,
    amountText: `${amount} INR`,
    reference,
    note: upiText(req.memo).slice(0, UPI_NOTE_MAX).trim(),
    uri: upiUri(req.upi, amount, req.memo, reference),
  }
}

/** A request paid off the chain through a bank or payment rail, whichever one it names. */
export type BankPayment = ({ rail: 'sepa' } & SepaPayment) | ({ rail: 'pix' } & PixPayment) | ({ rail: 'upi' } & UpiPayment)

export function bankPayment(req: PaymentRequest): BankPayment | null {
  const s = sepaPayment(req)
  if (s) return { rail: 'sepa', ...s }
  const p = pixPayment(req)
  if (p) return { rail: 'pix', ...p }
  const u = upiPayment(req)
  if (u) return { rail: 'upi', ...u }
  return null
}

/** An account as it must appear in a request: every field canonical, so what is signed is what is shown. */
export function isSepaAccount(v: unknown): v is SepaAccount {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  return (
    typeof a.iban === 'string' &&
    normaliseIban(a.iban) === a.iban &&
    typeof a.name === 'string' &&
    isHolderName(a.name) &&
    (a.bic === null || (typeof a.bic === 'string' && normaliseBic(a.bic) === a.bic))
  )
}

export interface PaymentRequest {
  v: typeof REQUEST_VERSION
  /** The namespace id of the deployment, so a request cannot be replayed on another. */
  ns: Hex
  /** The label of the name asking to be paid, without `.cell`. */
  name: string
  /**
   * What `amount` counts. `ckb`: shannons, paid on the chain through this protocol.
   * `sat`: sats, paid over Lightning to the address the name publishes. Otherwise one
   * of the external chains above, counted in its smallest unit (satoshis, wei,
   * lamports). `eur`: cents, paid by bank transfer to the account the request itself
   * names. Absent in a link means `ckb`, so every request signed before the field
   * existed still verifies.
   */
  unit: 'ckb' | 'sat' | 'eur' | 'brl' | 'inr' | ExternalUnit
  /** Shannons, or sats for a Lightning request, or cents, as a decimal string (JSON has no bigint). */
  amount: string
  /**
   * For a euro request only: the bank account, carried in the signed bytes, because
   * the chain holds none. A link that changes it fails the signature.
   */
  sepa?: SepaAccount
  /** For a Pix request only (`brl`, centavos): the key, carried in the signed bytes. */
  pix?: PixAccount
  /** For a UPI request only (`inr`, paise): the ID, carried in the signed bytes. */
  upi?: UpiAccount
  memo: string
  /** Lock hash of the wallet this is addressed to, or null for anyone. */
  to: Hex | null
  /** Unix seconds after which the payer's app refuses it, or null. */
  expires: number | null
  nonce: Hex
  /** A recent block: the request cannot have been signed before it. */
  anchor: { number: number; hash: Hex } | null
}

export interface RequestSignature {
  signature: string
  identity: string
  signType: string
}

export interface SignedRequest {
  req: PaymentRequest
  sig: RequestSignature
}

/**
 * The exact bytes that are signed and hashed. Built key by key so the order never
 * depends on how the object happened to be constructed.
 */
export function requestMessage(req: PaymentRequest): string {
  return JSON.stringify({
    v: req.v,
    ns: req.ns,
    name: req.name,
    amount: req.amount,
    memo: req.memo,
    to: req.to,
    expires: req.expires,
    nonce: req.nonce,
    anchor: req.anchor ? { number: req.anchor.number, hash: req.anchor.hash } : null,
    // A CKB request carries no unit, so the bytes it signs are exactly what they
    // were before the field existed. Every other unit names itself, which keeps the
    // sat bytes identical to before this widened too.
    ...(req.unit !== 'ckb' ? { unit: req.unit } : {}),
    // A euro request carries its account in the signed bytes, after everything else,
    // so no other unit's bytes move. The shape is fixed here, key by key, as above.
    ...(req.unit === 'eur' && req.sepa ? { sepa: { iban: req.sepa.iban, name: req.sepa.name, bic: req.sepa.bic } } : {}),
    ...(req.unit === 'brl' && req.pix ? { pix: { key: req.pix.key, name: req.pix.name, city: req.pix.city } } : {}),
    ...(req.unit === 'inr' && req.upi ? { upi: { vpa: req.upi.vpa, name: req.upi.name } } : {}),
  })
}

/**
 * What a request asks for, in the unit it names. Derived from the request alone, so
 * it stays right when the chain no longer resolves an address for it: a page that
 * fell back to CKB formatting there would tell someone a request for one ETH was a
 * request for ten billion CKB, which is worse than saying nothing.
 */
export function requestAmountText(req: PaymentRequest): string {
  if (req.unit === 'sat') return `${req.amount} sats`
  if (req.unit === 'eur') return `${centsToEuro(req.amount)} EUR`
  if (req.unit === 'brl') return `${centsToMoney(req.amount)} BRL`
  if (req.unit === 'inr') return `${centsToMoney(req.amount)} INR`
  if (isExternalUnit(req.unit)) {
    const m = EXTERNAL_UNITS[req.unit]
    return `${baseToDecimal(req.amount, m.decimals)} ${m.ticker}`
  }
  return `${ccc.fixedPointToString(BigInt(req.amount))} CKB`
}

export function requestHash(req: PaymentRequest): Hex {
  return ccc.hashCkb(ccc.bytesFrom(requestMessage(req), 'utf8')) as Hex
}

/** The least a cell under `lock` can hold: 8 bytes of capacity plus the lock itself. */
export function minPaymentShannons(lock: ccc.Script): bigint {
  const argsLen = ccc.bytesFrom(lock.args).length
  return BigInt(8 + 32 + 1 + argsLen) * 100_000_000n
}

export interface CreateRequestOptions {
  name: string
  /** For a request paid on the chain: the amount in CKB. */
  amountCkb?: number
  /** For a request paid over Lightning: the amount in sats. The name must publish a Lightning address. */
  amountSats?: number
  /**
   * For a request paid on a chain this protocol does not settle: which, and how much
   * in that chain's smallest unit. The name must publish an address for it.
   */
  external?: { unit: ExternalUnit; amount: string }
  /**
   * For a request paid by bank transfer, in euros over SEPA: the amount in cents and
   * the account, which goes into the request itself. Nothing needs publishing.
   */
  sepa?: { amountCents: string; iban: string; name: string; bic?: string | null }
  /** For a request paid by Pix, in reais: the amount in centavos, the key, the receiver's name and city. */
  pix?: { amountCents: string; key: string; name: string; city: string }
  /** For a request paid by UPI, in rupees: the amount in paise, the UPI ID and the payee's name. */
  upi?: { amountCents: string; vpa: string; name: string }
  memo?: string
  /** An address or a lock hash. Omit to let anyone pay. */
  to?: string | null
  expiresAt?: number | null
}

/**
 * Sign a request as the owner of `name`. One wallet signature, no transaction.
 *
 * Refuses locally when the wallet is not the owner or the name has no CKB address
 * published, because a request nobody can pay is not worth signing.
 */
export async function createRequest(
  cells: CellsClient,
  signer: ccc.Signer,
  opts: CreateRequestOptions,
): Promise<SignedRequest> {
  const label = opts.name.replace(/\.cell$/, '')
  const acc = await cells.getAccount(label)
  if (!acc) throw new Error(`cells: ${label}.cell is not registered`)
  const me = ownerId((await signer.getRecommendedAddressObj()).script.hash() as Hex)
  // The manager may ask as well as the owner, for the same reason the verifier accepts
  // one: a manager already decides where the money goes. Refusing them would have left
  // every name whose owner is a cold key, quantum (decision 0016) or otherwise, unable
  // to ask for anything, since such an owner is deliberately not the wallet in hand.
  if (me !== acc.ownerLockHash && me !== acc.managerLockHash)
    throw new Error('cells: only the owner of a name, or the manager it nominated, can ask to be paid through it')

  let unit: PaymentRequest['unit'] = 'ckb'
  let amount: bigint
  let sepa: SepaAccount | undefined
  let pix: PixAccount | undefined
  let upi: UpiAccount | undefined
  if (opts.external) {
    // Paid on another chain, so there is nothing for this app to build or settle:
    // the request is a signed statement of what is owed, and the address the payer
    // is shown comes from the name's own records rather than from the link.
    const { unit: u, amount: raw } = opts.external
    const meta = EXTERNAL_UNITS[u]
    if (!meta) throw new Error(`cells: ${u} is not a chain a request can name`)
    if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n)
      throw new Error(`cells: the amount must be a whole number of the smallest ${meta.ticker} unit, above zero`)
    const rec = acc.records.find((r) => r.key === `address.${meta.coinType}`)?.value
    const addr = rec ? valueToText(rec) : null
    if (!addr) throw new Error(`cells: ${label}.cell has not published a ${meta.label} address, so nobody could pay it that way`)
    // Signing a request against a malformed address would produce a link the payer
    // cannot act on, and one whose displayed address could carry a query of its own.
    // Better to refuse here than to hand someone a bill nobody can pay.
    if (!isAddressForCoin(meta.coinType, addr))
      throw new Error(`cells: the ${meta.label} address ${label}.cell publishes is not well formed, so a request against it could not be paid`)
    if (opts.to) throw new Error(`cells: a ${meta.label} request cannot be addressed to one CKB wallet`)
    unit = u
    amount = BigInt(raw)
  } else if (opts.sepa) {
    // Paid from the payer's bank. The account is inside the request and nowhere
    // else, so the name needs nothing published; the signature is what makes the
    // account the name's. Every field is made canonical here, so the bytes signed are
    // the bytes the payer will be shown.
    const iban = normaliseIban(opts.sepa.iban)
    if (!iban) throw new Error('cells: that is not an IBAN inside SEPA, so a bank transfer could not reach it')
    const holder = opts.sepa.name.trim()
    if (!isHolderName(holder))
      throw new Error("cells: the account holder's name is what the payer's bank checks: one to seventy characters, as the bank has it")
    const rawBic = opts.sepa.bic?.trim() ?? ''
    const bic = rawBic ? normaliseBic(rawBic) : null
    if (rawBic && !bic) throw new Error('cells: that is not a BIC: eight or eleven letters and digits')
    if (!isEurCents(opts.sepa.amountCents))
      throw new Error('cells: the amount must be a whole number of cents, from one cent to 999,999,999.99 euros')
    if (opts.to) throw new Error('cells: a bank transfer request cannot be addressed to one CKB wallet')
    unit = 'eur'
    amount = BigInt(opts.sepa.amountCents)
    sepa = { iban, name: holder, bic }
  } else if (opts.pix) {
    // Paid by Pix. The key is inside the request, canonical, as the registry holds it.
    const key = normalisePixKey(opts.pix.key)
    if (!key)
      throw new Error('cells: that is not a Pix key: an email, a phone with +55, a CPF or CNPJ with its check digits, or a random key')
    const name = pixText(opts.pix.name)
    if (!isPixName(name)) throw new Error(`cells: the receiver's name goes into the code in plain letters, at most ${PIX_NAME_MAX} characters`)
    const city = pixText(opts.pix.city)
    if (!isPixCity(city)) throw new Error(`cells: the receiver's city goes into the code in plain letters, at most ${PIX_CITY_MAX} characters`)
    if (!isMoneyCents(opts.pix.amountCents))
      throw new Error('cells: the amount must be a whole number of centavos, from one centavo to 999,999,999.99 reais')
    if (opts.to) throw new Error('cells: a Pix request cannot be addressed to one CKB wallet')
    unit = 'brl'
    amount = BigInt(opts.pix.amountCents)
    pix = { key, name, city }
  } else if (opts.upi) {
    // Paid by UPI. The ID is inside the request, canonical, as the network holds it.
    const vpa = normaliseVpa(opts.upi.vpa)
    if (!vpa) throw new Error('cells: that is not a UPI ID: something@bank')
    const name = upiText(opts.upi.name)
    if (!isUpiName(name)) throw new Error(`cells: the payee's name goes into the link in plain letters, at most ${UPI_NAME_MAX} characters`)
    if (!isMoneyCents(opts.upi.amountCents))
      throw new Error('cells: the amount must be a whole number of paise, from one paisa to 999,999,999.99 rupees')
    if (opts.to) throw new Error('cells: a UPI request cannot be addressed to one CKB wallet')
    unit = 'inr'
    amount = BigInt(opts.upi.amountCents)
    upi = { vpa, name }
  } else if (opts.amountSats !== undefined) {
    // A Lightning request: the payer's own wallet pays the address the name
    // publishes, so the name must publish one, and anyone holding the link may pay.
    if (!parseLightning(acc.records)?.address)
      throw new Error(`cells: ${label}.cell has not published a Lightning address, so nobody could pay it over Lightning`)
    if (!Number.isInteger(opts.amountSats) || opts.amountSats < 1) throw new Error('cells: the amount must be a whole number of sats, at least one')
    if (opts.to) throw new Error('cells: a Lightning request cannot be addressed to one wallet')
    unit = 'sat'
    amount = BigInt(opts.amountSats)
  } else {
    if (opts.amountCkb === undefined) throw new Error('cells: give an amount, in CKB or in sats')
    const ckb = await cells.ckbAddress(label)
    if (!ckb) throw new Error(`cells: ${label}.cell has not published a CKB address, so nobody could pay it`)
    const payTo = (await ccc.Address.fromString(ckb.address, cells.client)).script
    if (!(opts.amountCkb > 0)) throw new Error('cells: the amount must be above zero')
    amount = ccc.fixedPointFrom(opts.amountCkb)
    const min = minPaymentShannons(payTo)
    if (amount < min)
      throw new Error(`cells: an on-chain payment to this address cannot be below ${ccc.fixedPointToString(min)} CKB`)
  }

  let to: Hex | null = null
  if (opts.to) {
    const t = opts.to.trim()
    to = (t.startsWith('0x') && t.length === 66 ? t : (await ccc.Address.fromString(t, cells.client)).script.hash()) as Hex
  }
  const tip = await cells.client.getTipHeader()
  const req: PaymentRequest = {
    v: REQUEST_VERSION,
    ns: cells.dep.configTypeHash,
    name: label,
    unit,
    amount: amount.toString(),
    memo: opts.memo ?? '',
    to,
    expires: opts.expiresAt ?? null,
    nonce: randomSecret(),
    anchor: { number: Number(tip.number), hash: tip.hash as Hex },
    ...(sepa ? { sepa } : {}),
    ...(pix ? { pix } : {}),
    ...(upi ? { upi } : {}),
  }
  const sig = await signer.signMessage(requestMessage(req))
  return { req, sig: { signature: sig.signature, identity: sig.identity, signType: sig.signType } }
}

// --- the link ---------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function encodeRequest(signed: SignedRequest): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(signed)))
}

const isHex = (v: unknown, bytes?: number) =>
  typeof v === 'string' && /^0x[0-9a-f]*$/i.test(v) && (bytes === undefined || v.length === 2 + bytes * 2)

/** A request read from untrusted bytes, or null if it is not one. */
function requestFromJson(r: any): PaymentRequest | null {
  const ok =
    r &&
    r.v === REQUEST_VERSION &&
    isHex(r.ns, 32) &&
    typeof r.name === 'string' &&
    typeof r.amount === 'string' &&
    /^\d+$/.test(r.amount) &&
    (r.unit === undefined || r.unit === 'ckb' || r.unit === 'sat' || r.unit === 'eur' || r.unit === 'brl' || r.unit === 'inr' || isExternalUnit(r.unit)) &&
    // A rail request must carry its canonical account; any other unit carries none.
    (r.unit !== 'eur' || isSepaAccount(r.sepa)) &&
    (r.unit !== 'brl' || isPixAccount(r.pix)) &&
    (r.unit !== 'inr' || isUpiAccount(r.upi)) &&
    typeof r.memo === 'string' &&
    (r.to === null || isHex(r.to, 32)) &&
    (r.expires === null || (typeof r.expires === 'number' && Number.isFinite(r.expires))) &&
    isHex(r.nonce) &&
    (r.anchor === null || (r.anchor && typeof r.anchor.number === 'number' && isHex(r.anchor.hash, 32)))
  if (!ok) return null
  return {
    v: REQUEST_VERSION,
    ns: r.ns,
    name: r.name,
    unit: r.unit === undefined ? 'ckb' : r.unit,
    amount: r.amount,
    memo: r.memo,
    to: r.to,
    expires: r.expires,
    nonce: r.nonce,
    anchor: r.anchor ? { number: r.anchor.number, hash: r.anchor.hash } : null,
    ...(r.unit === 'eur' ? { sepa: { iban: r.sepa.iban, name: r.sepa.name, bic: r.sepa.bic } } : {}),
    ...(r.unit === 'brl' ? { pix: { key: r.pix.key, name: r.pix.name, city: r.pix.city } } : {}),
    ...(r.unit === 'inr' ? { upi: { vpa: r.upi.vpa, name: r.upi.name } } : {}),
  }
}

/** Parse a link's payload. Throws on anything that is not a well-formed request. */
export function decodeRequest(encoded: string): SignedRequest {
  let j: any
  try {
    j = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded.trim())))
  } catch {
    throw new Error('cells: this is not a payment request')
  }
  const req = requestFromJson(j?.req)
  const s = j?.sig
  const okSig =
    s && typeof s.signature === 'string' && typeof s.identity === 'string' && typeof s.signType === 'string'
  if (!req || !okSig) throw new Error('cells: this is not a payment request')
  return { req, sig: { signature: s.signature, identity: s.identity, signType: s.signType } }
}

// --- verification -----------------------------------------------------------

/**
 * A genuine JoyID `signMessage` result is a JSON object with exactly these keys.
 * CCC's `verifyMessageJoyId` spreads the parsed signature over its own trusted
 * fields **after** setting them: `verifySignature({ challenge: message, pubkey:
 * identity.publicKey, keyType, ...JSON.parse(signature) })`. So any extra key in
 * the signature overrides a field we must control. `challenge` decouples the
 * WebAuthn check from our request, and `pubkey` makes it verify under a key of the
 * attacker's choosing instead of the one the owner lock is derived from. Either lets
 * a stranger forge "signed by the owner". We refuse a JoyID signature that carries
 * anything but the three real fields.
 */
const JOYID_SIG_KEYS = new Set(['signature', 'alg', 'message'])
export function joyIdSignatureIsHonest(signatureJson: string): boolean {
  let o: unknown
  try {
    o = JSON.parse(signatureJson)
  } catch {
    return false
  }
  if (!o || typeof o !== 'object') return false
  for (const k of Object.keys(o)) if (!JOYID_SIG_KEYS.has(k)) return false
  const s = o as { signature?: unknown; message?: unknown }
  return typeof s.signature === 'string' && typeof s.message === 'string'
}

/** Does the signature match the request bytes? Pure, needs no chain. */
export async function verifySignature(signed: SignedRequest): Promise<boolean> {
  try {
    // A quantum owner (decision 0016): CCC knows no such signature, so it is checked here.
    if (signed.sig.signType === PQ_SIGN_TYPE)
      return pqVerifyMessage(requestMessage(signed.req), signed.sig.signature as Hex, signed.sig.identity as Hex)
    if (signed.sig.signType === ccc.SignerSignType.JoyId && !joyIdSignatureIsHonest(signed.sig.signature)) return false
    const sig = new ccc.Signature(signed.sig.signature, signed.sig.identity, signed.sig.signType as ccc.SignerSignType)
    return await ccc.Signer.verifyMessage(requestMessage(signed.req), sig)
  } catch {
    return false
  }
}

/**
 * JoyID lock args for a main key: `0x0001 ‖ blake160(pubkey)`, pubkey being the
 * 64-byte uncompressed P-256 key. Checked against a real JoyID address and the
 * pubkey its own transaction carried in the witness (test vector in the SDK tests).
 */
export function joyIdLockArgs(publicKey: Hex): Hex {
  let pk = ccc.bytesFrom(publicKey)
  if (pk.length === 65 && pk[0] === 0x04) pk = pk.slice(1)
  if (pk.length !== 64) throw new Error('cells: a JoyID public key is 64 bytes')
  return ccc.hexFrom(ccc.bytesConcat(new Uint8Array([0x00, 0x01]), ccc.bytesFrom(ccc.hashCkb(pk)).slice(0, 20))) as Hex
}

/**
 * Where a signature stands in relation to a name: its owner, the seller of a name that
 * is listed for sale, its manager, or nobody.
 *
 * Extracted from `verifyRequest` on 2026-09-16 so that signing in as a name
 * (`login.ts`) asks the chain the same question that asking to be paid asks. Two copies
 * of "is this person alice.cell" would be two answers, and an attacker would pick the
 * looser one. It deliberately makes **no judgement**: it reports who signed and leaves
 * the caller to decide who is allowed, because a payment request accepts a manager and
 * a login does not.
 */
export interface SignerStanding {
  /** Every lock hash this identity can stand for. Empty for a wallet kind we cannot derive. */
  signerLocks: Hex[]
  /** Not a wallet kind this code knows. Treated as "not the owner": failing closed is the point. */
  unsupportedWallet: boolean
  /** The name as the chain has it, or null when it is not registered. */
  account: LiveAccount | null
  isOwner: boolean
  isManager: boolean
  /** The name is listed, so the owner the chain records is the offer lock and not a wallet. */
  listedForSale: boolean
  /** The name is held as a deed (decision 0036): its owner is a proxy lock over a Spore. */
  heldAsDeed: boolean
  signedBy: 'owner' | 'seller' | 'manager' | 'holder' | null
}

export async function signerStanding(cells: CellsClient, name: string, sig: RequestSignature): Promise<SignerStanding> {
  const locks = await locksForIdentity(cells.client, sig.signType, sig.identity)
  const signerLocks = locks.map((l) => l.hash() as Hex)
  const unsupportedWallet = locks.length === 0

  const account = await cells.getAccount(name)
  // A name stores the first twenty bytes of a lock hash, so the wallet side is truncated to match.
  const signerIds = signerLocks.map(ownerId)
  let isOwner = !!account && signerIds.includes(account.ownerLockHash)
  /**
   * The manager may sign too, and for a payment it grants nothing new: a manager already
   * edits the records, which is where the money goes, so a request they sign can ask for
   * no payment they could not already redirect. Refusing them would instead have broken
   * every name whose owner is a cold key, quantum (decision 0016) or otherwise, since
   * such an owner is deliberately not the wallet in the person's hand.
   */
  const isManager =
    !!account && !isOwner && account.managerLockHash !== account.ownerLockHash && signerIds.includes(account.managerLockHash)
  // A name that is up for sale is owned by the offer lock, not by a wallet, so a
  // signature from its owner would stop verifying the moment they listed it. The
  // seller is named in the lock's own args, which are part of the lock hash the name
  // records as its owner, so accepting them is as sound as accepting an owner.
  let listedForSale = false
  if (account && !isOwner && !unsupportedWallet) {
    const offer = (await cells.offers()).get(account.ownerLockHash)
    if (offer) {
      listedForSale = true
      isOwner = signerLocks.includes(offer.seller)
    }
  }
  // A name held as a deed (decision 0036) is owned by a proxy lock over a Spore, and
  // whoever holds the Spore is its owner in every way the chain enforces. The link is
  // followed on the chain, never taken from the request: owner id to proxy cell, proxy
  // cell to Spore, Spore to the lock that holds it.
  let heldAsDeed = false
  if (account && typeof account.id === 'string' && !isOwner && !isManager && !unsupportedWallet && !listedForSale) {
    // Two indexer reads on the chain. A node that will not answer leaves the request
    // exactly as unverified as it was, never verified.
    const deed = await deedOf(cells.client, account).catch(() => null)
    if (deed?.holder) {
      heldAsDeed = true
      isOwner = signerLocks.includes(deed.holder.lock.hash() as Hex)
    }
  }
  return {
    signerLocks,
    unsupportedWallet,
    account,
    isOwner,
    isManager,
    listedForSale,
    heldAsDeed,
    signedBy: isOwner ? (listedForSale ? 'seller' : heldAsDeed ? 'holder' : 'owner') : isManager ? 'manager' : null,
  }
}

/**
 * The lock scripts a signature's identity can stand for, derived with no wallet
 * present. Empty when the wallet kind is not one this code knows how to derive,
 * which the verifier treats as "not the owner": failing closed is the point.
 */
export async function locksForIdentity(client: ccc.Client, signType: string, identity: string): Promise<ccc.Script[]> {
  if (signType === PQ_SIGN_TYPE) {
    // The identity is the public key; the lock it stands for is derived from it alone.
    try {
      return [pqScript(ccc.bytesFrom(identity), pqNetworkOf(client))]
    } catch {
      return []
    }
  }
  switch (signType) {
    case ccc.SignerSignType.CkbSecp256k1:
      return [(await new ccc.SignerCkbPublicKey(client, identity).getAddressObjSecp256k1()).script]
    case ccc.SignerSignType.EvmPersonal:
      return (await new ccc.SignerEvmAddressReadonly(client, identity).getAddressObjs()).map((a) => a.script)
    case ccc.SignerSignType.JoyId: {
      let id: { keyType?: string; publicKey?: string }
      try {
        id = JSON.parse(identity)
      } catch {
        return []
      }
      // A sub-key unlocks the main key's lock through CoTA; its own pubkey derives nothing.
      if (id.keyType !== 'main_key' || typeof id.publicKey !== 'string') return []
      const pk = (id.publicKey.startsWith('0x') ? id.publicKey : '0x' + id.publicKey) as Hex
      let args: Hex
      try {
        args = joyIdLockArgs(pk)
      } catch {
        return []
      }
      const info = await client.getKnownScript(ccc.KnownScript.JoyId)
      return [ccc.Script.from({ codeHash: info.codeHash, hashType: info.hashType, args })]
    }
    default:
      return []
  }
}

export interface RequestVerification {
  /** Everything below holds: safe to show as signed by whoever `signedBy` names, and to pay. */
  ok: boolean
  /** Plain sentences, one per thing that is wrong. Empty when ok. */
  problems: string[]
  signatureValid: boolean
  /** Lock hashes the signer's key stands for. */
  signerLocks: Hex[]
  /**
   * The name has a manager who is not its owner. A manager may edit records, which
   * includes the address the money goes to, so "the owner nominated this address" is
   * not the whole truth for such a name and the page says so instead.
   */
  delegated: boolean
  /** The owner signed these bytes. False when the signature does not match them. */
  isOwner: boolean
  /** The name is up for sale, so the offer lock owns it and the signer is its seller. */
  listedForSale: boolean
  /**
   * Who signed, of the people entitled to: the owner, the seller while it is listed,
   * or the manager the owner nominated. Null when nobody entitled signed it, which
   * includes a signature that does not match the request: the standing is worked out
   * from the key the signature names, and a link changed after signing keeps that key.
   */
  signedBy: 'owner' | 'seller' | 'manager' | 'holder' | null
  unsupportedWallet: boolean
  namespaceOk: boolean
  expired: boolean
  account: LiveAccount | null
  /** Where the money goes, read from the name's own `address.309`, never from the request. Null for a Lightning request. */
  payTo: { address: string; lock: ccc.Script; lockHash: Hex; isOwner: boolean } | null
  /** For a Lightning request: the address the name publishes, read from the chain, never from the request. */
  lightning: string | null
  /**
   * For a request naming another chain: what the payer needs, all of it read from the
   * name's own records rather than from the link, so a tampered link cannot redirect
   * a payment.
   */
  external: {
    unit: ExternalUnit
    label: string
    ticker: string
    decimals: number
    address: string
    /** For a token unit: the chain and contract it settles on, mainnet values. */
    token: { chainId: number; token: string } | null
  } | null
  /**
   * For a euro request: the account, from the signed request itself, since the chain
   * holds none. A link that changed it fails the signature instead of redirecting.
   */
  sepa: SepaAccount | null
  /** For a Pix request: the key, from the signed request itself. */
  pix: PixAccount | null
  /** For a UPI request: the ID, from the signed request itself. */
  upi: UpiAccount | null
  minPaymentShannons: bigint | null
  amountOk: boolean
}

export async function verifyRequest(
  cells: CellsClient,
  signed: SignedRequest,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<RequestVerification> {
  const { req, sig } = signed
  const problems: string[] = []

  const namespaceOk = req.ns === cells.dep.configTypeHash
  if (!namespaceOk) problems.push('This request was made for a different deployment of Cells.')

  const signatureValid = await verifySignature(signed)
  if (!signatureValid) problems.push('The signature does not match the request. It may have been altered.')

  const standing = await signerStanding(cells, req.name, sig)
  const { signerLocks, unsupportedWallet, account, isOwner, isManager, listedForSale } = standing
  if (unsupportedWallet) problems.push('This request was signed with a kind of wallet this app cannot check.')
  if (!account) problems.push(`${req.name}.cell is not registered.`)
  if (account && !unsupportedWallet && !isOwner && !isManager)
    problems.push(`This request was not signed by the current owner of ${req.name}.cell, nor by its manager.`)

  const expired = req.expires !== null && nowSeconds > req.expires
  if (expired) problems.push('This request has expired.')

  let payTo: RequestVerification['payTo'] = null
  let lightning: string | null = null
  let external: RequestVerification['external'] = null
  let sepa: SepaAccount | null = null
  let pix: PixAccount | null = null
  let upi: UpiAccount | null = null
  let minPayment: bigint | null = null
  let amountOk = false
  if (account && isExternalUnit(req.unit)) {
    const meta = EXTERNAL_UNITS[req.unit]
    const v = account.records.find((r) => r.key === `address.${meta.coinType}`)?.value
    const address = v ? valueToText(v) : null
    if (!address)
      problems.push(`${req.name}.cell no longer publishes a ${meta.label} address, so it cannot be paid that way.`)
    else if (!isAddressForCoin(meta.coinType, address))
      problems.push(`The ${meta.label} address ${req.name}.cell publishes is not a well-formed ${meta.label} address, so nothing should be sent to it.`)
    else
      external = {
        unit: req.unit,
        label: meta.label,
        ticker: meta.ticker,
        decimals: meta.decimals,
        address,
        token: isTokenUnit(req.unit) ? tokenOf(req.unit, false) : null,
      }
    amountOk = BigInt(req.amount) > 0n
    if (!amountOk) problems.push('The amount must be above zero.')
  } else if (account && req.unit === 'eur') {
    if (!isSepaAccount(req.sepa)) problems.push('This request names no usable bank account.')
    else sepa = req.sepa
    amountOk = isEurCents(req.amount)
    if (!amountOk) problems.push('The amount must be between one cent and 999,999,999.99 euros.')
  } else if (account && req.unit === 'brl') {
    if (!isPixAccount(req.pix)) problems.push('This request names no usable Pix key.')
    else pix = req.pix
    amountOk = isMoneyCents(req.amount)
    if (!amountOk) problems.push('The amount must be between one centavo and 999,999,999.99 reais.')
  } else if (account && req.unit === 'inr') {
    if (!isUpiAccount(req.upi)) problems.push('This request names no usable UPI ID.')
    else upi = req.upi
    amountOk = isMoneyCents(req.amount)
    if (!amountOk) problems.push('The amount must be between one paisa and 999,999,999.99 rupees.')
  } else if (account && req.unit === 'sat') {
    lightning = parseLightning(account.records)?.address ?? null
    if (!lightning) problems.push(`${req.name}.cell no longer publishes a Lightning address, so it cannot be paid over Lightning.`)
    amountOk = BigInt(req.amount) >= 1n
    if (!amountOk) problems.push('The amount must be at least one sat.')
  } else if (account) {
    const ckb = await cells.ckbAddress(req.name)
    if (!ckb) problems.push(`${req.name}.cell has not published a CKB address, so it cannot be paid.`)
    else {
      const lock = (await ccc.Address.fromString(ckb.address, cells.client)).script
      payTo = { address: ckb.address, lock, lockHash: lock.hash() as Hex, isOwner: ckb.isOwner }
      minPayment = minPaymentShannons(lock)
      amountOk = BigInt(req.amount) >= minPayment
      if (!amountOk)
        problems.push(`The amount is below the ${ccc.fixedPointToString(minPayment)} CKB the blockchain needs for a payment.`)
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    signatureValid,
    signerLocks,
    isOwner: signatureValid && isOwner,
    listedForSale,
    signedBy: signatureValid ? standing.signedBy : null,
    unsupportedWallet,
    namespaceOk,
    external,
    sepa,
    pix,
    upi,
    delegated: !!account && account.managerLockHash !== account.ownerLockHash,
    expired,
    account,
    payTo,
    lightning,
    minPaymentShannons: minPayment,
    amountOk,
  }
}

// --- the payment ------------------------------------------------------------

const PAY_TAG = 'cells:pay:1'

/** The witness payload of a payment: the tag, a zero, the request hash, optionally the request itself. */
export function payWitness(hash: Hex, request: PaymentRequest | null): Hex {
  const parts = [ccc.bytesFrom(PAY_TAG, 'utf8'), new Uint8Array([0]), ccc.bytesFrom(hash)]
  if (request) parts.push(ccc.bytesFrom(requestMessage(request), 'utf8'))
  return ccc.hexFrom(ccc.bytesConcat(...parts)) as Hex
}

export function parsePayWitness(data: Hex): { hash: Hex; request: PaymentRequest | null } | null {
  const b = ccc.bytesFrom(data)
  const tag = ccc.bytesFrom(PAY_TAG, 'utf8')
  if (b.length < tag.length + 1 + 32) return null
  for (let i = 0; i < tag.length; i++) if (b[i] !== tag[i]) return null
  if (b[tag.length] !== 0) return null
  const hash = ccc.hexFrom(b.slice(tag.length + 1, tag.length + 33)) as Hex
  const rest = b.slice(tag.length + 33)
  let request: PaymentRequest | null = null
  if (rest.length > 0) {
    try {
      request = requestFromJson(JSON.parse(new TextDecoder().decode(rest)))
      if (request && requestHash(request) !== hash) request = null
    } catch {
      request = null
    }
  }
  return { hash, request }
}

/**
 * Put a payload after the witnesses of the inputs chosen so far. Call it once the inputs
 * are chosen and before the fee is completed.
 *
 * Not in witness 0: that is the payer's lock, and a JoyID sub key keeps its unlock proof
 * in its `output_type`. The JoyID signer does not add the proof when that field is taken
 * (`@ckb-ccc/joy-id` 1.1.9, `prepareTransactionForSubKey`), so a payment carrying the
 * request there could not be verified. If completing the fee adds an input, the payload
 * becomes the witness slot of that input, in the payer's own lock group, which the lock
 * hashes and does not parse.
 */
export function addAfterInputs(tx: ccc.Transaction, data: Hex): void {
  if (tx.inputs.length === 0) throw new Error('cells: add the payload once the inputs are chosen')
  while (tx.witnesses.length < tx.inputs.length) tx.witnesses.push('0x')
  tx.witnesses.push(data as ccc.Hex)
}

/**
 * The request a payment carries, wherever it is. Since 2026-09-26 it is a witness after the
 * inputs' (`addAfterInputs`); before that it was witness 0's `output_type`, and payments
 * made then must still match their requests.
 */
export function payRefIn(witnesses: readonly string[]): { hash: Hex; request: PaymentRequest | null } | null {
  for (const w of witnesses) {
    const ref = parsePayWitness(w as Hex)
    if (ref) return ref
  }
  if (witnesses.length === 0) return null
  try {
    const w = ccc.WitnessArgs.fromBytes(witnesses[0] as ccc.Hex)
    return w.outputType ? parsePayWitness(w.outputType as Hex) : null
  } catch {
    return null
  }
}

export interface PayOptions {
  /** Put the whole request, memo included, on the chain with the payment. Default: only its hash. */
  includeRequest?: boolean
  /** Pay even though the request is addressed to a different wallet. */
  ignoreAddressee?: boolean
  /** Pay even though this wallet is the one the name is paid to (the money comes straight back). */
  allowSelf?: boolean
}

/**
 * Pay a request. One transaction, one signature: a plain transfer to the address
 * the name publishes, with the request's hash in the witness so the payment can be
 * matched to what was asked. Refuses anything `verifyRequest` would refuse.
 */
export async function payRequest(
  cells: CellsClient,
  signer: ccc.Signer,
  signed: SignedRequest,
  opts: PayOptions = {},
): Promise<Hex> {
  if (signed.req.unit === 'sat')
    throw new Error('cells: this request asks for sats over Lightning; pay it from a Lightning wallet, not on the chain')
  if (signed.req.unit === 'eur')
    throw new Error('cells: this request asks for euros by bank transfer; pay it from your bank, not on the chain')
  if (signed.req.unit === 'brl') throw new Error('cells: this request asks for reais by Pix; pay it from your bank app, not on the chain')
  if (signed.req.unit === 'inr') throw new Error('cells: this request asks for rupees by UPI; pay it from a UPI app, not on the chain')
  if (isExternalUnit(signed.req.unit))
    throw new Error(
      `cells: this request asks for ${EXTERNAL_UNITS[signed.req.unit].label}; pay it from a ${EXTERNAL_UNITS[signed.req.unit].label} wallet, not on the CKB chain`,
    )
  const v = await verifyRequest(cells, signed)
  if (!v.ok || !v.payTo) throw new Error('cells: ' + (v.problems[0] ?? 'this request cannot be paid'))
  const me = (await signer.getRecommendedAddressObj()).script.hash() as Hex
  if (signed.req.to && !opts.ignoreAddressee && me !== signed.req.to)
    throw new Error('cells: this request is addressed to a different wallet')
  // The name's payout wallet paying its own request moves nothing but the fee.
  if (me === v.payTo.lockHash && !opts.allowSelf)
    throw new Error('cells: this wallet is the one the name is paid to, so paying from it only sends the money back to itself, minus a fee')
  const tx = ccc.Transaction.from({
    outputs: [{ lock: v.payTo.lock, capacity: BigInt(signed.req.amount) }],
    outputsData: ['0x'],
  })
  await tx.completeInputsByCapacity(signer)
  // The payload goes in before the fee is computed, so the fee covers it: with the
  // whole request recorded it is a few hundred bytes, enough to fall under the
  // node's floor if added afterwards.
  addAfterInputs(tx, payWitness(requestHash(signed.req), opts.includeRequest ? signed.req : null))
  await tx.completeFeeBy(signer, 2000)
  const sent = await signer.signTransaction(tx)
  const h = (await cells.client.sendTransaction(sent)) as Hex
  await cells.client.waitTransaction(h, 0, 300_000)
  return h
}

// --- the receipt ------------------------------------------------------------

export interface Receipt {
  txHash: Hex
  status: string
  blockNumber: number | null
  /** Unix seconds of the block, once mined. */
  timestamp: number | null
  /** The request hash the payment carries, if it was made through a request. */
  requestHash: Hex | null
  /** The request itself, if the payer chose to record it. */
  request: PaymentRequest | null
  /** The meal it carries, if it was a payment made to a name (see meal.ts). */
  meal: Meal | null
  outputs: { lock: ccc.Script; lockHash: Hex; capacity: bigint }[]
  /** What was spent, so a receipt can tell who paid, and whether it was the payee. */
  inputs: { lock: ccc.Script; lockHash: Hex; capacity: bigint }[]
}

// A committed transaction never changes, so once we have parsed its receipt we keep
// it for the session. Re-opening a payment history then skips the getTransaction +
// per-input getCell reads for every transaction already seen, which is the whole cost
// of the walk. Only committed receipts are cached; a pending one is read fresh so its
// status can still change. Immutable data, so it never needs invalidating.
const receiptCache = new Map<Hex, Receipt>()

export async function readReceipt(client: ccc.Client, txHash: Hex): Promise<Receipt | null> {
  const cached = receiptCache.get(txHash)
  if (cached) return cached
  const r = await client.getTransactionWithHeader(txHash)
  if (!r) return null
  const tx = r.transaction.transaction
  const ref = payRefIn(tx.witnesses)
  // The input cells are read in parallel: a receipt with many inputs would otherwise
  // cost one sequential round-trip each, and a scan reads many receipts.
  const inputCells = await Promise.all(tx.inputs.map((i) => client.getCell(i.previousOutput)))
  const inputs: Receipt['inputs'] = inputCells.flatMap((c) =>
    c ? [{ lock: c.cellOutput.lock, lockHash: c.cellOutput.lock.hash() as Hex, capacity: c.cellOutput.capacity }] : [],
  )
  const receipt: Receipt = {
    txHash,
    status: r.transaction.status,
    blockNumber: r.header ? Number(r.header.number) : null,
    timestamp: r.header ? Math.floor(Number(r.header.timestamp) / 1000) : null,
    requestHash: ref?.hash ?? null,
    request: ref?.request ?? null,
    meal: mealIn(tx.witnesses),
    outputs: tx.outputs.map((o) => ({ lock: o.lock, lockHash: o.lock.hash() as Hex, capacity: o.capacity })),
    inputs,
  }
  if (receipt.status === 'committed') {
    // Bound it so a long session cannot grow the map without limit; receipts are
    // cheap to refetch, so dropping the whole set on overflow is fine.
    if (receiptCache.size >= 2000) receiptCache.clear()
    receiptCache.set(txHash, receipt)
  }
  return receipt
}

/** True when the wallet the name is paid to also paid: the money came straight back. */
export function paidBySelf(receipt: Receipt, payToLockHash: Hex): boolean {
  return receipt.inputs.some((i) => i.lockHash === payToLockHash)
}

/** Shannons a receipt delivered to `lockHash`. */
export function paidTo(receipt: Receipt, lockHash: Hex): bigint {
  return receipt.outputs.filter((o) => o.lockHash === lockHash).reduce((s, o) => s + o.capacity, 0n)
}

/**
 * The amount a payment carried to `lockHash`. `payRequest` puts the payment first
 * and any change after it, so when the payee and the payer are the same wallet the
 * first output is the payment and the rest is change coming home; summing everything
 * would call a 1000 CKB self-payment a 199 999 CKB one.
 */
export function paymentAmountTo(receipt: Receipt, lockHash: Hex): bigint {
  const first = receipt.outputs[0]
  if (first && first.lockHash === lockHash && paidBySelf(receipt, lockHash)) return first.capacity
  return paidTo(receipt, lockHash)
}

// --- history ----------------------------------------------------------------

export interface PaymentRecord {
  txHash: Hex
  blockNumber: number | null
  timestamp: number | null
  /** The request's fingerprint, or null for a plain transfer to the address. */
  requestHash: Hex | null
  /** The request, when the payer chose to record it. */
  request: PaymentRequest | null
  /** Received: what reached the lock. Sent: what left it for other locks. */
  amount: bigint
  /** Received: the locks that paid. Sent: the locks that were paid. */
  counterparties: Hex[]
  /** The lock is on both sides: it paid its own request. */
  self: boolean
}

export interface PaymentScan {
  records: PaymentRecord[]
  /** Transactions looked at this call; pass `skip + scanned` to continue. */
  scanned: number
  /** No older transactions remain. */
  done: boolean
}

export interface ScanOptions {
  /** Transactions to skip first (from a previous scan's `skip + scanned`). */
  skip?: number
  /** At most this many transactions are read per call, so a busy address stays cheap. */
  maxScan?: number
  /** Stop early once this many payments are found. */
  want?: number
}

/**
 * Payments made through requests, found by walking the lock's transactions newest
 * first and keeping those whose witness carries the payment tag. No server and no
 * index of our own: the chain is the history. Costs one or two reads per transaction
 * looked at, which is why it walks in bounded steps.
 */
/** Map with bounded concurrency, preserving input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function scanPayments(
  client: ccc.Client,
  lock: ccc.Script,
  direction: 'to' | 'from',
  opts: ScanOptions = {},
): Promise<PaymentScan> {
  const lockHash = lock.hash() as Hex
  const skip = opts.skip ?? 0
  const maxScan = opts.maxScan ?? 40
  const want = opts.want ?? 10

  // Walk the lock's transactions newest first (indexer only, cheap) and collect the
  // bounded window, keeping those whose grouped answer shows the lock on the side we
  // care about, so a transaction that cannot match costs no receipt read.
  const candidates: Hex[] = []
  let seen = 0
  let scanned = 0
  let done = true
  for await (const t of client.findTransactionsByLock(lock, null, true, 'desc')) {
    if (seen++ < skip) continue
    if (scanned >= maxScan) {
      done = false
      break
    }
    scanned++
    const sides = (t as { cells?: { isInput: boolean }[] }).cells
    if (sides && !sides.some((c) => (direction === 'to' ? !c.isInput : c.isInput))) continue
    candidates.push(t.txHash as Hex)
  }

  // The receipts are the expensive part, a read per transaction and a read per input
  // inside it, so fetch the window in parallel rather than one transaction at a time.
  const receipts = await mapPool(candidates, 8, (h) => readReceipt(client, h))

  const records: PaymentRecord[] = []
  for (const r of receipts) {
    if (records.length >= want) break
    if (!r) continue
    // What went out is only interesting through a request; a wallet's ordinary sends
    // are its own business. What came in is every transfer, tagged or not, except a
    // plain one the address made to itself, which is change coming home, not income.
    if (!r.requestHash && (direction === 'from' || paidBySelf(r, lockHash))) continue
    const self = paidBySelf(r, lockHash) && r.outputs.some((o) => o.lockHash === lockHash)
    const base = { txHash: r.txHash, blockNumber: r.blockNumber, timestamp: r.timestamp, requestHash: r.requestHash, request: r.request, self }
    if (direction === 'to') {
      const amount = paymentAmountTo(r, lockHash)
      if (amount === 0n) continue
      records.push({ ...base, amount, counterparties: [...new Set(r.inputs.map((i) => i.lockHash))].filter((h) => h !== lockHash) })
    } else {
      if (!r.inputs.some((i) => i.lockHash === lockHash)) continue
      const others = r.outputs.filter((o) => o.lockHash !== lockHash)
      const amount = self && others.length === 0 ? paymentAmountTo(r, lockHash) : others.reduce((s, o) => s + o.capacity, 0n)
      records.push({ ...base, amount, counterparties: [...new Set(others.map((o) => o.lockHash))] })
    }
  }
  return { records, scanned, done }
}

// --- meals ------------------------------------------------------------------

export interface MealRecord {
  txHash: Hex
  blockNumber: number | null
  /** Unix seconds of the block. */
  timestamp: number | null
  /** What reached the name's address. */
  amount: bigint
  /** Who paid: the first input that is not the name's own address. */
  payer: { lock: ccc.Script; lockHash: Hex }
  /** What they said with it, cleaned; empty when nothing was said. */
  note: string
}

export interface MealScan {
  meals: MealRecord[]
  /** Transactions looked at this call; pass `skip + scanned` to continue. */
  scanned: number
  /** No older transactions remain. */
  done: boolean
}

/**
 * The meals a name has had, newest first: payments into the address it publishes that
 * carry a meal naming it (meal.ts). The same bounded walk as the payment history and the
 * same cached receipts, so opening a being twice reads the chain once. A payment without
 * the meal, or for another name paid to the same address, is not this name's meal; money
 * the address sent itself is change, whatever it carries.
 */
export async function scanMeals(client: ccc.Client, payTo: ccc.Script, name: string, opts: ScanOptions = {}): Promise<MealScan> {
  const lockHash = payTo.hash() as Hex
  const skip = opts.skip ?? 0
  const maxScan = opts.maxScan ?? 40
  const want = opts.want ?? 20
  const candidates: Hex[] = []
  let seen = 0
  let scanned = 0
  let done = true
  for await (const t of client.findTransactionsByLock(payTo, null, true, 'desc')) {
    if (seen++ < skip) continue
    if (scanned >= maxScan) {
      done = false
      break
    }
    scanned++
    const sides = (t as { cells?: { isInput: boolean }[] }).cells
    if (sides && !sides.some((c) => !c.isInput)) continue
    candidates.push(t.txHash as Hex)
  }
  const receipts = await mapPool(candidates, 8, (h) => readReceipt(client, h))
  const meals: MealRecord[] = []
  for (const r of receipts) {
    if (meals.length >= want) break
    if (!r || !r.meal || r.meal.to !== name) continue
    if (paidBySelf(r, lockHash)) continue
    const amount = paidTo(r, lockHash)
    if (amount === 0n) continue
    const payer = r.inputs.find((i) => i.lockHash !== lockHash)
    if (!payer) continue
    meals.push({
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      amount,
      payer: { lock: payer.lock, lockHash: payer.lockHash },
      note: r.meal.note,
    })
  }
  return { meals, scanned, done }
}

export interface PaymentFound {
  txHash: Hex
  status: string
  blockNumber: number | null
  timestamp: number | null
  /** What actually reached the payee, which is what a receipt should show. */
  amount: bigint
}

export interface PaymentSearch {
  /**
   * The payment that settled the request: set only once what arrived carrying its
   * fingerprint reaches what it asked, and then the one whose arrival got it there.
   */
  payment: PaymentFound | null
  /**
   * What arrived carrying the fingerprint while it is less than was asked, and the
   * payments that brought it, newest first. It is not a payment of the request, so a
   * screen shows it as so much of so much, never as paid. Null when nothing arrived,
   * and once the request is paid.
   */
  short: { received: bigint; asked: bigint; payments: PaymentFound[] } | null
  /**
   * Whether "not paid", or "paid only this much", is a safe thing to conclude. False
   * when a transaction could not be read or the bounded walk ran out, in which case
   * the honest answer is "I could not tell", not "it is unpaid". This distinction is
   * the whole reason the result is not a single answer: a caller using it to stop a
   * second payment must not treat a dropped read as an all-clear.
   */
  conclusive: boolean
}

/**
 * Whether the chain holds the anchor's block: one at that height, with that hash. A
 * node that will not say counts as no, which only makes a search look further back.
 */
async function anchorOnChain(client: ccc.Client, anchor: { number: number; hash: Hex }): Promise<boolean> {
  if (!Number.isSafeInteger(anchor.number) || anchor.number < 0) return false
  try {
    const header = await client.getHeaderByNumber(anchor.number)
    return !!header && header.hash.toLowerCase() === anchor.hash.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Has this request been paid, in full?
 *
 * A payment made through a request carries the request's fingerprint in its witness,
 * which is the whole point of putting it there: the two can be tied together later by
 * anyone, from the chain, with no record kept by us. The fingerprint says which
 * request a payment cites, not that it settled it: 61 CKB can carry the fingerprint of
 * a request for 10,000. So what arrived carrying it is added up, and the request is
 * paid once that reaches what it asked, and not before.
 *
 * This walks the payee's transactions newest first and stops as soon as one is older
 * than the block the request was anchored to, when the chain holds that block, because
 * a payment cannot predate the request that asked for it. So the search is bounded by
 * when the request was made, not by how busy the address has been since.
 *
 * It takes the request itself, not its fingerprint, because the amount and the anchor
 * are in the request. Only a CKB request is paid on this chain; any other unit is
 * refused rather than answered.
 */
export async function findPayment(
  client: ccc.Client,
  payToLock: ccc.Script,
  request: PaymentRequest,
  maxScan = 60,
): Promise<PaymentSearch> {
  if (!request || typeof request !== 'object')
    throw new Error('cells: findPayment takes the request, so that what arrived can be compared with what it asked')
  if (request.unit !== 'ckb')
    throw new Error(`cells: this request asks for ${requestAmountText(request)}, which is not paid on the CKB chain`)
  const fingerprint = requestHash(request)
  const asked = BigInt(request.amount)
  const lockHash = payToLock.hash() as Hex
  const hashes: Hex[] = []
  let scanned = 0
  let ranOut = false
  for await (const t of client.findTransactionsByLock(payToLock, null, true, 'desc')) {
    if (scanned++ >= maxScan) {
      ranOut = true
      break
    }
    // Only the side where money arrives; a transaction that merely spends from this
    // address cannot be a payment to it, and skipping it saves a receipt read.
    const sides = (t as { cells?: { isInput: boolean }[] }).cells
    if (sides && !sides.some((c) => !c.isInput)) continue
    hashes.push(t.txHash as Hex)
  }
  const receipts = await mapPool(hashes, 8, (h) => readReceipt(client, h).catch(() => null))
  // A transaction we could not read might have been the payment, so it makes the
  // answer inconclusive rather than being quietly skipped. Under a loaded public
  // node this is exactly how a paid request came back looking unpaid.
  let unreadable = false
  // Only set by actually walking PAST the request's own anchor. Starting it true
  // when there is no lower bound would call a search conclusive that had simply run
  // out of window, which is the opposite of what this flag is for.
  let reachedTheRequest = false
  // The anchor comes out of the request, so it is chosen by whoever signed it: the
  // payee. It is a hint about where to stop looking, never evidence about what is
  // there. An anchor ahead of the chain made the very first transaction "older than
  // the request", so the walk broke before comparing a single fingerprint and a real
  // payment came back as a confident "not paid", which is a payer being told by the
  // payee to pay a second time. Dropping a bound nothing had reached was not enough:
  // once the chain passed the made-up height, one transfer either side of it ended
  // the walk before the payment again. So the anchor bounds the walk only when the
  // chain holds a block at that height with that hash. Nobody can name a block's hash
  // before the block exists, so a request carrying a real one was signed after it,
  // and every payment citing the request came later still. Any other anchor bounds
  // nothing, and the window decides.
  const bound = request.anchor && (await anchorOnChain(client, request.anchor)) ? request.anchor.number : null
  const found: PaymentFound[] = []
  for (const r of receipts) {
    if (!r) {
      unreadable = true
      continue
    }
    // Evidence already in hand is always read before any bound is allowed to stop
    // the walk. The receipt is fetched either way, so this costs nothing.
    if (r.requestHash === fingerprint) {
      const amount = paymentAmountTo(r, lockHash)
      if (amount > 0n) found.push({ txHash: r.txHash, status: r.status, blockNumber: r.blockNumber, timestamp: r.timestamp, amount })
    }
    if (bound !== null && r.blockNumber !== null && r.blockNumber < bound) {
      reachedTheRequest = true
      break
    }
  }
  // Counted oldest first, so the payment named is the one that brought the total up
  // to what was asked.
  let received = 0n
  for (const p of [...found].reverse()) {
    received += p.amount
    if (received >= asked) return { payment: p, short: null, conclusive: true }
  }
  // Walking past the request's own anchor is what makes "not paid" trustworthy; if
  // the window ran out first, we simply have not looked far enough back.
  return {
    payment: null,
    short: found.length > 0 ? { received, asked, payments: found } : null,
    conclusive: !unreadable && (reachedTheRequest || !ranOut),
  }
}

/**
 * Everything that reached `lock`, newest first: a payment through a request carries
 * its fingerprint, a plain transfer carries none, and the address's own change is
 * left out.
 */
export function paymentsTo(client: ccc.Client, lock: ccc.Script, opts: ScanOptions = {}): Promise<PaymentScan> {
  return scanPayments(client, lock, 'to', opts)
}

/** Payments through requests that `lock` made, newest first. */
export function paymentsFrom(client: ccc.Client, lock: ccc.Script, opts: ScanOptions = {}): Promise<PaymentScan> {
  return scanPayments(client, lock, 'from', opts)
}
