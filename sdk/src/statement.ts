/**
 * A statement signed by a name, that anybody can check later (decision 0039).
 *
 * "telmo.cell wrote this article", "@telmo on X is telmo.cell": words a name puts its
 * signature to, in public, for strangers to check against the chain with no account and
 * no call to us. It is the payment request's and the login's machinery pointed at a third
 * question, and it shares their answer to "is this person the owner of alice.cell"
 * (`signerStanding`), because two answers would be two things to keep in step.
 *
 * ## It cannot be read as anything else
 *
 * The bytes open with `{"t":"cells.statement.v1"`, where a login opens
 * `{"t":"cells.login.v1"` and a payment request `{"v":1`. A statement signature can never
 * be replayed as a login or a demand for money, nor the other way round; the tests build
 * all three and compare them. `ns` ties it to one deployment, so testnet words are
 * worthless on mainnet.
 *
 * ## Who signed it, when the name has changed hands
 *
 * Against the owner today, and otherwise against the name's own history, read back from
 * the chain: a key that owned the name before is reported as that, with the block its
 * ownership ended, and never as the owner now. The time in the statement is the signer's
 * word and nothing checks it, so a former owner is never said to have signed while they
 * held the name. The attacks each other rule leaves open are in 0039.
 */
import { ccc } from '@ckb-ccc/core'
import type { Hex } from './codec.ts'
import { ownerId, parseAccountLite } from './codec.ts'
import type { CellsClient, LiveAccount } from './client.ts'
import { PQ_SIGN_TYPE, pqVerifyMessage } from './pq.ts'
import { joyIdSignatureIsHonest, signerStanding, type RequestSignature } from './request.ts'

/** The tag that opens the signed bytes. Bump the version and old statements stop verifying. */
export const STATEMENT_TAG = 'cells.statement.v1' as const

/** What a wallet shows before signing has to be readable, so the words are kept short. */
export const STATEMENT_MAX_TEXT = 1000

/** What the name says. Every field is in the signed bytes. */
export interface Statement {
  /** Always `cells.statement.v1`, and the first key, so these bytes are only ever a statement. */
  t: typeof STATEMENT_TAG
  /** Which deployment of Cells: the config type hash. */
  ns: Hex
  /** The name, without `.cell`. */
  name: string
  /** The words. */
  text: string
  /** Unix seconds, as the signer's clock had it. Nothing checks it. */
  signed: number
}

export interface SignedStatement {
  statement: Statement
  sig: RequestSignature
}

/** The exact bytes that are signed, built key by key so the order never depends on the object. */
export function statementMessage(s: Statement): string {
  return JSON.stringify({ t: STATEMENT_TAG, ns: s.ns, name: s.name, text: s.text, signed: s.signed })
}

export function statementHash(s: Statement): Hex {
  return ccc.hashCkb(ccc.bytesFrom(statementMessage(s), 'utf8')) as Hex
}

/** Why these words cannot be signed, or null. Asked before the wallet is, never after. */
export function statementTextProblem(text: string): string | null {
  if (text.trim() === '') return 'There is nothing to sign.'
  if ([...text].length > STATEMENT_MAX_TEXT) return `A statement is at most ${STATEMENT_MAX_TEXT} characters, so it can be read in the wallet before it is signed.`
  return null
}

export interface CreateStatementOptions {
  /** Which deployment. Usually `cells.dep.configTypeHash`. */
  ns: Hex
  name: string
  text: string
  nowSeconds?: number
}

/** Build the statement and have the wallet sign it. Throws before prompting if anything is wrong. */
export async function createStatement(signer: ccc.Signer, opts: CreateStatementOptions): Promise<SignedStatement> {
  const name = opts.name.trim().toLowerCase().replace(/\.cell$/, '')
  if (!name) throw new Error('cells: a statement names the name that says it')
  const problem = statementTextProblem(opts.text)
  if (problem) throw new Error(`cells: ${problem}`)
  const statement: Statement = {
    t: STATEMENT_TAG,
    ns: opts.ns,
    name,
    text: opts.text,
    signed: opts.nowSeconds ?? Math.floor(Date.now() / 1000),
  }
  const sig = await signer.signMessage(statementMessage(statement))
  return { statement, sig: { signature: sig.signature, identity: sig.identity, signType: sig.signType } }
}

