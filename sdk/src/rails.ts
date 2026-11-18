// Pix (Brazil) and UPI (India): the account a request can name on each rail, the
// checks that make it canonical, and the code the payer's app scans (decision 0018).
// Pure: nothing here knows about requests, the chain or the browser. The request side
// (the unit, the signed bytes, the verification) is in request.ts, which imports this.

/** A Pix destination: the key, and the receiver's name and city the code must carry. */
export interface PixAccount {
  /**
   * A Pix key in the form the registry holds it: an email, a phone as +55…, a CPF or
   * CNPJ as digits, or a random key (a UUID).
   */
  key: string
  /** The receiver's name, at most 25 characters, accents dropped. */
  name: string
  /** The receiver's city, at most 15 characters, accents dropped. */
  city: string
}

/** A UPI destination: the ID (a virtual payment address) and the payee's name. */
export interface UpiAccount {
  /** The UPI ID, lower case: something@bank. */
  vpa: string
  /** The payee's name, at most 50 characters, plain letters. */
  name: string
}

/** CPF check digits, two of them, and not eleven of the same digit. */
export function isCpf(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false
  for (const n of [9, 10]) {
    let s = 0
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i)
    let dv = (s * 10) % 11
    if (dv === 10) dv = 0
    if (dv !== Number(d[n])) return false
  }
  return true
}

/** CNPJ check digits, two of them, and not fourteen of the same digit. */
export function isCnpj(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const w2 = [6, ...w1]
  for (const [n, w] of [
    [12, w1],
    [13, w2],
  ] as const) {
    let s = 0
    for (let i = 0; i < n; i++) s += Number(d[i]) * w[i]
    const dv = s % 11 < 2 ? 0 : 11 - (s % 11)
    if (dv !== Number(d[n])) return false
  }
  return true
}

/**
 * The email keys the registry accepts, as the DICT API itself writes the rule
 * (bacen/pix-dict-api, openapi.yaml): lower case, at most 77 characters, and only
 * these ASCII characters. So an email key is plain ASCII, one byte a character.
 */
