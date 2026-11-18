/**
 * Signing in as a `.cell` name, on somebody else's site.
 *
 * The project has called itself naming **and DID** since the first commit, and until
 * 2026-09-16 there was no way for a third party to let somebody prove "I am the owner of
 * `alice.cell`". A name could be resolved, paid and asked to be paid; it could not be
 * used to enter anywhere. This closes that, and it does it without an account, a key, a
 * session or a call to us: the site sends a challenge, the wallet signs it, and anybody
 * can check the answer against the chain.
 *
 * ## It is the payment request's machinery, pointed at a different question
 *
 * [0013](../../docs/decisions/0013-payment-requests.md) already made a wallet sign a
 * short message and taught `verifyRequest` to compare the signer against the name's
 * `owner_lock_hash` on the chain, across every wallet kind this app supports, quantum
 * owners included. That comparison lives in `signerStanding` and is shared, not copied:
 * two answers to "is this person alice.cell" would be two things to keep in step, and an
 * attacker would use the looser one.
 *
 * ## The three things that make a login signature different from a payment one
 *
 * 1. **It cannot be mistaken for the other.** The bytes begin with a tag of their own,
 *    `{"t":"cells.login.v1"`, where a payment request begins `{"v":1`. A signature
 *    collected by one route can therefore never be replayed through the other. That is
 *    not left as an argument: `a login can never be read as a payment request` in the
 *    tests builds both and compares them.
 * 2. **It is bound to the site that asked.** `domain` is in the signed bytes and the
 *    verifier is given the domain it expects. Without this, a site the person logs into
 *    could take the signature it was handed and use it to enter somewhere else as them.
 * 3. **It is bound to one attempt.** `nonce` is the site's own challenge, `expires` is
 *    short, and the verifier is handed the nonce it issued. A signature seen once is
 *    worth nothing anywhere, including at the same site a minute later.
 *
 * ## Who may sign in, and who may not
 *
 * The owner. And the seller of a name that is listed for sale, because listing moves the
 * recorded owner to the offer lock and it would be absurd for putting a name up for sale
 * to log you out of everything.
 *
 * **Not the manager**, unlike a payment request, and the difference is deliberate. A
 * manager may edit records, so for a payment they can already redirect the money and
 * refusing them protects nothing. Signing in is a claim to **be** the name, which a
 * manager is not: they were delegated the records, not the identity. A site that wants
 * the looser rule can ask for it with `allowManager`, and then it is their decision,
 * made in the open, rather than ours made quietly for them.
 */
import { ccc } from '@ckb-ccc/core'
import type { Hex } from './codec.ts'
import { isValidLabel, randomSecret } from './codec.ts'
import type { CellsClient } from './client.ts'
import { PQ_SIGN_TYPE, pqVerifyMessage } from './pq.ts'
import { joyIdSignatureIsHonest, signerStanding, type RequestSignature, type SignerStanding } from './request.ts'

/** The tag that opens the signed bytes. Bump the version and old signatures stop verifying. */
export const LOGIN_TAG = 'cells.login.v1' as const

/**
 * A login is good for five minutes. Long enough for a wallet prompt, short enough to be
 * worthless if seen. It is also the most a login may ask for: `expires` is written by
 * whoever built the challenge, so the verifier holds it to this rather than to itself.
 */
export const LOGIN_TTL_SECONDS = 300

/** The label a login is for, whether it was written with its `.cell` or without. One suffix, taken once. */
const loginLabel = (name: string) => name.replace(/\.cell$/, '')

/** What the site asks, and what the wallet signs. Every field is in the signed bytes. */
export interface LoginChallenge {
  /** Always `cells.login.v1`. First key of the message, so these bytes are only ever a login. */
  t: typeof LOGIN_TAG
  /** Which deployment of Cells, so a testnet signature is worthless on mainnet. */
  ns: Hex
  /** The name being claimed, without `.cell`. */
  name: string
  /** The site asking, as a bare host (`example.com`, `localhost:5173`). No scheme, no path. */
  domain: string
  /** The site's own challenge. Must be unpredictable and must be remembered until it is used or expires. */
  nonce: Hex
  /** Unix seconds. */
  issued: number
  /** Unix seconds; the verifier refuses anything later. */
  expires: number
  /** One line the person sees in their wallet before signing, or null. */
  statement: string | null
}

