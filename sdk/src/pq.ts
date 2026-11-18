// A post-quantum owner (decision 0016).
//
// CKB's `sphincs-all-in-one-lock` (nervosnetwork/quantum-resistant-lock-script) verifies
// SPHINCS+ signatures as NIST standardised them in FIPS 205 (SLH-DSA). The Cells contract
// never looks at a signature, only at which lock an input carries, so a name whose owner
// is that lock has a post-quantum owner with no change to the contract. What this module
// adds is the ability to *act* as that owner: a CCC signer for the lock, so every SDK
// method that takes a signer takes it unchanged.
//
// Everything here follows the lock's own `docs/simple.md` and its reference crate
// `ckb-fips205-utils`, single-signature form, parameter set SLH-DSA-SHA2-128s:
//
//   args    = blake2b-256("ckb-sphincs+-sct", 80 01 01 01 62 || public key)
//   witness = WitnessArgs.lock = 80 01 01 01 63 || public key || signature
//   message = blake2b-256("ckb-sphincs+-msg", CKB_TX_MESSAGE_ALL), where that is
//             tx hash || for every input: CellOutput bytes || u32le(len(data)) || data
//             || u32le(len) || first witness input_type slice
//             || u32le(len) || first witness output_type slice
//             || for the group's other witnesses: u32le(len) || witness
//             || for witnesses past the last input: u32le(len) || witness
//
// and the lock verifies with the pure SLH-DSA API and an empty context.
//
// The key is derived from an ordinary 24-word BIP39 phrase: the phrase's BIP39 seed
// (64 bytes, PBKDF2) is cut to the 48 bytes SLH-DSA-128 wants. A person keeps one phrase
// of a familiar shape, and anyone can rebuild the key from it with these lines.
import { ccc } from '@ckb-ccc/core'
import { slh_dsa_sha2_128s as slh } from '@noble/post-quantum/slh-dsa.js'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import type { Hex } from './codec.ts'

export type PqNetwork = 'testnet' | 'mainnet'

/**
 * Where the lock lives, and what that implies (checked on chain 2026-09-10, see
 * [0016](../../docs/decisions/0016-post-quantum-owner.md)).
 *
 * Testnet is pinned by **data hash** and its cell is locked to a code hash nothing can
 * satisfy: the code can never be replaced and the cell can never be spent. Mainnet is
 * pinned by **type id**, and that code cell is held by a `secp256k1_blake160_multisig_v2`
 * lock (args `0x6040e88e…`) which has never been spent, so its threshold and members are
 * not on the chain. Whoever holds it can replace the code that every quantum-owned name
 * obeys. That is a decision to settle before mainnet, not a detail: a lock pinned
 * differently hashes differently, and so is a different owner.
 */
export interface SphincsDeployment {
  /** What a lock script names: a data hash on testnet, a type id hash on mainnet. */
  codeHash: Hex
  hashType: 'data1' | 'type'
  dep: { txHash: Hex; index: number }
  /**
   * The hash of the code itself, which is what actually decides whether a signature is
   * accepted. On testnet it equals `codeHash`, because the lock names the code directly.
   * On mainnet it does not: the lock names a type id, and the code behind it can be
   * replaced, so this is the only thing a watcher can compare against.
   *
   * The mainnet value is the audited release, reproduced byte for byte from source in
   * the project's own pinned build image (decision 0016). The testnet cell is an older
   * build that no published checksum covers, recorded here as what is actually deployed.
   */
  dataHash: Hex
  /** The type id, so a watcher can find the code cell again after an upgrade moves it. */
  typeId?: Hex
}

export const SPHINCS_LOCK: Record<PqNetwork, SphincsDeployment> = {
  testnet: {
    codeHash: '0x147ecbb5c5127d982ee1362d2c2bb4267803da2eb006d150e88af6caaa0a7eaf',
    hashType: 'data1',
    dep: { txHash: '0x631d9a6049fb1fc3790e89d9daf35abe535b5e754cd8c3404319319710f0b106', index: 0 },
    dataHash: '0x147ecbb5c5127d982ee1362d2c2bb4267803da2eb006d150e88af6caaa0a7eaf',
  },
  mainnet: {
    codeHash: '0x302d35982f865ebcbedb9a9360e40530ed32adb8e10b42fbbe70d8312ff7cedf',
    hashType: 'type',
    dep: { txHash: '0x4598d00df2f3dc8bc40eee38689a539c94f6cc3720b7a2a6746736daa60f500a', index: 0 },
    dataHash: '0x49417a0ed39196e8d90d0088ca98bf6b881966ba1c2ea12160ca42141787565e',
    typeId: '0xf75c922a8abc94895eecf172b9efcea049f4a9f666f9be3c9f6494fa71c7c25b',
  },
}