const PIX_EMAIL = /^[a-z0-9.!#$&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/**
 * A Pix key in the form the registry holds it, or null. A phone must carry +55,
 * because eleven bare digits are also the shape of a CPF, and a guess here would be a
 * guess about where someone's money goes. A CPF or CNPJ must pass its check digits,
 * so a typo is caught before anything is signed.
 */
export function normalisePixKey(v: string): string | null {
  const s = v.trim()
  if (!s) return null
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s.toLowerCase()
  if (s.includes('@')) {
    const email = s.toLowerCase()
    return email.length <= 77 && PIX_EMAIL.test(email) ? email : null
  }
  const digits = s.replace(/[\s()./-]/g, '')
  if (/^\+55\d{10,11}$/.test(digits)) return digits
  if (/^\d{11}$/.test(digits)) return isCpf(digits) ? digits : null
  if (/^\d{14}$/.test(digits)) return isCnpj(digits) ? digits : null
  return null
}

/**
 * Text as a Pix payload carries it: accents dropped, only letters, digits, space
 * and a few marks kept, one space between words. The apps that scan the code expect
 * the plain set, and a name the payer's app cannot show is worse than one without
 * its accent.
 */
export function pixText(v: string): string {
  return v
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9 .,/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
export const PIX_NAME_MAX = 25
export const PIX_CITY_MAX = 15
export const isPixName = (v: string): boolean => v.length >= 1 && v.length <= PIX_NAME_MAX && v === pixText(v)
export const isPixCity = (v: string): boolean => v.length >= 1 && v.length <= PIX_CITY_MAX && v === pixText(v)

/** An account as it must appear in a request: every field canonical. */
export function isPixAccount(v: unknown): v is PixAccount {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  return (
    typeof a.key === 'string' &&
    normalisePixKey(a.key) === a.key &&
    typeof a.name === 'string' &&
    isPixName(a.name) &&
    typeof a.city === 'string' &&
    isPixCity(a.city)
  )
}

/**
 * CRC-16/CCITT-FALSE, the checksum a BR Code ends with: polynomial 0x1021, initial
 * value 0xFFFF, no reflection. Four upper-case hex digits. Its check value for
 * "123456789" is 29B1, which the tests pin.
 */
export function crc16(s: string): string {
  let crc = 0xffff
  for (const b of new TextEncoder().encode(s)) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/**
 * One EMV field: a two-digit id, a two-digit length, the value. The standard counts the
 * length in characters, and some readers count bytes; in printable ASCII, the only set a
 * Pix field is written in, the two are the same, so anything else is refused here rather
 * than written with a length one reader or another gets wrong.
 */
const tlv = (id: string, value: string): string => {
  if (!/^[ -~]*$/.test(value)) throw new Error('cells: a BR Code field carries printable ASCII only')
  return id + String(value.length).padStart(2, '0') + value
}

/**
 * A static BR Code, the Pix QR payload, after Banco Central's standard for Pix
 * initiation on EMVCo's merchant-presented QR: the Pix GUI and the key in field 26,
 * currency 986, the amount when there is one, BR, the receiver's name and city, the
 * transaction id in field 62, and the CRC over everything before it. The same string
 * is what a Brazilian pastes into their app as "Pix copia e cola".
 *
 * The description is cut to what field 26 has room for, 99 characters in all; the
 * transaction id never is.
 */
export function brCode(account: PixAccount, amount: string | null, description: string, txid: string): string {
  const desc = pixText(description)
  const room = 99 - (4 + 14) - (4 + account.key.length) - 4
  const info = tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', account.key) + (desc && room > 0 ? tlv('02', desc.slice(0, room).trim()) : '')
  const body =
    tlv('00', '01') +
    tlv('26', info) +
    tlv('52', '0000') +
    tlv('53', '986') +
    (amount ? tlv('54', amount) : '') +
    tlv('58', 'BR') +
    tlv('59', account.name) +
    tlv('60', account.city) +
    tlv('62', tlv('05', txid)) +
    '6304'
  return body + crc16(body)
}

/** A UPI ID as the network holds it, lower case, or null. */
export function normaliseVpa(v: string): string | null {
  const s = v.trim().toLowerCase()
  return /^[a-z0-9._-]{2,256}@[a-z]{2,64}$/.test(s) ? s : null
}

/** Text as a UPI link carries it: plain letters, digits, space and a few marks. */
export function upiText(v: string): string {
  return pixText(v)
}
export const UPI_NAME_MAX = 50
export const UPI_NOTE_MAX = 50
export const isUpiName = (v: string): boolean => v.length >= 1 && v.length <= UPI_NAME_MAX && v === upiText(v)

export function isUpiAccount(v: unknown): v is UpiAccount {
  if (!v || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  return typeof a.vpa === 'string' && normaliseVpa(a.vpa) === a.vpa && typeof a.name === 'string' && isUpiName(a.name)
}

/**
 * The UPI payment link, after NPCI's linking specification, which is also what a UPI
 * QR code carries: the payee address and name, the amount in rupees with two
 * decimals, INR, a note, and a reference the payer's app keeps with the transaction.
 * The address goes in plain, as every UPI code writes it; the texts are percent
 * encoded. A UPI app on the payer's phone opens the link directly.
 */
export function upiUri(account: UpiAccount, amount: string | null, note: string, ref: string): string {
  const parts = [`pa=${account.vpa}`, `pn=${encodeURIComponent(account.name)}`]
  if (amount) parts.push(`am=${amount}`)
  parts.push('cu=INR')
  const tn = upiText(note).slice(0, UPI_NOTE_MAX).trim()
  if (tn) parts.push(`tn=${encodeURIComponent(tn)}`)
  if (ref) parts.push(`tr=${ref}`)
  return `upi://pay?${parts.join('&')}`
}