/** Does the signature match the bytes? Nothing about who signed, and no chain. */
export async function verifyStatementSignature(signed: SignedStatement): Promise<boolean> {
  try {
    const message = statementMessage(signed.statement)
    if (signed.sig.signType === PQ_SIGN_TYPE) return pqVerifyMessage(message, signed.sig.signature as Hex, signed.sig.identity as Hex)
    if (signed.sig.signType === ccc.SignerSignType.JoyId && !joyIdSignatureIsHonest(signed.sig.signature)) return false
    const sig = new ccc.Signature(signed.sig.signature, signed.sig.identity, signed.sig.signType as ccc.SignerSignType)
    return await ccc.Signer.verifyMessage(message, sig)
  } catch {
    return false
  }
}

// ---- the block of text it travels as -------------------------------------------------

export const STATEMENT_BEGIN = '-----BEGIN CELLS STATEMENT-----'
export const STATEMENT_END = '-----END CELLS STATEMENT-----'

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder('utf-8', { fatal: true })

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** The signed statement as one token: what goes between the markers, and after `#` in a link. */
export function statementToken(signed: SignedStatement): string {
  return base64url(utf8.encode(JSON.stringify({ s: signed.statement, sig: signed.sig })))
}

/** A token back into a signed statement, or null when it is not one. Shape only; no checks. */
export function statementFromToken(token: string): SignedStatement | null {
  try {
    const o = JSON.parse(fromUtf8.decode(fromBase64url(token.replace(/\s+/g, ''))))
    const s = o?.s
    const sig = o?.sig
    if (!s || typeof s !== 'object' || !sig || typeof sig !== 'object') return null
    if (typeof s.t !== 'string' || typeof s.ns !== 'string' || typeof s.name !== 'string' || typeof s.text !== 'string' || typeof s.signed !== 'number') return null
    if (typeof sig.signature !== 'string' || typeof sig.identity !== 'string' || typeof sig.signType !== 'string') return null
    return {
      statement: { t: s.t, ns: s.ns, name: s.name, text: s.text, signed: s.signed },
      sig: { signature: sig.signature, identity: sig.identity, signType: sig.signType },
    }
  } catch {
    return null
  }
}

/**
 * The block somebody pastes anywhere: the words in the clear, then the signed token between
 * two marker lines. A verifier reads only the token; the words on top are for people.
 */
export function encodeStatement(signed: SignedStatement, opts: { verifyUrl?: string } = {}): string {
  const lines = statementToken(signed).match(/.{1,64}/g) ?? []
  return [
    `${signed.statement.name}.cell says:`,
    '',
    signed.statement.text,
    '',
    ...(opts.verifyUrl ? [`Check it at ${opts.verifyUrl}`] : []),
    STATEMENT_BEGIN,
    ...lines,
    STATEMENT_END,
    '',
  ].join('\n')
}

/**
 * A pasted block back into its parts: the signed statement between the markers, and what
 * was written above them. Null when there is no statement in it.
 */
export function decodeStatement(block: string): { signed: SignedStatement; shown: string } | null {
  const i = block.indexOf(STATEMENT_BEGIN)
  const j = block.indexOf(STATEMENT_END, i + 1)
  if (i < 0 || j < 0) return null
  const signed = statementFromToken(block.slice(i + STATEMENT_BEGIN.length, j))
  return signed ? { signed, shown: block.slice(0, i) } : null
}

// ---- the link it travels as ----------------------------------------------------------

/**
 * The longest link that carries a statement in its query (decision 0040). Past it the link
 * keeps the statement after `#`: a quantum wallet's signature alone is kilobytes, and web
 * servers refuse request lines much past eight.
 */
export const STATEMENT_LINK_MAX = 6000

/**
 * A link to a statement's check page. The statement goes in the query when it fits, so a
 * link preview can show the words, and after `#` when it does not, where a preview cannot.
 */
export function statementLink(origin: string, signed: SignedStatement): string {
  const token = statementToken(signed)
  const inQuery = `${origin}/signed?s=${token}`
  return inQuery.length <= STATEMENT_LINK_MAX ? inQuery : `${origin}/signed#${token}`
}

/** The statement a check page's link carries, in its query or after `#`, or null. */
export function statementFromLink(link: string): SignedStatement | null {
  let u: URL
  try {
    u = new URL(link)
  } catch {
    return null
  }
  if (u.pathname.replace(/\/+$/, '') !== '/signed') return null
  const token = u.searchParams.get('s') || (u.hash.length > 1 ? u.hash.slice(1) : '')
  return token ? statementFromToken(token) : null
}

/** The name a check page files a statement under, when its link is to be short. */
export const STATEMENT_SHORT_ID = /^[A-Za-z0-9_-]{12}$/