export interface SignedLogin {
  login: LoginChallenge
  sig: RequestSignature
}

/**
 * A bare host, optionally with a port. Deliberately narrow: anything that could carry a
 * scheme, a path, a query or credentials is refused, because a verifier comparing
 * `evil.com/good.com` against `good.com` by any looser rule is the whole attack.
 */
export function isLoginDomain(v: string): boolean {
  if (v.length === 0 || v.length > 253 || v !== v.toLowerCase() || v !== v.trim()) return false
  const [host, port, ...rest] = v.split(':')
  if (rest.length > 0) return false
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return false
  if (host === 'localhost') return true
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(host)
}

/** A fresh challenge for a site to hand out. Unpredictable, and the site must remember it. */
export const newLoginNonce = (): Hex => randomSecret()

/**
 * The exact bytes that are signed, built key by key so the order never depends on how the
 * object happened to be constructed. `t` is first, and that is the domain separation.
 */
export function loginMessage(c: LoginChallenge): string {
  return JSON.stringify({
    t: LOGIN_TAG,
    ns: c.ns,
    name: c.name,
    domain: c.domain,
    nonce: c.nonce,
    issued: c.issued,
    expires: c.expires,
    statement: c.statement,
  })
}

export function loginHash(c: LoginChallenge): Hex {
  return ccc.hashCkb(ccc.bytesFrom(loginMessage(c), 'utf8')) as Hex
}

export interface CreateLoginOptions {
  /** Which deployment. Usually `cells.dep.configTypeHash`. */
  ns: Hex
  name: string
  domain: string
  nonce: Hex
  statement?: string | null
  nowSeconds?: number
  ttlSeconds?: number
}

/** Build the challenge and have the wallet sign it. Throws before prompting if anything is malformed. */
export async function createLogin(signer: ccc.Signer, opts: CreateLoginOptions): Promise<SignedLogin> {
  if (!isLoginDomain(opts.domain)) throw new Error(`cells: ${JSON.stringify(opts.domain)} is not a bare host, so it cannot be signed for`)
  if (!/^0x[0-9a-f]{2,}$/i.test(opts.nonce)) throw new Error('cells: a login nonce must be hex bytes')
  const name = loginLabel(opts.name)
  if (!isValidLabel(name)) throw new Error(`cells: ${JSON.stringify(opts.name)} is not a name, so it cannot be signed in as`)
  const ttl = opts.ttlSeconds ?? LOGIN_TTL_SECONDS
  if (!(Number.isInteger(ttl) && ttl > 0 && ttl <= LOGIN_TTL_SECONDS))
    throw new Error(`cells: a login cannot be good for longer than ${LOGIN_TTL_SECONDS} seconds, and verifiers refuse one that asks to`)
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const login: LoginChallenge = {
    t: LOGIN_TAG,
    ns: opts.ns,
    name,
    domain: opts.domain,
    nonce: opts.nonce,
    issued: now,
    expires: now + ttl,
    statement: opts.statement ?? null,
  }
  const sig = await signer.signMessage(loginMessage(login))
  return { login, sig: { signature: sig.signature, identity: sig.identity, signType: sig.signType } }
}

/** Does the signature match the bytes? Nothing about who signed, and no chain. */
export async function verifyLoginSignature(signed: SignedLogin): Promise<boolean> {
  try {
    if (signed.sig.signType === PQ_SIGN_TYPE)
      return pqVerifyMessage(loginMessage(signed.login), signed.sig.signature as Hex, signed.sig.identity as Hex)
    if (signed.sig.signType === ccc.SignerSignType.JoyId && !joyIdSignatureIsHonest(signed.sig.signature)) return false
    const sig = new ccc.Signature(signed.sig.signature, signed.sig.identity, signed.sig.signType as ccc.SignerSignType)
    return await ccc.Signer.verifyMessage(loginMessage(signed.login), sig)
  } catch {
    return false
  }
}