/**
 * What a quantum signature calls itself in a signed payment request. CCC has no sign
 * type for SLH-DSA, so this is ours; anything that does not know it must treat the
 * signature as unverifiable rather than valid, which is what `locksForIdentity` does.
 */
export const PQ_SIGN_TYPE = 'CellsSphincsPlus'

export const PQ_SCHEME = 'slh-dsa-sha2-128s'
export const PQ_PUBLIC_KEY_BYTES = 32
export const PQ_SECRET_KEY_BYTES = 64
export const PQ_SEED_BYTES = 48
export const PQ_SIGNATURE_BYTES = 7856
/** The whole witness lock field: prefix, public key, signature. */
export const PQ_WITNESS_BYTES = 5 + PQ_PUBLIC_KEY_BYTES + PQ_SIGNATURE_BYTES
/** The smallest cell the lock can hold: 8 + 33-byte lock with 32-byte args. */
export const PQ_CELL_MIN_CKB = 73
/** What the protect flow parks under the quantum lock for its own future fees. */
export const PQ_FUND_CKB = 100

const ARGS_PREFIX = Uint8Array.from([0x80, 0x01, 0x01, 0x01, 0x62])
const WITNESS_PREFIX = Uint8Array.from([0x80, 0x01, 0x01, 0x01, 0x63])

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
/** CKB's blake2b, 32 bytes, under one of the lock's personalization strings.
 *
 *  The personalization goes in as bytes. It used to go in as a string: CCC's
 *  `CKB_BLAKE2B_PERSONAL` became `bytesFrom("ckb-default-hash", "utf8")` between 1.12.5
 *  and 1.19.1, so the parameter is typed `Uint8Array` now. The digest is unchanged,
 *  because the noble hasher encoded the string as UTF-8 bytes anyway, and the vectors in
 *  `test/pq.test.ts` are what prove that rather than the reasoning. They must, because a
 *  moved digest here is a moved lock args, and a name owned by a quantum key would stop
 *  being ownable. */
const blake2b = (data: Uint8Array, personal: string): Uint8Array => {
  const h = new ccc.HasherCkb(32, ccc.bytesFrom(personal, 'utf8'))
  h.update(data)
  return ccc.bytesFrom(h.digest())
}

/**
 * What a quantum key signs when it signs a message rather than a transaction.
 *
 * The digest is domain-separated from the one the lock verifies: the lock hashes with
 * `ckb-sphincs+-msg`, this hashes with `cells-pq-request`, so a signature made over a
 * payment request can never be replayed as a transaction signature, nor the reverse.
 */
export function pqMessageDigest(message: string | Uint8Array): Uint8Array {
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
  return blake2b(bytes, 'cells-pq-request')
}

/** Does this quantum signature match this message, under this public key? */
export function pqVerifyMessage(message: string | Uint8Array, signature: Hex, publicKey: Hex): boolean {
  try {
    const pk = ccc.bytesFrom(publicKey)
    const sig = ccc.bytesFrom(signature)
    if (pk.length !== PQ_PUBLIC_KEY_BYTES || sig.length !== PQ_SIGNATURE_BYTES) return false
    return slh.verify(sig, pqMessageDigest(message), pk)
  } catch {
    return false
  }
}