/**
 * Twelve base64url characters from the SHA-256 of the token: derived from the statement, so
 * the same statement always gets the same name, a different one never gets it, and nothing
 * has to be remembered to make it again. Seventy-two bits, which is more than the store
 * behind it will ever hold names.
 */
export async function statementShortId(token: string): Promise<string> {
  const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(token.replace(/\s+/g, ''))))
  return base64url(h.slice(0, 9))
}

/** The check page with the statement held by the resolver: `https://cellula.id/signed/<id>`. */
export function statementShortLink(origin: string, id: string): string {
  return `${origin}/signed/${id}`
}

/** Every short check-page link in a piece of text, by name, first found first. */
export function statementShortIdsIn(text: string, max = 5): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>()]+?\/signed\/([A-Za-z0-9_-]{12})(?![A-Za-z0-9_-])/g)) {
    if (out.length >= max) break
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** The name a short check-page link carries, or null when the link is not one. */
export function statementShortIdFromLink(link: string): string | null {
  let u: URL
  try {
    u = new URL(link)
  } catch {
    return null
  }
  const m = u.pathname.match(/^\/signed\/([A-Za-z0-9_-]{12})\/?$/)
  return m ? m[1] : null
}

/**
 * Every statement in a piece of text, first found first: blocks between the markers, and
 * links to a check page. What a gist, a post or a file carries. Shape only; no checks.
 */
export function statementsIn(text: string, max = 5): SignedStatement[] {
  const found: SignedStatement[] = []
  const seen = new Set<string>()
  const add = (s: SignedStatement | null) => {
    if (!s || found.length >= max) return
    const key = statementToken(s)
    if (seen.has(key)) return
    seen.add(key)
    found.push(s)
  }
  for (let at = 0; found.length < max; ) {
    const i = text.indexOf(STATEMENT_BEGIN, at)
    if (i < 0) break
    const j = text.indexOf(STATEMENT_END, i + STATEMENT_BEGIN.length)
    if (j < 0) break
    add(statementFromToken(text.slice(i + STATEMENT_BEGIN.length, j)))
    at = j + STATEMENT_END.length
  }
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>()]+?\/signed\/?(?:\?[^\s"'<>#]*|#[A-Za-z0-9_-]+)/g)) add(statementFromLink(m[0]))
  return found
}

/**
 * Whether the words written above the markers are the words that were signed. Anybody can
 * edit the clear part of a pasted block, and a reader looks at that part first.
 */
export function shownMatchesSigned(shown: string, s: Statement): boolean {
  const flat = (v: string) => v.replace(/\s+/g, ' ').trim()
  return flat(shown).includes(flat(s.text))
}

// ---- who held the name before ------------------------------------------------------

export interface FormerTenure {
  /** Whether one of the given owners held the name before the owner of today. */
  found: boolean
  /** The block of the transaction that ended their ownership, when found. */
  until: bigint | null
  /** That transaction. */
  endedBy: Hex | null
  /**
   * The walk reached the name's latest registration without finding them, so they did
   * not own it in this registration. False when it stopped at `maxSteps` or on an
   * unreadable transaction, in which case older owners were not looked at.
   */
  complete: boolean
  steps: number
}

/**
 * Walk a name back from its live cell, one transaction at a time, and find where one of
 * `owners` last held it. Each version of a name cell is replaced by a transaction that
 * spends it; that transaction's inputs hold the version before, under the same type and
 * with the same label. The walk ends at the registration, whose inputs hold no earlier
 * version of this name, or after `maxSteps` transactions. Read from the chain only.
 *
 * A period in which the name was listed for sale or held as a deed records a lock that is
 * not a wallet, and is not matched here (0039).
 */
export async function formerTenure(
  cells: CellsClient,
  account: Pick<LiveAccount, 'label' | 'outPoint' | 'ownerLockHash'>,
  owners: Set<Hex>,
  maxSteps = 60,
): Promise<FormerTenure> {
  const type = cells.accountType()
  let txHash = account.outPoint.txHash as Hex
  let owner = account.ownerLockHash
  for (let steps = 1; steps <= maxSteps; steps++) {
    const r = await cells.client.getTransaction(txHash).catch(() => undefined)
    if (!r) return { found: false, until: null, endedBy: null, complete: false, steps }
    let prev: { owner: Hex; txHash: Hex } | null = null
    for (const input of r.transaction.inputs) {
      const cell = await cells.client.getCell(input.previousOutput).catch(() => undefined)
      if (!cell?.cellOutput.type || !cell.cellOutput.type.eq(type)) continue
      let lite
      try {
        lite = parseAccountLite(cell.outputData as Hex)
      } catch {
        continue
      }
      if (lite.label !== account.label) continue
      prev = { owner: lite.ownerLockHash, txHash: input.previousOutput.txHash as Hex }
      break
    }
    if (!prev) return { found: false, until: null, endedBy: null, complete: true, steps }
    // The transaction in hand moved the name from `prev.owner` to `owner`. If that is a
    // change of hands and the one who let go is one of ours, this is where they stopped.
    if (prev.owner !== owner && owners.has(prev.owner))
      return { found: true, until: r.blockNumber ?? null, endedBy: txHash, complete: false, steps }
    owner = prev.owner
    txHash = prev.txHash
  }
  return { found: false, until: null, endedBy: null, complete: false, steps: maxSteps }
}

// ---- the verdict ---------------------------------------------------------------------

export type StatementSigner = 'owner' | 'seller' | 'holder' | 'manager' | 'former' | null

export interface StatementVerification {
  /**
   * The words are the name's own: well formed, for this deployment, and signed by whoever
   * owns the name today (its owner, the seller of a listed name, or the holder of its
   * deed). Everything else about the signer is in `signer`.
   */
  ok: boolean
  /** Why not, in words, or what a reader should know. Empty when `ok` and nothing to add. */
  problems: string[]
  statement: Statement
  signatureValid: boolean
  tagOk: boolean
  namespaceOk: boolean
  registered: boolean
  unsupportedWallet: boolean
  signer: StatementSigner
  /** For a former owner: the block and transaction their ownership ended at. */
  heldUntil: { block: string | null; tx: Hex } | null
  /** For a signer who is not the owner: whether the whole of this registration was read. */
  historyComplete: boolean | null
  signerLocks: Hex[]
}

/**
 * Check a signed statement against the chain. Every problem is collected rather than
 * thrown, so a page can say all of what it found.
 */
export async function verifyStatement(
  cells: CellsClient,
  signed: SignedStatement,
  opts: { maxSteps?: number } = {},
): Promise<StatementVerification> {
  const s = signed.statement
  const problems: string[] = []
  const tagOk = s.t === STATEMENT_TAG
  if (!tagOk) problems.push('This is not a Cells statement of a version this page understands.')
  const namespaceOk = s.ns === cells.dep.configTypeHash
  if (!namespaceOk) problems.push('This statement was signed for a different deployment of Cells, so it says nothing about this one.')
  const signatureValid = tagOk && (await verifyStatementSignature(signed))
  if (!signatureValid) problems.push('The signature does not match the words. They may have been changed after signing.')

  const standing = await signerStanding(cells, s.name, signed.sig)
  const registered = !!standing.account
  if (!registered) problems.push(`${s.name}.cell is not registered.`)
  if (standing.unsupportedWallet) problems.push('It was signed with a kind of wallet this page cannot check.')

  let signer: StatementSigner = standing.signedBy
  let heldUntil: StatementVerification['heldUntil'] = null
  let historyComplete: boolean | null = null
  if (standing.account && signer !== 'owner' && signer !== 'seller' && signer !== 'holder' && !standing.unsupportedWallet && signatureValid && namespaceOk) {
    const t = await formerTenure(cells, standing.account, new Set(standing.signerLocks.map(ownerId)), opts.maxSteps)
    historyComplete = t.complete
    if (t.found && t.endedBy) {
      signer = 'former'
      heldUntil = { block: t.until === null ? null : t.until.toString(), tx: t.endedBy }
    }
  }
  if (registered && signatureValid && namespaceOk) {
    if (signer === 'manager') problems.push(`Signed by the manager of ${s.name}.cell, who keeps its records but is not its owner.`)
    if (signer === 'former')
      problems.push(`Signed by a key that owned ${s.name}.cell until block ${heldUntil?.block ?? 'unknown'}. It is not the owner now, and nothing shows when it signed.`)
    if (signer === null)
      problems.push(
        historyComplete
          ? `Not signed by anybody who has owned ${s.name}.cell since it was last registered.`
          : `Not signed by the owner of ${s.name}.cell, nor by any owner found in the part of its history that was read.`,
      )
  }
  const ok = tagOk && namespaceOk && signatureValid && registered && (signer === 'owner' || signer === 'seller' || signer === 'holder')
  return {
    ok,
    problems,
    statement: s,
    signatureValid,
    tagOk,
    namespaceOk,
    registered,
    unsupportedWallet: standing.unsupportedWallet,
    signer,
    heldUntil,
    historyComplete,
    signerLocks: standing.signerLocks,
  }
}