/** What the verifying site must already know. Both are its own, and neither comes from the signature. */
export interface LoginExpectation {
  /** The host the site is serving. Compared exactly. */
  domain: string
  /** The nonce this site issued and has not yet spent. Compared exactly. */
  nonce: Hex
  /** Accept a signature from the name's manager as well as its owner. Off by default. */
  allowManager?: boolean
  nowSeconds?: number
}

export interface LoginVerification {
  /** True only when there is nothing in `problems`. Everything else is detail for a person. */
  ok: boolean
  problems: string[]
  /** The name, with `.cell`, only when `ok`. This is the answer the site wanted. */
  name: string | null
  signatureValid: boolean
  namespaceOk: boolean
  domainOk: boolean
  nonceOk: boolean
  expired: boolean
  signedBy: SignerStanding['signedBy']
  signerLocks: Hex[]
  unsupportedWallet: boolean
  /** The owner's lock hash as the chain records it, so the site can key an account on something stable. */
  ownerId: Hex | null
}

/**
 * Check a signed login against the chain and against what the site expects.
 *
 * Every problem is collected rather than thrown, because a site showing a person why they
 * could not get in is more useful than a stack trace, and because a verifier that stops at
 * the first failure tells an attacker which check they got past.
 */
export async function verifyLogin(
  cells: CellsClient,
  signed: SignedLogin,
  expect: LoginExpectation,
): Promise<LoginVerification> {
  const { login, sig } = signed
  const now = expect.nowSeconds ?? Math.floor(Date.now() / 1000)
  const problems: string[] = []

  const tagOk = login.t === LOGIN_TAG
  if (!tagOk) problems.push('This is not a Cells login of a version this site understands.')

  const namespaceOk = login.ns === cells.dep.configTypeHash
  if (!namespaceOk) problems.push('This login was signed for a different deployment of Cells.')

  // Compared exactly, and against the site's own value rather than anything in the
  // signature. A verifier that took the domain from the message would be checking that a
  // signature agrees with itself.
  const domainOk = login.domain === expect.domain
  if (!domainOk) problems.push(`This login was signed for ${login.domain}, not for ${expect.domain}.`)

  const nonceOk = login.nonce === expect.nonce
  if (!nonceOk) problems.push('This login answers a different challenge. Start again.')

  // The window is the signer's own claim, so it is held to the five minutes here rather than
  // believed. Taken as written, one signature dated ten years ahead was a login good for ten
  // years, for anybody who saw it once while the site still held its nonce.
  const window = login.expires - login.issued
  const tooLong = !(Number.isSafeInteger(window) && window > 0 && window <= LOGIN_TTL_SECONDS)
  const expired = tooLong || now > login.expires || login.issued > now + 60
  if (tooLong) problems.push(`This login asks to be good for longer than the ${LOGIN_TTL_SECONDS / 60} minutes a login may last. Start again.`)
  else if (expired) problems.push('This login has expired. Start again.')

  const signatureValid = await verifyLoginSignature(signed)
  if (!signatureValid) problems.push('The signature does not match what was signed. It may have been altered.')

  // Signed with the suffix or without, it is one name, and it gets one suffix back.
  const label = loginLabel(login.name)
  const standing = await signerStanding(cells, label, sig)
  if (standing.unsupportedWallet) problems.push('This login was signed with a kind of wallet this site cannot check.')
  if (!standing.account) problems.push(`${label}.cell is not registered.`)

  const accepted = standing.isOwner || (!!expect.allowManager && standing.isManager)
  if (standing.account && !standing.unsupportedWallet && !accepted) {
    problems.push(
      standing.isManager
        ? `${label}.cell was signed for by its manager, and this site accepts only its owner.`
        : `This login was not signed by the owner of ${label}.cell.`,
    )
  }

  const ok = problems.length === 0
  return {
    ok,
    name: ok ? `${label}.cell` : null,
    problems,
    signatureValid,
    namespaceOk,
    domainOk,
    nonceOk,
    expired,
    signedBy: standing.signedBy,
    signerLocks: standing.signerLocks,
    unsupportedWallet: standing.unsupportedWallet,
    ownerId: standing.account?.ownerLockHash ?? null,
  }
}