export interface PqKey {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

/** A fresh 24-word phrase, 256 bits of entropy from the platform's randomness. */
export function pqPhrase(): string {
  return generateMnemonic(wordlist, 256)
}

/** Whether a phrase is a valid 24-word BIP39 phrase (checksum included). */
export function isPqPhrase(phrase: string): boolean {
  const words = phrase.trim().toLowerCase().split(/\s+/)
  return words.length === 24 && validateMnemonic(words.join(' '), wordlist)
}

/** The 48-byte SLH-DSA seed of a phrase: its BIP39 seed, cut. */
export function pqSeedFromPhrase(phrase: string): Uint8Array {
  const words = phrase.trim().toLowerCase().split(/\s+/).join(' ')
  if (!isPqPhrase(words)) throw new Error('cells: not a valid 24-word phrase')
  return mnemonicToSeedSync(words).slice(0, PQ_SEED_BYTES)
}

export function pqKeyFromSeed(seed: Uint8Array): PqKey {
  if (seed.length !== PQ_SEED_BYTES) throw new Error(`cells: a quantum seed is ${PQ_SEED_BYTES} bytes`)
  const { publicKey, secretKey } = slh.keygen(seed)
  return { publicKey, secretKey }
}

export function pqKeyFromPhrase(phrase: string): PqKey {
  return pqKeyFromSeed(pqSeedFromPhrase(phrase))
}

/**
 * The lock script a public key owns, on a network.
 *
 * `pin` says which deployment of the lock code that key is read against, and it is part
 * of the identity: the same phrase under a different pin is a different lock hash, so a
 * name protected under one pin cannot be unlocked under another. It defaults to
 * `SPHINCS_LOCK[network]` and is passed explicitly only to reach a name left under an
 * older pin, e.g. while migrating to a frozen copy of the code.
 */
export function pqScript(publicKey: Uint8Array, network: PqNetwork, pin: SphincsDeployment = SPHINCS_LOCK[network]): ccc.Script {
  if (publicKey.length !== PQ_PUBLIC_KEY_BYTES) throw new Error('cells: a quantum public key is 32 bytes')
  const args = blake2b(cat(ARGS_PREFIX, publicKey), 'ckb-sphincs+-sct')
  return ccc.Script.from({ codeHash: pin.codeHash, hashType: pin.hashType, args: ccc.hexFrom(args) })
}

/** Which network a client speaks to, from its address prefix. */
export function pqNetworkOf(client: ccc.Client): PqNetwork {
  return client.addressPrefix === 'ckb' ? 'mainnet' : 'testnet'
}

/** The molecule slice of a `BytesOpt`: nothing when absent, u32le(len) || bytes when present. */
const optSlice = (hex: Hex | undefined | null): Uint8Array => {
  if (hex === undefined || hex === null) return new Uint8Array(0)
  const c = ccc.bytesFrom(hex)
  return cat(u32le(c.length), c)
}

/** What each input cell contributes: its output and its data. */
export interface PqInputCell {
  cellOutput: ccc.CellOutputLike
  outputData: Hex
}

/**
 * `CKB_TX_MESSAGE_ALL` for the script group of `script`, hashed the way the lock hashes
 * it. `inputs` are the cells the transaction spends, in order; the lock's group is every
 * input under `script`, and the first of them carries the signature.
 */
export function pqTxMessageAll(
  tx: ccc.Transaction,
  script: ccc.Script,
  inputs: PqInputCell[],
): { message: Uint8Array; position: number; group: number[] } {
  if (inputs.length !== tx.inputs.length) throw new Error('cells: one input cell per transaction input')
  const h = script.hash()
  const group = inputs.map((c, i) => (ccc.Script.from(c.cellOutput.lock).hash() === h ? i : -1)).filter((i) => i >= 0)
  if (group.length === 0) throw new Error('cells: no input under the quantum lock')
  const parts: Uint8Array[] = [ccc.bytesFrom(tx.hash())]
  for (const c of inputs) {
    parts.push(ccc.CellOutput.from(c.cellOutput).toBytes())
    const d = ccc.bytesFrom(c.outputData)
    parts.push(u32le(d.length), d)
  }
  const first = ccc.WitnessArgs.fromBytes(tx.witnesses[group[0]] ?? '0x')
  const it = optSlice(first.inputType as Hex | undefined)
  const ot = optSlice(first.outputType as Hex | undefined)
  parts.push(u32le(it.length), it, u32le(ot.length), ot)
  for (const gi of group.slice(1)) {
    if (tx.witnesses[gi] === undefined) continue
    const w = ccc.bytesFrom(tx.witnesses[gi])
    parts.push(u32le(w.length), w)
  }
  for (let i = tx.inputs.length; i < tx.witnesses.length; i++) {
    const w = ccc.bytesFrom(tx.witnesses[i])
    parts.push(u32le(w.length), w)
  }
  return { message: blake2b(cat(...parts), 'ckb-sphincs+-msg'), position: group[0], group }
}

/** Check one witness of a transaction against the lock's rules. Used by the tests. */
export function pqVerifyWitness(witnessLock: Hex, message: Uint8Array): { publicKey: Uint8Array; ok: boolean } {
  const lock = ccc.bytesFrom(witnessLock)
  if (lock.length !== PQ_WITNESS_BYTES) throw new Error(`cells: a quantum witness is ${PQ_WITNESS_BYTES} bytes`)
  for (let i = 0; i < WITNESS_PREFIX.length; i++) if (lock[i] !== WITNESS_PREFIX[i]) throw new Error('cells: not a single SLH-DSA-SHA2-128s witness')
  const publicKey = lock.slice(5, 5 + PQ_PUBLIC_KEY_BYTES)
  const signature = lock.slice(5 + PQ_PUBLIC_KEY_BYTES)
  return { publicKey, ok: slh.verify(signature, message, publicKey) }
}

/**
 * A CCC signer for the quantum lock. Hand it to any SDK method in place of a wallet.
 *
 * It works on the transaction object it is given and never rebuilds it: CCC's fee loop
 * calls `prepareTransaction` for its side effects on the original, and a copy would
 * leave the original without the witness placeholder, paying for a witness it never had.
 */
export class PqSigner extends ccc.Signer {
  readonly script: ccc.Script
  readonly network: PqNetwork
  /** Which deployment of the lock code this key is read against. */
  readonly pin: SphincsDeployment
  private readonly key: PqKey

  constructor(client: ccc.Client, key: PqKey, network: PqNetwork = pqNetworkOf(client), pin: SphincsDeployment = SPHINCS_LOCK[network]) {
    super(client)
    this.key = key
    this.network = network
    this.pin = pin
    this.script = pqScript(key.publicKey, network, pin)
  }

  get type(): ccc.SignerType {
    return ccc.SignerType.CKB
  }
  get signType(): ccc.SignerSignType {
    return ccc.SignerSignType.Unknown
  }
  async connect(): Promise<void> {}
  async isConnected(): Promise<boolean> {
    return true
  }
  async getInternalAddress(): Promise<string> {
    return this.getRecommendedAddress()
  }
  async getAddressObjs(): Promise<ccc.Address[]> {
    return [ccc.Address.fromScript(this.script, this.client)]
  }

  /**
   * Sign a message, for a signed payment request (decision 0013). The identity is the
   * public key, which is all anyone needs to rebuild this lock and check the signature.
   *
   * The signature is 7,856 bytes, and hex doubles it, so a request link signed this way
   * is about sixteen kilobytes (measured): fine to send, far too big for a QR code.
   */
  async signMessage(message: string | ccc.BytesLike): Promise<ccc.Signature> {
    const bytes = typeof message === 'string' ? message : ccc.bytesFrom(message)
    const signature = slh.sign(pqMessageDigest(bytes), this.key.secretKey)
    return new ccc.Signature(ccc.hexFrom(signature), ccc.hexFrom(this.key.publicKey), PQ_SIGN_TYPE as ccc.SignerSignType)
  }

  /** The twenty-byte identity the contract stores for this owner. */
  ownerId(): Hex {
    return ccc.hexFrom(ccc.bytesFrom(this.script.hash()).slice(0, 20))
  }

  private async inputCells(tx: ccc.Transaction): Promise<PqInputCell[]> {
    const cells: PqInputCell[] = []
    for (const i of tx.inputs) {
      const c = await this.client.getCell(i.previousOutput)
      if (!c) throw new Error('cells: an input of this transaction is not a live cell')
      cells.push({ cellOutput: c.cellOutput, outputData: c.outputData as Hex })
    }
    return cells
  }

  async prepareTransaction(txLike: ccc.TransactionLike): Promise<ccc.Transaction> {
    const tx = typeof (txLike as ccc.Transaction).prepareSighashAllWitness === 'function' ? (txLike as ccc.Transaction) : ccc.Transaction.from(txLike)
    const dep = this.pin.dep
    if (!tx.cellDeps.some((d) => d.outPoint.txHash === dep.txHash && Number(d.outPoint.index) === dep.index)) {
      tx.addCellDeps({ outPoint: dep, depType: 'code' })
    }
    await tx.prepareSighashAllWitness(this.script, PQ_WITNESS_BYTES, this.client)
    return tx
  }

  async signOnlyTransaction(txLike: ccc.TransactionLike): Promise<ccc.Transaction> {
    const tx = typeof (txLike as ccc.Transaction).setWitnessArgs === 'function' ? (txLike as ccc.Transaction) : ccc.Transaction.from(txLike)
    const { message, position } = pqTxMessageAll(tx, this.script, await this.inputCells(tx))
    const signature = slh.sign(message, this.key.secretKey)
    if (signature.length !== PQ_SIGNATURE_BYTES) throw new Error(`cells: unexpected signature length ${signature.length}`)
    const wa = ccc.WitnessArgs.fromBytes(tx.witnesses[position] ?? '0x')
    wa.lock = ccc.hexFrom(cat(WITNESS_PREFIX, this.key.publicKey, signature))
    tx.setWitnessArgs(position, wa)
    return tx
  }
}
