// CellsClient, the dapp-facing read + write client over a CCC client.
//
// Read: name → addresses/records, address → name, list. Write: permissionless
// `register` (decision 0002), no operator, signed by the caller's wallet.
import { PqSigner, PQ_FUND_CKB } from './pq.ts'
import { ccc } from '@ckb-ccc/core'
import { assertCluster, createSpore, findSpore, getSporeScriptInfo, meltSpore, transferSpore } from '@ckb-ccc/spore'
import { unpackToRawSporeData } from '@ckb-ccc/spore/advanced'
import {
  checkDeedTx,
  deedCard,
  deedExpiryText,
  deedLock,
  deedContent,
  deedOf as deedOfAccount,
  deedStanding,
  deedsHeldBy,
  encodeDeedProxyData,
  findDeedProxyCell,
  sporeTypeOf,
  type Deed,
  type DeedLink, bellyOf, deedLinkOf, sweepable, type Belly,
  plateLock, plateMinimum, followPlate, PLATE_MIN_EXP, PLATE_PAGE, PLATE_TAKE_WITNESS } from './deed.ts'
import { addMeal } from './meal.ts'
import {
  type Account,
  type FiberEndpoint,
  type Hex,
  type RecordEntry,
  type WitnessData,
  CKB_ADDRESS_KEY,
  COMMIT_MIN_DELAY,
  FIBER_ADDR_KEY,
  FIBER_NODE_KEY,
  accountId,
  between,
  buildAccount,
  buildAccountData,
  namespaceArgs,
  ownerId,
  commitment,
  decodeReverse,
  REVERSE_TAG_LENGTH,
  encodeReverse,
  fiberRecords,
  isValidLabel,
  parentLabel,
  parseAccount,
  parseAccountLite,
  parseFiber,
  textToValue,
  valueToText,
  priceFloorCkb,
  registerCapacityCkb,
  referralCutCkb,
  randomSecret,
  registrationFeeCkb,
  saleSplitShannons,
  SALE_FEE_PERCENT,
  yearsForTerm,
  MAX_TERM_YEARS,
  MIN_TERM_YEARS,
  SECONDS_PER_YEAR,
  TREASURY_LOCK,
  TREASURY_LOCK_HASH,
  nameState,
  recycleSince,
} from './codec.ts'
import { LIGHTNING_ADDRESS_KEY, LIGHTNING_OFFER_KEY } from './address.ts'
import { permissiveLock } from './owner.ts'
import {
  applyPriceFactor,
  parsePriceFactor,
  priceData,
  priceStepOk,
  priceStepToward,
  PRICE_COOLDOWN_SECS,
  PRICE_FACTOR_MAX,
} from './price.ts'

export interface ScriptInfo {
  codeHash: Hex
  hashType: 'data' | 'data1' | 'data2' | 'type'
}
export interface DepInfo {
  txHash: Hex
  index: number
  depType: 'code' | 'depGroup'
}
export interface Deployment {
  account: ScriptInfo
  lock: ScriptInfo
  configTypeHash: Hex
  accountDep: DepInfo
  lockDep: DepInfo
  /** The offer lock (decision 0012). Absent on a deployment that has no marketplace. */
  sale?: ScriptInfo & { dep: DepInfo }
  /**
   * The price cell (decision 0014): the code of its type script (`price-cell-type`,
   * `dep`) and the one live instance's type script (`typeArgs`), by which the cell is
   * found at call time. `typeHash` is what `account-cell-type` was compiled with.
   * Absent on a deployment that simply charges the schedule.
   */
  price?: ScriptInfo & { dep: DepInfo; typeHash: Hex; typeArgs: Hex }
  /**
   * The lock every fee is paid to, as a full script rather than the hash the contract
   * checks, because a payment has to be *built* and not merely recognised.
   *
   * It lives here, per network, after 2026-09-21: the SDK carried one hard-coded
   * `TREASURY_LOCK`, the testnet JoyID, and on mainnet that names a script no cell
   * provides. The first mainnet registration built its fee output to it and **burned
   * 5,000 CKB**, while the contract was satisfied by the payer's own change and reported
   * nothing wrong. Absent here, the constant is still used, which is what every existing
   * testnet caller does.
   */
  treasury?: ScriptInfo & { args: Hex }
  /** What the contract checks the fee against. The script above must hash to this. */
  treasuryLockHash?: Hex
  /**
   * The Spore cluster deeds are minted into (decision 0036), by cluster id. Absent on a
   * deployment where names cannot be held as deeds yet; every other feature is unaffected.
   */
  deedCluster?: Hex
  /**
   * Clusters deeds were minted into before this one. A change to the card is a new
   * cluster, and a deed minted into an older one is still ours to recognise and to end.
   */
  previousDeedClusters?: Hex[]
}

/** A deed a wallet holds, and whether it still holds its name (`deedStanding`). */
export interface HeldDeed {
  sporeId: Hex
  /** The name the card was minted for, or null when the content is not a deed's. */
  label: string | null
  standing: 'live' | 'gone' | 'elsewhere'
  /** What ending it gives back: the Spore's capacity and every plain cell under its proxy lock. */
  reclaim: bigint
}

/** Build a Deployment from the `scripts/.testnet/deployment.json` shape. */
export function deploymentFromJson(j: any): Deployment {
  return {
    account: { codeHash: j.account.codeHash, hashType: j.account.hashType },
    lock: { codeHash: j.lock.codeHash, hashType: j.lock.hashType },
    configTypeHash: j.configTypeHash,
    accountDep: j.account.dep,
    lockDep: j.lock.dep,
    sale: j.sale ? { codeHash: j.sale.codeHash, hashType: j.sale.hashType, dep: j.sale.dep } : undefined,
    price:
      j.price && j.price.typeHash
        ? { codeHash: j.price.codeHash, hashType: j.price.hashType, dep: j.price.dep, typeHash: j.price.typeHash, typeArgs: j.price.typeArgs }
        : undefined,
    treasury: j.treasury ? { codeHash: j.treasury.codeHash, hashType: j.treasury.hashType, args: j.treasury.args } : undefined,
    treasuryLockHash: j.treasuryLockHash,
    deedCluster: j.deedCluster || undefined,
    previousDeedClusters: Array.isArray(j.previousDeedClusters) ? j.previousDeedClusters : undefined,
  }
}

/** The one live price cell (decision 0014), as found on chain. */
export interface PriceCell {
  outPoint: { txHash: Hex; index: number }
  /** The factor in basis points, or null when the data is not a valid one (the contract then charges the full price). */
  factorBps: number | null
  capacity: bigint
  lock: ccc.Script
  data: Hex
}

/** A live listing: one offer cell, and what buying it would cost and pay. */
export interface SaleOffer {
  /** The seller's lock hash, as the lock's own args commit to it. */
  seller: Hex
  /** Their lock script, carried in the offer cell's data so a buyer can pay them (for a
   *  deed, read from the transaction that listed it). */
  sellerLock: ccc.Script
  priceShannons: bigint
  priceCkb: number
  /**
   * The price split: what the seller receives **for the name**, and the protocol's
   * share. These two add up to the price, which is what the buyer brings.
   *
   * The seller's actual output in a purchase is `toSeller` plus `capacity` below, their
   * own deposit coming back. It is not part of the split because neither side gains or
   * loses it.
   *
   * These two are CKB, for showing. A purchase is built from the same split in shannons,
   * `toSellerShannons` and `toTreasuryShannons`, which is what the contract checks.
   */
  toSeller: number
  toTreasury: number
  toSellerShannons: bigint
  toTreasuryShannons: bigint
  outPoint: { txHash: Hex; index: number }
  /** The offer cell's own capacity: the seller's deposit, returned to them on a sale. */
  capacity: bigint
  /**
   * Set when what is for sale is a deed, whole (`listForSale` with `keepDeed`): the Spore
   * sits under the sale lock itself, with no offer cell, and `outPoint` and `capacity` are
   * the Spore's. The buyer takes the Spore, and with it the name, its being and whatever
   * the being has eaten. `sellerLock` then comes from the transaction that listed it.
   */
  deed?: { sporeId: Hex; sporeTypeHash: Hex; cluster: Hex; label: string }
}

export interface LiveAccount extends Account {
  outPoint: { txHash: Hex; index: number }
  capacity: bigint
  data: Hex
  witness: Hex
  /**
   * The block that committed the transaction behind `outPoint`. A live cell always has
   * one; the fields are optional only because the node's answer types them that way. A
   * light client that cannot look a cell up by outpoint can start watching from here.
   */
  blockNumber?: number
  blockHash?: Hex
}

/**
 * A live cell known only from its `data`: label + list position, no witness.
 * Cheap to stream (one indexer query, no per-cell `getTransaction`); hydrate the
 * one you want into a full `LiveAccount` with `hydrate`.
 */
export interface LiveAccountLite {
  label: string
  id: Hex
  next: Hex
  expiredAt: number
  ownerLockHash: Hex
  managerLockHash: Hex
  outPoint: { txHash: Hex; index: number }
  capacity: bigint
  data: Hex
}

/**
 * Whether a transaction was refused because another one, sent at nearly the same moment,
 * spent a cell it needed. Either that cell is already gone (`Dead`, `Unknown`, a failed
 * resolve), or the other transaction is still in the node's pool and this one did not pay
 * enough to replace it (`PoolRejectedRBF`). Building again reads the cells fresh, so both
 * are recoverable; the second is the common one when two people act in the same second,
 * and it was not recognised until 2026-09-25, so such a claim failed instead of retrying.
 */
export function lostToAnotherTransaction(message: string): boolean {
  return /Resolve|Dead\(|Unknown\(|OutPoint|PoolRejectedRBF|RBF rejected/i.test(message)
}

export interface RegisterOptions {
  /** Resolution records for the new name (default: none). */
  records?: RecordEntry[]
  /**
   * How many whole years to buy, 1 to 10 (default 1). The expiry is computed from
   * the CommitCell's block timestamp, which is the same clock the contract prices
   * the term against, so the term is exact rather than a race with block time.
   */
  years?: number
  /**
   * Expiry, unix seconds. Overrides `years`; the fee is then charged for the whole
   * years that expiry covers, rounded up. Registrations no longer default to the
   * year 2096: that is over the ten-year maximum and the contract rejects it.
   */
  expiredAt?: number
  /**
   * Present the live price cell as a dep and pay the discounted fee (default). `false`
   * pays the full schedule and presents nothing, which is exactly what the contract
   * charges when the cell is missing; the proof scripts use it to show that fallback.
   */
  usePriceCell?: boolean
  /**
   * The name of whoever invited you (decision 0011). A tenth of the fee goes to that
   * name's owner instead of to the treasury, so it costs the buyer nothing.
   *
   * The inviter must have published its owner's own CKB address on the name, and must
   * not be a wallet signing this transaction: the contract refuses to pay a referral
   * to anyone who signed, which is what stops a client paying it to itself.
   */
  inviter?: string
  /** Capacity to lock in the new cell, in CKB (default: the price floor for the label). */
  capacityCkb?: number
  /** The reveal secret from a prior `commit()` (required, commit-reveal). */
  secret?: Hex
  /** The CommitCell to spend, from a prior `commit()` (required, commit-reveal). */
  commit?: { txHash: Hex; index: number }
  /**
   * For a sub-name whose parent belongs to a key that is not `signer`: the parent's
   * owner, who must co-sign. Used when the parent sits behind a cold or quantum key
   * (decision 0016) while an everyday wallet pays for and receives the sub-name. One
   * of the parent owner's cells is spent and returned untouched, purely so the
   * contract can see their authority; `signer` still pays.
   */
  parentSigner?: ccc.Signer
  /**
   * Called the moment the signed transaction is accepted by a node, before this
   * call goes on to wait for a block. A screen can then say "sent, waiting for the
   * network" instead of "sign in your wallet" for the whole minute.
   */
  onSent?: (txHash: Hex) => void
}

/** What `commit()` returns, keep `secret` + `outPoint` to pass to `register()`. */
export interface CommitResult {
  secret: Hex
  commitment: Hex
  owner: Hex
  outPoint: { txHash: Hex; index: number }
  txHash: Hex
  /** Seconds the commit must age before `register()` will be accepted by consensus. */
  minDelaySeconds: number
  /**
   * The **median time** (unix seconds) at or after which the reveal is valid.
   *
   * Consensus does not judge a relative-timestamp `since` by anybody's clock: it
   * uses the median of recent block timestamps, which trails real time by minutes.
   * A countdown run off `Date.now()` therefore reaches zero while the network still
   * refuses the transaction, which looks exactly like the app being broken. Compare
   * this against `medianTimeSeconds()` instead.
   */
  readyAtMedian: number
}

const enc = new TextEncoder()
const REGISTER = enc.encode('register')
const EDIT_RECORDS = enc.encode('edit_records')
const EDIT_MANAGER = enc.encode('edit_manager')
const TRANSFER = enc.encode('transfer')
const RENEW = enc.encode('renew')
const RECYCLE = enc.encode('recycle')
/** `since` absolute-timestamp flag (relative=0, metric=timestamp). */
const ABS_TS = 0x4000_0000_0000_0000n
/** `since` relative-timestamp flag (relative=1, metric=timestamp), commit-reveal. */
const REL_TS = 0xc000_0000_0000_0000n
/** CKB locked in a CommitCell (refunded when it's spent at reveal). */
const COMMIT_CELL_CKB = 100
/** CKB locked in a reverse-record cell (refunded when cleared/replaced). */
const REVERSE_CELL_CKB = 150
/**
 * CKB locked in an offer cell. It has to cover 40 bytes of args and the seller's
 * lock script in its data, and it goes to whoever completes the sale, which is
 * roughly what the transaction costs them.
 */
const OFFER_CELL_CKB = 160
/**
 * The most cells one transaction takes from under a deed's lock: a page of
 * `sweepDeedDown`, and what a melt carries beside the Spore.
 */
const DEED_PAGE = 200

/** The node's own floor, in shannons per 1000 bytes. Below it the pool rejects. */
const MIN_FEE_RATE = 1000
/** What we pay: twice the floor, so a fee rate that rises between building and
 *  broadcasting does not strand the transaction. Records ride in the witness and the
 *  witness is now counted, so this is a margin, not a cover for unmeasured bytes. */
const FEE_RATE = 2000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A listing's split: in shannons, which a purchase pays, and in CKB, which a page shows. */
function offerSplit(price: bigint): Pick<SaleOffer, 'priceCkb' | 'toSeller' | 'toTreasury' | 'toSellerShannons' | 'toTreasuryShannons'> {
  const split = saleSplitShannons(price)
  const priceCkb = Number(price) / 1e8
  const toTreasury = Number(split.toTreasury) / 1e8
  return { priceCkb, toSeller: priceCkb - toTreasury, toTreasury, toSellerShannons: split.toSeller, toTreasuryShannons: split.toTreasury }
}

export class CellsClient {
  readonly client: ccc.Client
  readonly dep: Deployment

  // A tiny read-through cache for the two whole-namespace scans the UI leans on,
  // `list()` and `offers()`. A page that mounts three panels then scans once, and
  // moving between names within a few seconds costs nothing. It holds the pending
  // promise, not just the value, so concurrent callers share one request. Every
  // write clears it (see `finalize`), so a name is never shown in a state its
  // owner already changed. Write paths read fresh regardless, never from here.
  private cache = new Map<string, { at: number; value: Promise<unknown> }>()
  private static readonly TTL_MS = 15_000
  // The plate this client fed last, by plate lock hash: the next meal goes on top of it
  // while the indexer has not shown it yet (decision 0042).
  private lastPlate = new Map<string, ccc.OutPointLike>()

  constructor(client: ccc.Client, dep: Deployment) {
    this.client = client
    this.dep = dep
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < CellsClient.TTL_MS) return hit.value as Promise<T>
    const value = load()
    this.cache.set(key, { at: Date.now(), value })
    // A rejected scan must not stick, or one blip would be served for the whole TTL.
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key)
    })
    return value
  }

  /** Drop the read cache. Called after every write so the next read is fresh. */
  invalidate(): void {
    this.cache.clear()
  }

  /**
   * When the block carrying `txHash` was mined, in unix seconds, or null while the
   * transaction is still pending.
   *
   * Two round trips (the transaction, then its header), which is why the answer is
   * memoized outside the fifteen-second read cache: once a transaction is in a
   * block, the time it went in never changes again. Used to say how long a name
   * has been listed for, since an offer cell records no time of its own.
   */
  async txTime(txHash: Hex): Promise<number | null> {
    const hit = this.times.get(txHash)
    if (hit !== undefined) return hit
    const tx = await this.client.getTransaction(txHash)
    if (!tx?.blockHash) return null // pending: ask again later
    const header = await this.client.getHeaderByHash(tx.blockHash)
    if (!header) return null
    const at = Math.floor(Number(header.timestamp) / 1000)
    this.times.set(txHash, at)
    return at
  }
  private times = new Map<string, number>()

  accountType(): ccc.Script {
    return ccc.Script.from({
      codeHash: this.dep.account.codeHash,
      hashType: this.dep.account.hashType,
      args: namespaceArgs(this.dep.configTypeHash), // the token hash, truncated (decision 0015)
    })
  }
  accountLock(): ccc.Script {
    return ccc.Script.from({ codeHash: this.dep.lock.codeHash, hashType: this.dep.lock.hashType, args: '0x' })
  }
  /** The price cell's type script (decision 0014), or null when the deployment has none. */
  priceType(): ccc.Script | null {
    const p = this.dep.price
    return p ? ccc.Script.from({ codeHash: p.codeHash, hashType: p.hashType, args: p.typeArgs }) : null
  }
  /**
   * The one live price cell, found by its type script at call time and never by a
   * remembered outpoint: the outpoint moves on every update. Null when the deployment
   * has no price cell or none is live.
   */
  async priceCell(): Promise<PriceCell | null> {
    const type = this.priceType()
    if (!type) return null
    for await (const c of this.client.findCellsByType(type)) {
      return {
        outPoint: { txHash: c.outPoint.txHash as Hex, index: Number(c.outPoint.index) },
        factorBps: parsePriceFactor(c.outputData),
        capacity: c.cellOutput.capacity,
        lock: c.cellOutput.lock,
        data: c.outputData as Hex,
      }
    }
    return null
  }
  /** The discount factor in force, in basis points; the full price when there is none. */
  async priceFactor(): Promise<number> {
    const p = await this.priceCell()
    return p?.factorBps ?? PRICE_FACTOR_MAX
  }
  /** What a registration or renewal costs today, in shannons: the schedule after the factor. */
  async effectiveFeeShannons(label: string, years = 1): Promise<bigint> {
    return applyPriceFactor(ccc.fixedPointFrom(registrationFeeCkb(label, years)), await this.priceFactor())
  }
  /** As `effectiveFeeShannons`, in CKB, for display. */
  async effectiveFeeCkb(label: string, years = 1): Promise<number> {
    return Number(await this.effectiveFeeShannons(label, years)) / 1e8
  }
  /**
   * Move the price cell to a new factor (decision 0014). Signed by whoever holds the
   * cell's lock, the pricing key. The chain allows a sixteenth's step every six hours, so
   * this refuses what the chain would refuse, with a message that says why.
   */
  async setPriceFactor(signer: ccc.Signer, bps: number): Promise<Hex> {
    const p = await this.priceCell()
    if (!p) throw new Error('cells: this deployment has no price cell')
    if (p.factorBps !== null && !priceStepOk(p.factorBps, bps))
      throw new Error(
        `cells: the factor may move at most a sixteenth per update; from ${p.factorBps} one step reaches ${priceStepToward(p.factorBps, bps)}`,
      )
    const type = this.priceType()!
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: p.outPoint, since: REL_TS | BigInt(PRICE_COOLDOWN_SECS) }],
      outputs: [{ lock: p.lock, type, capacity: p.capacity }],
      outputsData: [priceData(bps)],
      cellDeps: [this.cd(this.dep.price!.dep)],
    })
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, 2000)
    const h = await signer.sendTransaction(tx)
    this.invalidate()
    return h as Hex
  }
  private cd(d: DepInfo): ccc.CellDep {
    return ccc.CellDep.from({ outPoint: { txHash: d.txHash, index: d.index }, depType: d.depType })
  }
  /**
   * The lock every fee is paid to, from the deployment when it carries one.
   *
   * Hard-coding this is what burned 5,000 CKB on 2026-09-21. `TREASURY_LOCK` is the
   * testnet JoyID script; on mainnet no cell provides that code, so the fee output was
   * unspendable from the moment it was written, and the contract noticed nothing because
   * the payer's own change had already satisfied it. A constant that is correct on one
   * network and silently destroys money on another belongs in the deployment, which is
   * per network, and not in the source, which is not.
   */
  private treasuryLock(): ccc.Script {
    const lock = ccc.Script.from(this.dep.treasury ?? TREASURY_LOCK)
    // And it has to hash to what the contract will check. This is the part that makes the
    // mistake impossible rather than merely unlikely: a script for the wrong network
    // cannot hash to the right value, so the payment is refused here instead of being
    // written to a lock nobody can open.
    const want = this.dep.treasuryLockHash ?? TREASURY_LOCK_HASH
    if (lock.hash() !== want) {
      throw new Error(
        `cells: the treasury lock in this deployment hashes to ${lock.hash()}, but the contract requires ${want}. ` +
          'A fee built from it would be paid to the wrong place, and on the wrong network it would be unspendable.',
      )
    }
    return lock
  }

  /** The smallest output the treasury lock can hold, in shannons (63 CKB with the JoyID treasury). */
  private treasuryMin(): bigint {
    return BigInt(ccc.CellOutput.from({ lock: this.treasuryLock(), capacity: 0 }).occupiedSize) * 100_000_000n
  }

  /**
   * Stream every live AccountCell's `data` and position, **without** fetching a
   * witness for each. One indexer query, no per-cell `getTransaction`, so finding a
   * name by label or a predecessor by (id, next) is one round trip, not one per name.
   */
  async *liveCellsLite(): AsyncGenerator<LiveAccountLite> {
    const type = this.accountType()
    // A hundred to a page, not the client's ten: every page is a round trip to the node,
    // and this scan is behind every list, so on testnet's 43 names it was five trips in a
    // row where one will do, and on a network with thousands it is the whole wait.
    for await (const c of this.client.findCellsByType(type, true, undefined, 100)) {
      const data = c.outputData as Hex
      yield {
        ...parseAccountLite(data),
        outPoint: { txHash: c.outPoint.txHash as Hex, index: Number(c.outPoint.index) },
        capacity: c.cellOutput.capacity,
        data,
      }
    }
  }

  /**
   * The records of a chosen few names, read at their outpoints: the rows a directory has on
   * screen, not every name on the network, which is one round trip per name. A name whose
   * payload cannot be decoded is left out, as `list()` leaves it out.
   */
  async hydrateMany(lites: LiveAccountLite[]): Promise<LiveAccount[]> {
    return this.hydrateAll(lites)
  }

  /**
   * Hydrate many lite cells at once, capped so we do not open a socket per name.
   * Order is preserved. This is where `list()` spends its time: one witness fetch
   * per name, and running them in parallel cuts the wall time by the cap.
   */
  private async hydrateAll(lites: LiveAccountLite[], concurrency = 8): Promise<LiveAccount[]> {
    const out: (LiveAccount | null)[] = new Array(lites.length).fill(null)
    let next = 0
    const worker = async () => {
      while (next < lites.length) {
        const i = next++
        out[i] = await this.hydrateOrSkip(lites[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, lites.length) }, worker))
    return out.filter((a): a is LiveAccount => a !== null)
  }

  /**
   * `hydrate`, but a name whose payload cannot be decoded is dropped rather than
   * thrown. The contract checks only that the payload hashes to the cell's
   * commitment, never its shape, so anyone can register a name whose records are
   * garbage. Before this, one such cell made `list()` reject as a whole and took the
   * directory and the resolver's snapshot down for every other name. The bad name is
   * still readable on its own through `getAccount`, which throws for it alone.
   */
  private async hydrateOrSkip(lite: LiveAccountLite): Promise<LiveAccount | null> {
    try {
      return await this.hydrate(lite)
    } catch (e) {
      console.warn(`cells: skipping ${lite.label || '(root)'}: ${e instanceof Error ? e.message : e}`)
      return null
    }
  }

  /** Fetch the witness for one lite cell and parse it into a full `LiveAccount`. */
  // What an outpoint holds never changes, so a name read at an outpoint is not read again:
  // My names fetched the transaction of every one of the wallet's names on every visit.
  // Keyed by outpoint, so an edited name (a new outpoint) is read fresh; a failed read is
  // dropped rather than kept.
  private readonly hydrated = new Map<string, Promise<LiveAccount>>()
  private async hydrate(lite: LiveAccountLite): Promise<LiveAccount> {
    const key = `${lite.outPoint.txHash}:${lite.outPoint.index}`
    const hit = this.hydrated.get(key)
    if (hit) return hit
    const read = this.hydrateFresh(lite)
    this.hydrated.set(key, read)
    read.catch(() => this.hydrated.delete(key))
    if (this.hydrated.size > 5000) this.hydrated.delete(this.hydrated.keys().next().value as string)
    return read
  }
  private async hydrateFresh(lite: LiveAccountLite): Promise<LiveAccount> {
    // A cell the indexer just returned always has its transaction, but the type
    // says otherwise and the type is the thing that catches the day it does not.
    const res = await this.client.getTransaction(lite.outPoint.txHash)
    if (!res) throw new Error(`cells: the transaction behind ${lite.outPoint.txHash} is not available`)
    const wa = ccc.WitnessArgs.fromBytes(res.transaction.witnesses[lite.outPoint.index])
    const witness = (wa.outputType ?? '0x') as Hex
    return {
      ...parseAccount(lite.data, witness),
      outPoint: lite.outPoint,
      capacity: lite.capacity,
      data: lite.data,
      witness,
      // Already in the answer that carried the witness, so it costs nothing to keep.
      blockNumber: res.blockNumber === undefined ? undefined : Number(res.blockNumber),
      blockHash: res.blockHash as Hex | undefined,
    }
  }

  /** Stream every live AccountCell (incl. the root) with its parsed payload. */
  async *liveCells(): AsyncGenerator<LiveAccount> {
    for await (const lite of this.liveCellsLite()) {
      const a = await this.hydrateOrSkip(lite)
      if (a) yield a
    }
  }

  /**
   * The chain's **median time**, unix seconds.
   *
   * This is the clock consensus uses for timestamp-based `since` values, and it
   * trails real time by a couple of minutes because it is the median of recent
   * block timestamps. Anything that waits for a commit to mature has to wait on
   * this, not on the wall clock, or it gives up before the network would have
   * accepted it.
   */
  async medianTimeSeconds(): Promise<number | null> {
    // `getTipHeader()` has a `median` field in CCC's types and NOT in its answers,
    // so reading it gave NaN. The value comes from `get_block_median_time`, which
    // the HTTP endpoint answers (with `access-control-allow-origin: *`, so a browser
    // can call it) while the client itself talks over the websocket.
    const ws = (this.client as unknown as { url?: string }).url
    if (!ws) return null
    const http = ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws$/, '/')
    try {
      const tip = await this.client.getTipHeader()
      const res = await fetch(http, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'get_block_median_time', params: [tip.hash] }),
      })
      const body = await res.json()
      return body?.result ? Math.floor(Number(BigInt(body.result)) / 1000) : null
    } catch {
      // Null means "no estimate", which callers must show as such. Guessing here
      // would put the wrong number back on the screen, which is the whole bug.
      return null
    }
  }

  // --- forward resolution (name → …) ---

  async list(): Promise<LiveAccount[]> {
    return this.cached('list', async () => {
      // Collect the cheap lite view first (one indexer scan, no witnesses), drop the
      // root sentinel, then fetch the witnesses in parallel instead of one at a time.
      const lites: LiveAccountLite[] = []
      for await (const lite of this.liveCellsLite()) if (lite.label !== '') lites.push(lite)
      return this.hydrateAll(lites)
    })
  }

  /**
   * Every live name in the witness-free view: label, id, expiry and owner, but **no
   * records**. One indexer scan, zero `getTransaction`. For screens that only need to
   * count names, list labels, or find who owns what, so they do not pay to fetch every
   * name's records just to show a count.
   */
  async liteList(): Promise<LiveAccountLite[]> {
    return this.cached('liteList', async () => {
      const out: LiveAccountLite[] = []
      for await (const lite of this.liveCellsLite()) if (lite.label !== '') out.push(lite)
      return out
    })
  }

  /**
   * The names a wallet owns (plus any it has listed for sale), fetching records only
   * for those. Finds them in the witness-free view by `owner_lock_hash` (and, for a
   * listed name, by whose offer names them as seller), then hydrates just the matches,
   * so a wallet with three names does not pay to fetch three thousand. `listed` maps a
   * name's id to its asking price.
   */
  async ownedNames(lockHash: string, lock?: ccc.ScriptLike): Promise<{ names: LiveAccount[]; listed: Map<Hex, number>; deeds: Map<Hex, Hex> }> {
    const [lite, offers, held] = await Promise.all([
      this.liteList(),
      this.offers(),
      // Names held as deeds (decision 0036): owned by a proxy lock over a Spore this
      // wallet holds. Only findable from the lock itself, so a caller with just the
      // hash gets the other kinds and none of these.
      lock ? deedsHeldBy(this.client, lock) : Promise.resolve(new Map<Hex, { sporeId: Hex; sporeTypeHash: Hex }>()),
    ])
    // Owned, listed by this wallet, or managed by it: a name behind a quantum key
    // (decision 0016) is owned by that key and managed by the wallet that put it there.
    const me = ownerId(lockHash)
    const mine = lite.filter(
      (a) => a.ownerLockHash === me || a.managerLockHash === me || offers.get(a.ownerLockHash)?.seller === lockHash || held.has(a.ownerLockHash),
    )
    const names = await this.hydrateAll(mine)
    const listed = new Map<Hex, number>()
    const deeds = new Map<Hex, Hex>()
    for (const n of names) {
      const o = offers.get(n.ownerLockHash)
      if (o && o.seller === lockHash) listed.set(n.id, o.priceCkb)
      const d = held.get(n.ownerLockHash)
      if (d) deeds.set(n.id, d.sporeId)
    }
    return { names, listed, deeds }
  }
  async getAccount(name: string): Promise<LiveAccount | null> {
    const label = name.replace(/\.cell$/, '')
    // Match on the label (which is in `data`) and pay for the witness of the one
    // hit, not of every name we pass on the way to it. Stays uncached on purpose:
    // it feeds the write paths, which must read the live cell right before spending it.
    for await (const lite of this.liveCellsLite()) if (lite.label === label) return this.hydrate(lite)
    return null
  }
  /** First `address.<coinType>` value for a name (60 = ETH), or null. */
  async resolve(name: string, coinType = '60'): Promise<Hex | null> {
    const a = await this.getAccount(name)
    return a?.records.find((r) => r.key === `address.${coinType}`)?.value ?? null
  }
  async addresses(name: string, coinType = '60'): Promise<Hex[]> {
    const a = await this.getAccount(name)
    return (a?.records ?? []).filter((r) => r.key === `address.${coinType}`).map((r) => r.value)
  }
  async records(name: string, prefix = ''): Promise<RecordEntry[]> {
    const a = await this.getAccount(name)
    return (a?.records ?? []).filter((r) => r.key.startsWith(prefix))
  }
  /** The Fiber payment endpoint a name publishes, or null if it publishes none. */
  async fiber(name: string): Promise<FiberEndpoint | null> {
    const a = await this.getAccount(name)
    return a ? parseFiber(a.records) : null
  }
  /**
   * The CKB on-chain address a name publishes (`address.309`), or null.
   *
   * `isOwner` says whether that address is the name's own owner wallet. The cell stores
   * the owner's lock **hash**, which cannot be inverted into an address, so the address
   * has to be published, but it can always be *checked*: hash the address's lock and
   * compare. A published address that is not the owner is not an error (you may want
   * payouts going elsewhere), it just means something different to the reader.
   */
  async ckbAddress(name: string): Promise<{ address: string; isOwner: boolean } | null> {
    const a = await this.getAccount(name)
    return a ? this.ckbAddressOf(a) : null
  }
  /**
   * The published CKB address of an account you already hold, no fetch. A page that
   * has the name from `list()` should call this instead of `ckbAddress(name)`, which
   * would scan the whole namespace again for a cell it is already looking at.
   */
  async ckbAddressOf(a: LiveAccount): Promise<{ address: string; isOwner: boolean } | null> {
    const v = a.records.find((r) => r.key === CKB_ADDRESS_KEY)?.value
    if (!v) return null
    const address = valueToText(v)
    let isOwner = false
    try {
      isOwner = ownerId((await ccc.Address.fromString(address, this.client)).script.hash() as Hex) === a.ownerLockHash
    } catch {
      isOwner = false // unparseable: not the owner, and the UI should say so
    }
    // A name held as a deed (decision 0036) is owned by a lock nobody pays to; the
    // holder of the deed is the owner in substance, so their address counts as the
    // owner's own.
    //
    // Only where deeds exist. This runs on every profile and every pay screen, and
    // following the link costs an indexer scan, so a network with no deeds cluster does
    // not pay for a feature it does not have. A deed made by hand on such a network
    // would show as "paid to a different wallet", which is not false.
    if (!isOwner && this.dep.deedCluster) {
      const deed = await deedOfAccount(this.client, a).catch(() => null)
      if (deed?.holder) {
        try {
          isOwner = (await ccc.Address.fromString(address, this.client)).script.eq(deed.holder.lock)
        } catch {
          isOwner = false
        }
      }
    }
    return { address, isOwner }
  }
  /** Names that list `value` under `address.<coinType>` (reverse resolution). */
  async reverse(value: Hex, coinType = '60'): Promise<LiveAccount[]> {
    const key = `address.${coinType}`
    const out: LiveAccount[] = []
    for await (const a of this.liveCells()) {
      if (a.label !== '' && a.records.some((r) => r.key === key && r.value === value)) out.push(a)
    }
    return out
  }

  // --- reverse records: a wallet's primary name (decision 0006) ---

  /**
   * Set the signer's **primary name** (address → name). Writes a small reverse-record
   * cell under the signer's own lock, replacing any existing one. Needs no type
   * script, `primaryName()` forward-verifies the claim, so it is trustless to read.
   * Pass an empty `name` to clear it (just spends the existing record).
   */
  async setPrimary(signer: ccc.Signer, name: string): Promise<Hex> {
    const label = name.replace(/\.cell$/, '')
    const clearing = label === ''
    if (!clearing && !isValidLabel(label)) throw new Error('cells: invalid label')
    const lock = (await signer.getRecommendedAddressObj()).script
    const inputs: { previousOutput: { txHash: Hex; index: number } }[] = []
    for await (const c of this.client.findCellsByLock(lock)) {
      if (!c.cellOutput.type && decodeReverse(c.outputData as Hex) !== null) {
        inputs.push({ previousOutput: { txHash: c.outPoint.txHash as Hex, index: Number(c.outPoint.index) } })
        break // there should be at most one
      }
    }
    const outputs = clearing ? [] : [{ lock, capacity: ccc.fixedPointFrom(REVERSE_CELL_CKB) }]
    const outputsData = clearing ? [] : [encodeReverse(label)]
    const tx = ccc.Transaction.from({ inputs, outputs, outputsData })
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, 2000) // same over-provision as commit/finalize
    const h = (await signer.sendTransaction(tx)) as Hex
    await this.client.waitTransaction(h, 0, 300_000)
    return h
  }

  /**
   * The verified **primary name** for an address (or lock), or null. Reads the
   * reverse-record cell under the lock, then confirms by forward lookup that the name
   * really answers to that lock, so a forged reverse record resolves to nothing.
   *
   * "Answers to" means the lock is the name's owner **or** the manager the owner
   * nominated. The manager was added because the owner is not always a wallet: a name
   * behind a post-quantum key (decision 0016) is owned by a key kept offline and managed
   * by the everyday wallet, and refusing the manager left exactly those names unable to
   * show themselves, while our own app happily offered them in the picker. A manager
   * already edits the records, which includes where the money goes, so displaying the
   * name is not the larger power; but it is a power, and "share access" says so.
   *
   * It is not a cheap call: it walks the lock's cells and then does a forward lookup for
   * the label it finds, so it costs a scan and a half against a node, not a key read. Ask
   * it once where you already know whose address this is, keep what it returns beside the
   * address, and never put it in the path that draws a row. The hosted resolver's
   * `/primary/:address` is the same answer with a minute of cache in front of it.
   */
  async primaryName(addressOrLock: string | ccc.Script): Promise<string | null> {
    return (await this.primary(addressOrLock))?.name ?? null
  }

  /**
   * `primaryName` with the one thing it used to throw away: when the name runs out. The
   * forward lookup that proves the name is really theirs has the account in hand, and the
   * account carries `expiredAt`; an integrator showing "the name you can pay" needs it, and
   * had to make a second call to `/resolve` to get it. Same verification, same null when
   * there is nothing; an expired name is still returned, with its date, because the
   * resolver says what it knows and the caller decides what a lapsed name means to them.
   */
  async primary(addressOrLock: string | ccc.Script): Promise<{ name: string; expiredAt: number } | null> {
    const lock =
      typeof addressOrLock === 'string'
        ? (await ccc.Address.fromString(addressOrLock, this.client)).script
        : addressOrLock
    const lockHash = lock.hash() as Hex
    // Only a cell with no type, holding a tag and a label, can be a reverse record, and
    // the node can be asked for just those: walking every cell of the lock downloaded
    // every Spore and token it holds, data included. For one wallet on testnet that was
    // 85 cells and 2.3 s on every visit to My names (measured 2026-09-25).
    for await (const c of this.client.findCells(
      {
        script: lock,
        scriptType: 'lock',
        scriptSearchMode: 'exact',
        filter: { scriptLenRange: [0, 1], outputDataLenRange: [REVERSE_TAG_LENGTH, REVERSE_TAG_LENGTH + 256] },
        withData: true,
      },
      'asc',
      50,
    )) {
      if (c.cellOutput.type) continue
      const label = decodeReverse(c.outputData as Hex)
      if (label === null) continue
      const fwd = await this.getAccount(label) // forward lookup
      const me = ownerId(lockHash)
      if (fwd && (fwd.ownerLockHash === me || fwd.managerLockHash === me))
        return { name: label + '.cell', expiredAt: fwd.expiredAt } // consistent both ways
      // A name held as a deed (decision 0036) answers to whoever holds the deed: the
      // owner it records is a lock nobody signs for, and the holder can do everything
      // the owner can, so the holder's wallet may show the name as its own.
      if (fwd) {
        const deed = await deedOfAccount(this.client, fwd).catch(() => null)
        if (deed?.holder && deed.holder.lock.eq(lock)) return { name: label + '.cell', expiredAt: fwd.expiredAt }
      }
    }
    return null
  }

  // --- write: permissionless register ---

  /**
   * Is a label available? (also returns its computed id + the predecessor).
   *
   * `predecessor: false` leaves the predecessor unread and returns null for it: a caller
   * that only asks whether the name is free (a screen checking as you type, the shop's
   * quote) saves the round trip for its transaction, about 170 ms on Pudge. A registration
   * reads it itself.
   */
  async availability(
    label: string,
    { predecessor = true }: { predecessor?: boolean } = {},
  ): Promise<{ available: boolean; id: Hex; predecessor: LiveAccount | null }> {
    const id = accountId(label)
    let pred: LiveAccountLite | null = null
    for await (const a of this.liveCellsLite()) {
      if (a.label === label) return { available: false, id, predecessor: null }
      if (between(a.id, a.next, id)) pred = a
    }
    // Only the predecessor is spent by a registration, so it is the only cell whose
    // witness we need; the rest of the scan stayed witness-free.
    return { available: true, id, predecessor: pred && predecessor ? await this.hydrate(pred) : null }
  }

  /**
   * Phase 1 of registration: publish a hiding **commitment** for `label`
   * (anti front-running, decision 0004). Returns the `secret` and the CommitCell's
   * outpoint, keep both, wait `minDelaySeconds`, then call `register({ secret,
   * commit })`. The commitment hides the label and binds the owner, so no one can
   * copy or steal the eventual reveal. The CommitCell's CKB is refunded at reveal.
   */
  async commit(
    signer: ccc.Signer,
    label: string,
    opts: { owner?: Hex; onSent?: (txHash: Hex) => void } = {},
  ): Promise<CommitResult> {
    if (!isValidLabel(label))
      throw new Error('cells: invalid label (1 to 40 of [a-z0-9-], no leading/trailing hyphen)')
    const lock = (await signer.getRecommendedAddressObj()).script
    // The name will be this wallet's, so a lock anyone can spend is refused before the
    // reservation's coins are spent rather than at the claim.
    await this.refuseOpenLock(lock, "this wallet's address", 'owner')
    const owner = opts.owner ?? (lock.hash() as Hex)
    const secret = randomSecret()
    const cm = commitment(this.dep.configTypeHash, label, owner, secret)
    const tx = ccc.Transaction.from({
      outputs: [{ lock, capacity: ccc.fixedPointFrom(COMMIT_CELL_CKB) }],
      outputsData: [cm], // the cell's whole data IS the commitment
    })
    await tx.completeInputsByCapacity(signer)
    // 2000, the same over-provision `finalize` uses. At 1000 this landed a few
    // hundred shannons under the node's floor and the commit was rejected outright
    // (LowFeeRate), which costs a user the whole registration for the price of a
    // rounding difference. The floor is a minimum, so sitting above it is free.
    await tx.completeFeeBy(signer, 2000)
    const txHash = (await signer.sendTransaction(tx)) as Hex
    opts.onSent?.(txHash)
    await this.client.waitTransaction(txHash, 0, 300_000)
    // When the commit landed, by the chain's own clock. The reveal is valid once
    // the median time passes this plus the delay.
    const blockHash = (await this.client.getTransaction(txHash))?.blockHash
    const header = blockHash ? await this.client.getHeaderByHash(blockHash) : null
    const committedAt = header ? Math.floor(Number(header.timestamp) / 1000) : Math.floor(Date.now() / 1000)
    return {
      secret,
      commitment: cm,
      owner,
      outPoint: { txHash, index: 0 },
      txHash,
      minDelaySeconds: COMMIT_MIN_DELAY,
      readyAtMedian: committedAt + COMMIT_MIN_DELAY,
    }
  }

  /**
   * Phase 2 (reveal): register `label` permissionlessly, signed by `signer` (its
   * lock hash becomes the name's owner). Spends the matured CommitCell from a prior
   * `commit()` (pass `opts.secret` + `opts.commit`), reveals the secret in the new
   * cell's witness, builds the splice (predecessor preserved + new cell), funds/fees
   * from the signer, and broadcasts. The reveal is rejected by consensus until the
   * commit is `COMMIT_MIN_DELAY` old. Returns the tx hash.
   */
  async register(signer: ccc.Signer, label: string, opts: RegisterOptions = {}): Promise<Hex> {
    if (!isValidLabel(label))
      throw new Error('cells: invalid label (1 to 40 of [a-z0-9-], no leading/trailing hyphen)')
    if (!opts.secret || !opts.commit)
      throw new Error(
        'cells: register requires a matured commit: call commit() first, wait COMMIT_MIN_DELAY, then register({ secret, commit }) (or use registerWithCommit)',
      )
    const ownerLock = (await signer.getRecommendedAddressObj()).script
    await this.refuseOpenLock(ownerLock, "this wallet's address", 'owner')
    const { available, id, predecessor } = await this.availability(label)
    if (!available) throw new Error(`cells: ${label}.cell already registered`)
    if (!predecessor) throw new Error('cells: no predecessor covers the new id (list inconsistent?)')

    const owner = ownerLock.hash() as Hex

    // p', predecessor preserved byte-for-byte except `next` (its witness unchanged).
    const pOutData = buildAccountData(
      predecessor.witnessHash,
      id,
      predecessor.expiredAt,
      predecessor.ownerLockHash,
      predecessor.managerLockHash,
      predecessor.label,
    )
    // The commit cell's block header. The contract reads "now" from it, both for the
    // L-2 clock and to price the term, so the expiry is computed from the same
    // instant rather than from this machine's clock (decision 0009).
    const commitBlockHash = (await this.client.getTransaction(opts.commit.txHash))?.blockHash
    if (!commitBlockHash) throw new Error('cells: commit tx not yet confirmed (no block header)')
    const header = await this.client.getHeaderByHash(commitBlockHash)
    if (!header) throw new Error('cells: the commit block header is not available')
    const now = Number(header.timestamp / 1000n)

    const years = opts.years ?? MIN_TERM_YEARS
    if (!Number.isInteger(years) || years < MIN_TERM_YEARS || years > MAX_TERM_YEARS)
      throw new Error(`cells: a name is bought for ${MIN_TERM_YEARS} to ${MAX_TERM_YEARS} whole years`)
    const expiredAt = opts.expiredAt ?? now + years * SECONDS_PER_YEAR
    // An explicit expiry still has to be paid for, by the years it actually covers.
    const chargedYears = opts.expiredAt ? yearsForTerm(opts.expiredAt - now) : years
    if (chargedYears < MIN_TERM_YEARS || chargedYears > MAX_TERM_YEARS)
      throw new Error(
        `cells: that expiry is ${chargedYears} years out; the contract allows ${MIN_TERM_YEARS} to ${MAX_TERM_YEARS}`,
      )

    // x, the new account, owned by the signer.
    const w: WitnessData = { records: opts.records ?? [] }
    const x = buildAccount(w, predecessor.next, expiredAt, owner, owner, label) // undelegated

    // A sub-name must present its parent as a cell dep, and the signer must be the
    // parent's owner (decision 0008). Checked here so the failure is a clear message
    // instead of an on-chain ParentMissing/Unauthorized.
    const parentDeps: { outPoint: { txHash: Hex; index: number }; depType: 'code' }[] = []
    // The parent's owner proves authority by spending a cell of their own in this
    // transaction. It is handed straight back in an output of the same capacity, so
    // co-signing costs the parent's owner nothing but a signature.
    const parentInputs: { previousOutput: ccc.OutPointLike }[] = []
    const parentOutputs: { lock: ccc.Script; capacity: bigint }[] = []
    // Or the parent is held as a deed (decision 0036) and its holder proves it with the
    // deed: the proxy cell is the input under the parent owner's lock that the contract
    // asks for, and it opens only with the Spore in the same transaction.
    let parentDeed: { link: DeedLink; holder: ccc.Signer } | undefined
    const parent = parentLabel(label)
    if (parent) {
      const p = await this.getAccount(parent)
      if (!p) throw new Error(`cells: parent ${parent}.cell is not registered`)
      const parentKey = opts.parentSigner ?? signer
      const parentOwnerLock = (await parentKey.getRecommendedAddressObj()).script
      if (p.ownerLockHash !== ownerId(parentOwnerLock.hash() as Hex)) {
        const refusal = opts.parentSigner
          ? `cells: the key given as the owner of ${parent}.cell does not own it`
          : `cells: only the owner of ${parent}.cell may create ${label}.cell`
        const { deed } = await this.authority(parentKey, p, 'owner', refusal)
        if (!deed) throw new Error(refusal)
        parentDeed = { link: deed, holder: parentKey }
      }
      if (expiredAt > p.expiredAt)
        throw new Error(`cells: a sub-name may not outlive its parent (${parent}.cell expires ${p.expiredAt})`)
      parentDeps.push({ outPoint: p.outPoint, depType: 'code' })
      // The co-sign dance is for a parent held by ANOTHER key: one of that key's cells is
      // spent and returned untouched, purely so the contract can see its authority.
      //
      // When `parentSigner` is the same key as `signer` it proves nothing that is not
      // already proven, and it costs: the cell it locks up is returned at its exact
      // capacity, so it cannot pay the fee, and a wallet with plenty reports
      // `Insufficient CKB, need 923.1 extra CKB`. That message sends you to look at a
      // balance that is fine. Passing `parentSigner` when you are the owner is the
      // natural mistake, because the option reads as "say who the parent's owner is",
      // and it made every sub-name registration fail by that exact amount until the
      // option was dropped. Same key, no dance.
      const sameKey = (await signer.getRecommendedAddressObj()).script.hash() === parentOwnerLock.hash()
      if (opts.parentSigner && !sameKey && !parentDeed) {
        const cell = await this.plainCell(parentOwnerLock)
        if (!cell)
          throw new Error(
            `cells: the owner of ${parent}.cell holds no ordinary cell to prove it with; send it a little CKB first`,
          )
        parentInputs.push({ previousOutput: cell.outPoint })
        parentOutputs.push({ lock: parentOwnerLock, capacity: cell.cellOutput.capacity })
      }
    }

    // A referral (decision 0011). A tenth of the fee goes to the owner of an existing
    // name and comes off the treasury's share, so this costs the buyer nothing.
    //
    // The contract knows the inviter only as an `owner_lock_hash`, and a hash cannot
    // be turned back into an address, so the inviter must have published its owner's
    // own CKB address on the name. That is the same `isOwner` check the public profile
    // shows as "paid to the owner's own wallet", and it is what stops a referral being
    // routed to somebody else's wallet.
    const referralDeps: { outPoint: { txHash: Hex; index: number }; depType: 'code' }[] = []
    const referralOuts: { lock: ccc.Script; capacity: bigint }[] = []
    // The schedule after the price cell's discount (decision 0014), in shannons, the
    // way the contract computes it. The cell rides along as a dep so the contract can
    // read it; without it the contract charges the full price.
    const price = opts.usePriceCell === false ? null : await this.priceCell()
    const priceDeps: { outPoint: { txHash: Hex; index: number }; depType: 'code' }[] = price
      ? [{ outPoint: price.outPoint, depType: 'code' }]
      : []
    const fee = applyPriceFactor(ccc.fixedPointFrom(registrationFeeCkb(label, chargedYears)), price?.factorBps ?? PRICE_FACTOR_MAX)
    let treasury = fee
    if (opts.inviter) {
      const inviter = opts.inviter.replace(/\.cell$/, '')
      const inv = await this.getAccount(inviter)
      if (!inv) throw new Error(`cells: ${inviter}.cell is not registered, so it cannot invite anyone`)
      // The contract denies the cut to anyone who signed the transaction, so this
      // would silently fall back to the full fee and reject as TreasuryUnpaid.
      if (inv.ownerLockHash === ownerId(owner))
        throw new Error(
          `cells: ${inviter}.cell belongs to this wallet, and a referral cannot be paid to whoever signs the registration`,
        )
      const paid = await this.ckbAddress(inviter)
      if (!paid || !paid.isOwner)
        throw new Error(
          `cells: ${inviter}.cell has not published its owner's own CKB address, so there is nowhere to send the referral`,
        )
      // A tenth of what is charged, i.e. of the discounted fee (the contract's
      // `referral_cut(fee)`). Deep in a discount that tenth can be smaller than a
      // cell, so the inviter is paid at least the minimum a cell can hold; the
      // contract only asks that they receive at least the cut.
      const cut = fee / 10n
      const inviterLock = (await ccc.Address.fromString(paid.address, this.client)).script
      const inviterMin = BigInt(ccc.CellOutput.from({ lock: inviterLock, capacity: 0 }).occupiedSize) * 100_000_000n
      referralDeps.push({ outPoint: inv.outPoint, depType: 'code' })
      referralOuts.push({ lock: inviterLock, capacity: cut < inviterMin ? inviterMin : cut })
      treasury -= cut
    }

    const type = this.accountType()
    const lock = this.accountLock()
    const tx = ccc.Transaction.from({
      inputs: [
        { previousOutput: predecessor.outPoint }, // always-success lock → anyone may spend
        // the matured CommitCell, relative-timestamp since enforces MIN_DELAY age.
        { previousOutput: opts.commit, since: REL_TS | BigInt(COMMIT_MIN_DELAY) },
        ...parentInputs,
      ],
      outputs: [
        { lock, type, capacity: predecessor.capacity }, // p' (capacity preserved)
        // new cell: meet the on-chain price floor (refundable rent) unless overridden
        { lock, type, capacity: ccc.fixedPointFrom(opts.capacityCkb ?? registerCapacityCkb(label)) },
        // the registration fee, which unlike the rent does not come back. At the
        // floor with a referral it can dip under what a treasury cell can hold, so
        // it is topped up to that minimum; the contract only asks for at least the fee.
        {
          lock: this.treasuryLock(),
          capacity: treasury < this.treasuryMin() ? this.treasuryMin() : treasury,
        },
        ...referralOuts,
        ...parentOutputs,
      ],
      outputsData: [
        pOutData,
        x.data,
        '0x',
        ...referralOuts.map(() => '0x' as Hex),
        ...parentOutputs.map(() => '0x' as Hex),
      ],
      cellDeps: [
        this.cd(this.dep.accountDep),
        this.cd(this.dep.lockDep),
        ...parentDeps,
        ...referralDeps,
        ...priceDeps,
      ],
      headerDeps: [commitBlockHash], // L-2 future-expiry clock
    })
    return this.finalize(
      tx,
      signer,
      [
        { index: 0, inputType: REGISTER, outputType: predecessor.witness },
        { index: 1, inputType: opts.secret, outputType: x.witness }, // reveal secret + records
      ],
      opts.onSent,
      opts.parentSigner,
      parentDeed,
    )
  }

  /**
   * Convenience: `commit()` → wait `COMMIT_MIN_DELAY` → `register()`, retrying the
   * reveal while consensus still considers the commit immature. For Node/scripts;
   * a UI should call `commit()` and `register()` separately so the user isn't
   * blocked. Returns both tx hashes.
   */
  async registerWithCommit(
    signer: ccc.Signer,
    label: string,
    opts: RegisterOptions & {
      /**
       * Called the moment the reservation is broadcast, minutes before this resolves.
       *
       * Without it a caller has nothing to show for the longest part of a registration:
       * the reservation lands in seconds, the chain then makes everyone wait a minute
       * before the claim, and the retries can carry that to several. A shop waiting on
       * this used to hold an order with no transaction on it at all for three minutes,
       * which reads from the outside as nothing happening.
       */
      onCommit?: (txHash: Hex) => void
    } = {},
  ): Promise<{ commitTx: Hex; registerTx: Hex }> {
    const c = await this.commit(signer, label, {})
    opts.onCommit?.(c.txHash)
    await sleep((COMMIT_MIN_DELAY + 5) * 1000)
    for (let attempt = 0; ; attempt++) {
      try {
        const registerTx = await this.register(signer, label, { ...opts, secret: c.secret, commit: c.outPoint })
        return { commitTx: c.txHash, registerTx }
      } catch (e) {
        // The commit may still be a few seconds short of maturity (median-time based).
        const msg = String((e as Error).message ?? e)
        // Median time lags real time by minutes, so the reveal can be refused as
        // immature well past the nominal minute; the app retries for a quarter of an
        // hour for the same reason. Twelve tries was a budget the chain routinely beat.
        if (attempt < 60 && /since|immature|0x6f|Immature/i.test(msg)) {
          await sleep(10_000)
          continue
        }
        /**
         * Somebody else registered in the same breath.
         *
         * A registration spends the cell **before** the new one in the list, so two
         * people whose ids fall between the same pair spend the same predecessor and the
         * second transaction is refused: `Resolve(Dead(OutPoint(…)))`, or `Unknown` once
         * the indexer has caught up. With few names the list is coarse and most pairs
         * share a predecessor, so this is the ordinary case on a busy day, not a rarity.
         *
         * It is also entirely recoverable, because `register` reads the predecessor
         * fresh every time: asking again finds the new one. What must not be retried is
         * the case where the name itself is gone, so the decision is made by reading the
         * chain rather than by matching the error's words, which differ by node version.
         */
        if (attempt < 20 && lostToAnotherTransaction(msg)) {
          const { available } = await this.availability(label)
          if (!available) throw new Error(`cells: ${label}.cell was registered by somebody else while this was being claimed`)
          await sleep(3_000)
          continue
        }
        // The reservation is already on the chain and its 100 CKB is now sitting in a
        // cell nobody will spend. This used to `throw e` and say nothing about it, so a
        // caller lost the coins twice over: once, and then again by not knowing. Three
        // of these were found stranded in the mainnet treasury and twenty-six on testnet,
        // all from registrations that failed after their commit landed.
        //
        // The error is the original one, with the reservation attached: `secret` and
        // `outPoint` are what `register()` needs, so a caller can retry the claim rather
        // than start over, and `reclaimCommits` takes the coins back when it will not.
        Object.assign(e as object, {
          commitTx: c.txHash,
          commitOutPoint: c.outPoint,
          secret: c.secret,
          reclaimable: `${COMMIT_CELL_CKB} CKB is held by the reservation ${c.txHash}; retry register() with this error's secret and outPoint, or call reclaimCommits() to take it back`,
        })
        throw e
      }
    }
  }

  /**
   * Take back the CKB held by reservations that were never claimed.
   *
   * A registration is two transactions: a reservation that hides the name, then the claim
   * that spends it. When the claim never happens, and it does not whenever the second
   * transaction fails, the reservation's 100 CKB stays in a cell under your own lock that
   * nothing will ever spend on its own. No wallet counts it as balance, because it carries
   * data, so the coins are not lost so much as invisible.
   *
   * This is deliberately narrow: it takes only cells with **no type script, exactly 32
   * bytes of data, and exactly the reservation's capacity**. A sweep that ate something
   * else would be far worse than one that missed, so anything that does not match that
   * shape on all three counts is left alone.
   *
   * Returns null when there is nothing to take.
   */
  async reclaimCommits(signer: ccc.Signer): Promise<{ txHash: Hex; cells: number; ckb: number } | null> {
    const lock = (await signer.getRecommendedAddressObj()).script
    const want = ccc.fixedPointFrom(COMMIT_CELL_CKB)
    const found: { previousOutput: ccc.OutPointLike }[] = []
    let total = 0n
    for await (const c of this.client.findCellsByLock(lock, undefined, true)) {
      const data = c.outputData ?? '0x'
      if (c.cellOutput.type) continue
      if (data.length !== 66) continue // 0x + 32 bytes
      if (c.cellOutput.capacity !== want) continue
      found.push({ previousOutput: c.outPoint })
      total += c.cellOutput.capacity
    }
    if (!found.length) return null
    const tx = ccc.Transaction.from({ inputs: found, outputs: [{ lock, capacity: total }] })
    await tx.completeFeeBy(signer, 2000)
    const txHash = (await signer.sendTransaction(tx)) as Hex
    return { txHash, cells: found.length, ckb: Number(total) / 1e8 }
  }

  private async getLive(name: string): Promise<LiveAccount> {
    const a = await this.getAccount(name)
    if (!a) throw new Error(`cells: ${name.replace(/\.cell$/, '')}.cell is not registered`)
    return a
  }

  private out(capacity: bigint): { lock: ccc.Script; type: ccc.Script; capacity: bigint } {
    return { lock: this.accountLock(), type: this.accountType(), capacity }
  }

  /**
   * Edit a name's resolution records. Authorized by **either** the owner or the
   * delegated manager (a v2 name), `signer` must be one of them. Preserves the
   * cell's layout version and manager.
   */
  async editRecords(signer: ccc.Signer, name: string, records: RecordEntry[], opts: { basedOn?: Hex } = {}): Promise<Hex> {
    const a = await this.getLive(name)
    // `basedOn`: the witness hash of the records this edit was made from. If they changed
    // on chain since, saving would undo that change without anyone seeing it.
    if (opts.basedOn !== undefined && a.witnessHash !== opts.basedOn)
      throw new Error(`cells: the records of ${a.label}.cell changed on chain after they were read, so this edit is not saved. Read them again.`)
    const { deed } = await this.authority(signer, a, 'edit', 'cells: signer is neither the owner nor the manager of this name')
    const x = buildAccount({ records }, a.next, a.expiredAt, a.ownerLockHash, a.managerLockHash, a.label)
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: a.outPoint }],
      outputs: [this.out(a.capacity)],
      outputsData: [x.data],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep)],
    })
    return this.finalize(tx, signer, [{ index: 0, inputType: EDIT_RECORDS, outputType: x.witness }], undefined, undefined, deed && { link: deed })
  }

  /**
   * Who may act on a name, and how the transaction proves it (decision 0036). The owner
   * and, for an edit, the manager, prove it by spending any cell of theirs, which the
   * fee already does. A wallet that is neither may still hold the name's **deed**: a
   * Spore whose proxy lock is the name's owner. Then the deed is spent and recreated in
   * the same transaction, which is what opens the proxy lock's cell, which is the input
   * under the owner lock the type script asks for. The caller passes what it gets back
   * to `finalize`, which adds that leg.
   */
  private async authority(signer: ccc.Signer, a: LiveAccount, level: 'owner' | 'edit', refusal: string): Promise<{ deed?: DeedLink }> {
    const addrs = await signer.getAddressObjs()
    const ids = addrs.map((x) => ownerId(x.script.hash() as Hex))
    if (ids.includes(a.ownerLockHash)) return {}
    if (level === 'edit' && ids.includes(a.managerLockHash)) return {}
    for (const x of addrs) {
      const held = await deedsHeldBy(this.client, x.script)
      const d = held.get(a.ownerLockHash)
      if (!d) continue
      const p = await findDeedProxyCell(this.client, d.sporeTypeHash, { sporeId: d.sporeId, accountId: a.id })
      if (!p) throw new Error('cells: the deed\'s proxy cell is missing, so the name cannot be acted on through it')
      return {
        deed: {
          sporeId: d.sporeId,
          sporeTypeHash: d.sporeTypeHash,
          ownerId: a.ownerLockHash,
          proxy: { outPoint: { txHash: p.outPoint.txHash as Hex, index: Number(p.outPoint.index) }, capacity: p.cellOutput.capacity, lock: p.cellOutput.lock, data: p.outputData as Hex },
        },
      }
    }
    throw new Error(refusal)
  }

  /** The deed behind a name, and who holds it, or `null` when the name is owned by a key. */
  async deedOf(name: string): Promise<Deed | null> {
    const a = await this.getAccount(name)
    return a ? deedOfAccount(this.client, a) : null
  }

  /**
   * Turn a name into a deed (decision 0036): mint the Spore that stands for it, into
   * the deeds cluster, to the owner's own wallet, and in the same transaction hand the
   * name to the proxy lock over that Spore and create the proxy lock's cell. Either all
   * of it happens or none of it.
   *
   * The cluster belongs to a key of the operator's, so the transaction needs that key's
   * signature next to the owner's: `cosign` takes the built transaction to whoever holds
   * it (the gateway's `POST /deed/cosign`) and returns it signed. That key can sign the
   * cluster cell and nothing else, and it refuses anything that is not exactly this,
   * see `checkDeedTx`. The owner signs last; the co-signature is checked to have left
   * the transaction as it was.
   */
  async makeDeed(
    signer: ccc.Signer,
    name: string,
    cosign: (tx: ccc.Transaction) => Promise<ccc.TransactionLike>,
    onStep?: (step: 'build' | 'cosign' | 'sign' | 'sent', txHash?: Hex) => void,
    opts: { lease?: () => Promise<ccc.OutPointLike | null> } = {},
  ): Promise<{ txHash: Hex; sporeId: Hex }> {
    const a = await this.getLive(name)
    const clusterId = this.dep.deedCluster
    if (!clusterId) throw new Error('cells: this deployment has no deeds cluster yet')
    const me = (await signer.getRecommendedAddressObj()).script
    if (ownerId(me.hash() as Hex) !== a.ownerLockHash) throw new Error('cells: only the owner may make the deed of a name')
    // The Spore is minted to this wallet, and whoever can spend it holds the name.
    await this.refuseOpenLock(me, "this wallet's address", 'holder')
    if (a.expiredAt * 1000 < Date.now()) throw new Error(`cells: ${a.label}.cell has lapsed; renew it before making its deed`)
    onStep?.('build')
    let tx = ccc.Transaction.from({
      inputs: [{ previousOutput: a.outPoint }],
      outputs: [this.out(a.capacity)],
      outputsData: [a.data],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep)],
    })
    // One of the owner's own cells first, so the owner's witness sits before the
    // cluster's and the Spore id derives from the name cell at input 0.
    await tx.completeInputsAddOne(signer)
    const cluster = await assertCluster(this.client, clusterId)
    const clusterMode = await this.addDeedClusterLeg(tx, cluster.cell.cellOutput.lock, opts.lease)
    const minted = await createSpore({
      signer,
      data: { contentType: 'dob/1', content: deedContent(a), clusterId },
      to: me,
      clusterMode,
      tx,
    })
    tx = minted.tx
    const sporeId = minted.id as Hex
    const lock = await deedLock(this.client, sporeTypeOf(this.client, sporeId).hash() as Hex)
    tx.outputsData[0] = buildAccountData(a.witnessHash, a.next, a.expiredAt, lock.hash() as Hex, lock.hash() as Hex, a.label) as `0x${string}`
    tx.addOutput({ lock }, encodeDeedProxyData(sporeId, a.id))
    // The cluster's key signs later: its cell dep and a witness placeholder go in now,
    // so the fee is sized once and nothing about the transaction moves after.
    await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.Secp256k1Blake160)
    const ci = await tx.findInputIndexByLock(cluster.cell.cellOutput.lock, this.client)
    if (ci === undefined) throw new Error('cells: the cluster cell did not make it into the transaction')
    while (tx.witnesses.length <= ci) tx.witnesses.push('0x')
    tx.witnesses[ci] = ccc.hexFrom(ccc.WitnessArgs.from({ lock: `0x${'00'.repeat(65)}` }).toBytes())
    const inject = () => {
      let cur: ccc.WitnessArgs
      try {
        cur = ccc.WitnessArgs.fromBytes(tx.witnesses[0] ?? '0x')
      } catch {
        cur = ccc.WitnessArgs.from({})
      }
      tx.witnesses[0] = ccc.hexFrom(ccc.WitnessArgs.from({ lock: cur.lock, inputType: TRANSFER, outputType: a.witness }).toBytes())
    }
    inject()
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, FEE_RATE)
    inject()
    onStep?.('cosign')
    const cosigned = ccc.Transaction.from(await cosign(tx))
    if (cosigned.hash() !== tx.hash()) throw new Error('cells: the co-signer changed the transaction, refusing to sign it')
    onStep?.('sign')
    const signed = await signer.signTransaction(cosigned)
    const h = (await this.client.sendTransaction(signed)) as Hex
    onStep?.('sent', h)
    await this.client.waitTransaction(h, 0, 300_000)
    this.invalidate()
    return { txHash: h, sporeId }
  }

  /**
   * The cluster key's side of `makeDeed`: check that the transaction is exactly a deed
   * being made for `name`, then sign the cluster cell's input and nothing else. Run by
   * whoever holds that key (the gateway); returns the transaction for the owner to sign.
   */
  async cosignDeed(deedsSigner: ccc.Signer, name: string, txLike: ccc.TransactionLike): Promise<{ tx: ccc.Transaction; sporeId: Hex }> {
    const clusterId = this.dep.deedCluster
    if (!clusterId) throw new Error('cells: this deployment has no deeds cluster')
    const a = await this.getLive(name)
    const cluster = await assertCluster(this.client, clusterId)
    const clusterLock = cluster.cell.cellOutput.lock
    const mine = (await deedsSigner.getRecommendedAddressObj()).script
    if (!mine.eq(clusterLock)) throw new Error('cells: this key does not hold the deeds cluster')
    const check = await checkDeedTx(this.client, a, txLike, { clusterId, clusterLock, accountType: this.accountType(), accountLock: this.accountLock() })
    if (!check.ok) throw new Error(`cells: not a deed for ${a.label}.cell: ${check.problems.join('; ')}`)
    const tx = ccc.Transaction.from(txLike)
    const before = tx.hash()
    // The builder already put the cell dep and the witness placeholder in place; if
    // preparing changes anything, the fee was sized on a different transaction.
    const prepared = await deedsSigner.prepareTransaction(tx)
    if (prepared.hash() !== before) throw new Error('cells: the transaction was not prepared for the cluster key')
    return { tx: await deedsSigner.signOnlyTransaction(prepared), sporeId: check.sporeId! }
  }

  /**
   * Put a deed on a new card. The card keeps the date it was minted with, so after a
   * renewal it shows less than the name has, and a deed minted into an older cluster
   * keeps the older design. One transaction melts the old Spore, mints a new one into
   * the current cluster with the name as it is today, and moves the name and the deposit
   * from the old proxy lock to the new one. The cluster's key co-signs it exactly as it
   * co-signs `makeDeed`: one Spore out, the name handed to the proxy over it.
   *
   * The Spore gets a new id, and the contract resets the manager on any transfer, so
   * the holder is the manager again only after `claimDeed`.
   */
  async refreshDeed(
    signer: ccc.Signer,
    name: string,
    cosign: (tx: ccc.Transaction) => Promise<ccc.TransactionLike>,
    onStep?: (step: 'build' | 'cosign' | 'sign' | 'sent', txHash?: Hex) => void,
    opts: { lease?: () => Promise<ccc.OutPointLike | null> } = {},
  ): Promise<{ txHash: Hex; sporeId: Hex }> {
    const a = await this.getLive(name)
    const clusterId = this.dep.deedCluster
    if (!clusterId) throw new Error('cells: this deployment has no deeds cluster yet')
    if (a.expiredAt * 1000 < Date.now()) throw new Error(`cells: ${a.label}.cell has lapsed; renew it before updating its card`)
    const { deed } = await this.authority(signer, a, 'owner', 'cells: this wallet does not hold the deed of this name')
    if (!deed?.sporeId) throw new Error('cells: this name is owned by a key, not held as a deed')
    const old = await findSpore(this.client, deed.sporeId).catch(() => undefined)
    if (!old) throw new Error('cells: the deed of this name is not live')
    const card = deedCard(old.sporeData.content)
    const oldCluster = old.sporeData.clusterId ? ccc.hexFrom(old.sporeData.clusterId) : null
    if (card && card.label === a.label && card.expiry === deedExpiryText(a.expiredAt) && oldCluster === clusterId)
      throw new Error('cells: the card already shows the name as it is, so there is nothing to update')
    const me = (await signer.getRecommendedAddressObj()).script
    await this.refuseOpenLock(me, "this wallet's address", 'holder')
    onStep?.('build')
    let tx = ccc.Transaction.from({
      inputs: [{ previousOutput: a.outPoint }],
      outputs: [this.out(a.capacity)],
      outputsData: [a.data],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep)],
    })
    // The old proxy cell is the input under the name's current owner that the transfer
    // needs. It and anything else under the old lock go in now, before the Spore leg, as
    // in `finalize`: once the old Spore is melted that lock never opens again.
    tx.inputs.push(ccc.CellInput.from({ previousOutput: deed.proxy.outPoint }))
    const oldLock = await deedLock(this.client, deed.sporeTypeHash)
    // Twenty at most here: the co-signer takes no transaction of more than 32 inputs, so
    // any more are taken back first, a page per transaction.
    await this.sweepDeedDown(signer, deed.sporeId, deed.sporeTypeHash, 20, deed.proxy.outPoint)
    for (const stray of await sweepable(this.client, oldLock, 20, deed.proxy.outPoint))
      tx.inputs.push(ccc.CellInput.from({ previousOutput: stray.outPoint }))
    // The old plate answers to the old lock: it comes back now too (decision 0042), and the
    // new card's being gets a plate of its own when its holder sets one.
    await this.takePlates(tx, deed.sporeTypeHash, 4)
    await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.InputTypeProxyLock)
    tx = (await meltSpore({ signer, id: deed.sporeId, tx })).tx
    const cluster = await assertCluster(this.client, clusterId)
    const clusterMode = await this.addDeedClusterLeg(tx, cluster.cell.cellOutput.lock, opts.lease)
    const minted = await createSpore({
      signer,
      data: { contentType: 'dob/1', content: deedContent(a), clusterId },
      to: me,
      clusterMode,
      tx,
    })
    tx = minted.tx
    const sporeId = minted.id as Hex
    const lock = await deedLock(this.client, sporeTypeOf(this.client, sporeId).hash() as Hex)
    tx.outputsData[0] = buildAccountData(a.witnessHash, a.next, a.expiredAt, lock.hash() as Hex, lock.hash() as Hex, a.label) as `0x${string}`
    tx.addOutput({ lock }, encodeDeedProxyData(sporeId, a.id))
    // The cluster's key signs later: its cell dep and witness placeholder go in now, as
    // in `makeDeed`, so the fee is sized once.
    await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.Secp256k1Blake160)
    const ci = await tx.findInputIndexByLock(cluster.cell.cellOutput.lock, this.client)
    if (ci === undefined) throw new Error('cells: the cluster cell did not make it into the transaction')
    while (tx.witnesses.length <= ci) tx.witnesses.push('0x')
    tx.witnesses[ci] = ccc.hexFrom(ccc.WitnessArgs.from({ lock: `0x${'00'.repeat(65)}` }).toBytes())
    const inject = () => {
      let cur: ccc.WitnessArgs
      try {
        cur = ccc.WitnessArgs.fromBytes(tx.witnesses[0] ?? '0x')
      } catch {
        cur = ccc.WitnessArgs.from({})
      }
      tx.witnesses[0] = ccc.hexFrom(ccc.WitnessArgs.from({ lock: cur.lock, inputType: TRANSFER, outputType: a.witness }).toBytes())
    }
    inject()
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, FEE_RATE)
    inject()
    onStep?.('cosign')
    const cosigned = ccc.Transaction.from(await cosign(tx))
    if (cosigned.hash() !== tx.hash()) throw new Error('cells: the co-signer changed the transaction, refusing to sign it')
    onStep?.('sign')
    const signed = await signer.signTransaction(cosigned)
    const h = (await this.client.sendTransaction(signed)) as Hex
    onStep?.('sent', h)
    await this.client.waitTransaction(h, 0, 300_000)
    this.invalidate()
    return { txHash: h, sporeId }
  }

  /**
   * Undo a deed: the holder takes the name back into their own key, melting the Spore
   * and reclaiming the proxy cell in the same transaction. The contract resets the
   * manager to the new owner, as on any transfer.
   */
  async takeBack(signer: ccc.Signer, name: string, onSent?: (txHash: Hex) => void): Promise<Hex> {
    const a = await this.getLive(name)
    const myLock = (await signer.getRecommendedAddressObj()).script
    await this.refuseOpenLock(myLock, "this wallet's address", 'owner')
    const { deed } = await this.authority(signer, a, 'owner', 'cells: this wallet does not hold the deed of this name')
    if (!deed) throw new Error('cells: this name is owned by a key, not held as a deed')
    const me = myLock.hash() as Hex
    const data = buildAccountData(a.witnessHash, a.next, a.expiredAt, me, me, a.label)
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: a.outPoint }],
      outputs: [this.out(a.capacity)],
      outputsData: [data],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep)],
    })
    return this.finalize(tx, signer, [{ index: 0, inputType: TRANSFER, outputType: a.witness }], onSent, undefined, { link: deed, melt: true })
  }

  /**
   * The being's belly: the cells meals have left under the deed's lock (deed.ts `bellyOf`).
   * Null for a name owned by a key, which has no being to feed.
   */
  async belly(name: string): Promise<Belly | null> {
    const a = await this.getAccount(name)
    if (!a) return null
    const link = await deedLinkOf(this.client, a)
    return link ? bellyOf(this.client, link.sporeTypeHash) : null
  }

  /**
   * Empty the belly into the holder's own wallet: one transaction that spends every meal
   * cell read (at most two hundred at a time), with the Spore in the inputs to open the
   * lock, and gives the sum to the holder. The proxy cell and the Spore come back as they
   * were. Only the holder can do it, because only the holder can spend the Spore.
   */
  async emptyBelly(signer: ccc.Signer, name: string, onSent?: (txHash: Hex) => void): Promise<Hex> {
    const a = await this.getLive(name)
    const { deed } = await this.authority(signer, a, 'owner', 'cells: this wallet does not hold the deed of this name')
    if (!deed) throw new Error('cells: this name is owned by a key, not held as a deed, so it has no belly')
    const belly = await bellyOf(this.client, deed.sporeTypeHash)
    if (belly.total === 0n) throw new Error('cells: the belly is empty')
    // What it holds goes to the holder as change. The plate, when there is one, is taken
    // whole and set again at its minimum, so the next meal still has somewhere to land.
    const lock = await plateLock(this.client, deed.sporeTypeHash)
    const plates = await this.newestPlates(
      lock,
      belly.plates.map((p) => ({ outPoint: p.outPoint, cellOutput: { lock, capacity: p.capacity } })),
    )
    const tx = ccc.Transaction.from({
      inputs: [
        ...belly.cells.map((c) => ({ previousOutput: c.outPoint })),
        ...plates.map((p) => ({ previousOutput: p.outPoint, cellOutput: p.cellOutput, outputData: '0x' })),
      ],
    })
    if (plates.length) {
      tx.addOutput({ lock, capacity: belly.plateMin }, '0x')
      this.signPlateInput(tx, belly.cells.length)
      await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.OmniLock)
    }
    return this.finalize(tx, signer, [], onSent, undefined, { link: deed })
  }

  /**
   * Set a being's plate (decision 0042): one cell under the deed's plate lock, of its own
   * size (65 CKB), so meals from 1 CKB have somewhere to land. The CKB in it stays the
   * holder's: emptying the belly leaves it, and ending the deed gives it back.
   */
  async setPlate(signer: ccc.Signer, name: string, onSent?: (txHash: Hex) => void): Promise<Hex> {
    const a = await this.getLive(name)
    const link = await deedLinkOf(this.client, a)
    if (!link) throw new Error('cells: this name is owned by a key, not held as a deed, so it has no being to set a plate for')
    const lock = await plateLock(this.client, link.sporeTypeHash)
    for await (const c of this.client.findCellsByLock(lock, undefined, false))
      if (!c.cellOutput.type) throw new Error('cells: this being already has a plate')
    const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: plateMinimum(lock) }], outputsData: ['0x'] })
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, FEE_RATE)
    const h = (await this.client.sendTransaction(await signer.signTransaction(tx))) as Hex
    onSent?.(h)
    await this.client.waitTransaction(h, 0, 300_000)
    return h
  }

  /**
   * Feed a being on its plate (decision 0042): the plate is spent and set again with the
   * meal added, from 1 CKB, with the meal witness naming the name and carrying the note. The
   * payer signs only their own cells; the plate needs nothing signed.
   *
   * One plate is one cell, and the pool takes one spend of it. A meal is built on the newest
   * plate, meals still in the pool included, so meals in a row chain rather than collide. Two
   * built on the same plate at the same moment still collide: the node refuses the second,
   * which then finds the first in the pool, waits a moment chosen at random (so a crowd does
   * not collide again all together) and builds on top of it, and the wallet asks once more
   * (`busy` says so). It never raises the fee to get ahead: a higher fee would replace the
   * other meal in the pool instead of following it (measured on Pudge, docs/drafts/belly-lock.md).
   */
  async feed(
    signer: ccc.Signer,
    name: string,
    shannons: bigint,
    note: string,
    on: { sent?: (txHash: Hex) => void; busy?: () => void } = {},
  ): Promise<Hex> {
    if (shannons < 10n ** BigInt(PLATE_MIN_EXP)) throw new Error('cells: the smallest meal on a plate is 1 CKB')
    let lock: ccc.Script | null = null
    let refusedOn: string | null = null
    for (let attempt = 0; ; attempt++) {
      // Asked again on every attempt: a deed whose Spore is gone leaves a plate nobody can ever
      // empty, and one replaced by a new card answers to another lock (review of 2026-10-02).
      const a = await this.getLive(name)
      const link = await deedLinkOf(this.client, a)
      if (!link) throw new Error('cells: this name is owned by a key, not held as a deed, so it has no being to feed')
      if (!link.sporeId || !(await findSpore(this.client, link.sporeId).catch(() => undefined)))
        throw new Error("cells: this being's deed is gone, so nothing could ever take a meal off its plate; nothing was sent")
      const now = await plateLock(this.client, link.sporeTypeHash)
      if (lock && now.hash() !== lock.hash()) throw new Error("cells: this being's deed changed while you were feeding it; nothing more was sent")
      lock = now
      const plate = await this.plateNow(lock, refusedOn !== null)
      if (!plate) throw new Error('cells: this being has no plate yet')
      // Refused on this very plate and the pool does not show who took it yet: give the
      // node a moment to show it, rather than colliding with the same meal again.
      if (refusedOn === `${plate.outPoint.txHash}:${Number(plate.outPoint.index)}`) await sleep(3_000)
      const tx = ccc.Transaction.from({
        inputs: [{ previousOutput: plate.outPoint, cellOutput: plate.cellOutput, outputData: '0x' }],
        outputs: [{ lock, capacity: plate.cellOutput.capacity + shannons }],
        outputsData: ['0x'],
        witnesses: ['0x'],
      })
      await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.OmniLock)
      await tx.completeInputsByCapacity(signer)
      addMeal(tx, { to: `${a.label}.cell`, note })
      await tx.completeFeeBy(signer, FEE_RATE)
      const signed = await signer.signTransaction(tx)
      let h: Hex
      try {
        h = (await this.client.sendTransaction(signed)) as Hex
      } catch (e) {
        // This very meal may be in already: a reply lost on the way and the request sent
        // again to another node, which then answers "duplicated". That is not a collision.
        const mine = await this.client.getTransaction(signed.hash()).catch(() => undefined)
        if (mine && (mine.status === 'pending' || mine.status === 'proposed' || mine.status === 'committed')) h = signed.hash() as Hex
        else {
          // Another meal spent this plate first: in the pool (RBF), or already on chain.
          if (attempt >= 5 || !/RBF|Dead|Unknown|Resolve|Duplicated/i.test(String(e))) throw e
          on.busy?.()
          refusedOn = `${plate.outPoint.txHash}:${Number(plate.outPoint.index)}`
          await sleep(500 + Math.floor(Math.random() * 2_500))
          continue
        }
      }
      this.lastPlate.set(lock.hash(), { txHash: h, index: 0 })
      on.sent?.(h)
      await this.landed(h, 'meal')
      return h
    }
  }

  /**
   * Wait for a transaction to land, and say so at once when the pool drops it instead: a meal
   * that another spend replaced would otherwise look slow for five minutes, and invite a
   * second payment while nothing was taken (review of 2026-10-02).
   */
  private async landed(h: Hex, what: string): Promise<void> {
    const deadline = Date.now() + 300_000
    for (;;) {
      const r = await this.client.getTransaction(h).catch(() => undefined)
      if (r?.status === 'committed') return
      if (r?.status === 'rejected')
        throw new Error(`cells: the ${what} was dropped before it landed${r.reason ? ` (${String(r.reason).slice(0, 80)})` : ''}; nothing was taken from your wallet`)
      if (Date.now() > deadline)
        throw new Error(`cells: the ${what} has not landed in five minutes; it still may, so look at the transaction before paying again`)
      await sleep(3_000)
    }
  }

  /**
   * The plate to build a meal on. On chain: the one this client fed last when it is still
   * live (the indexer trails by a few seconds), else the first live cell under the plate
   * lock; a cell the indexer still lists but the chain has spent is skipped. Then on through
   * the pool, to the newest plate a pending meal sets (`followPlate`).
   */
  private async plateNow(lock: ccc.Script, expect = false): Promise<{ outPoint: ccc.OutPoint; cellOutput: ccc.CellOutput } | null> {
    // A plate that was there a moment ago and is not now has just been set again by a meal
    // that landed: the indexer lists it some seconds after the block (more than fifteen on
    // Pudge's public node, measured). Asked to `expect` one, this waits up to 36 seconds.
    for (let round = 0; ; round++) {
      const p = await this.plateOnce(lock)
      if (p || !expect || round >= 11) return p
      await sleep(3_000)
    }
  }

  private async plateOnce(lock: ccc.Script): Promise<{ outPoint: ccc.OutPoint; cellOutput: ccc.CellOutput } | null> {
    let start: { outPoint: ccc.OutPoint; cellOutput: ccc.CellOutput } | null = null
    const mine = this.lastPlate.get(lock.hash())
    if (mine) {
      const c = await this.client.getCellLive(mine, false)
      if (c) start = { outPoint: c.outPoint, cellOutput: c.cellOutput }
    }
    if (!start)
      for await (const c of this.client.findCellsByLock(lock, undefined, true)) {
        if (c.cellOutput.type || c.outputData !== '0x') continue
        if (await this.client.getCellLive(c.outPoint, false)) {
          start = { outPoint: c.outPoint, cellOutput: c.cellOutput }
          break
        }
      }
    // A plate in the pool only: the meal that set it is pending and the chain shows the
    // plate it spent as live until that meal lands, so the pool is read in either case.
    const pending = await this.pendingPlates(lock)
    // The indexer may not list a plate yet that a pending meal already spends: start from
    // any plate the pool sets, and follow it to the newest.
    if (!start) start = pending.values().next().value ?? null
    if (!start) return null
    return followPlate(start, pending)
  }

  /**
   * What the pool says about a plate: for each pending transaction that spends a cell under
   * `lock` and sets one again, the outpoint it spends and the plate it sets. Read from the
   * node's own pool (`get_raw_tx_pool`); a node that will not answer leaves the chain's view.
   */
  private async pendingPlates(lock: ccc.Script): Promise<Map<string, { outPoint: ccc.OutPoint; cellOutput: ccc.CellOutput }>> {
    const out = new Map<string, { outPoint: ccc.OutPoint; cellOutput: ccc.CellOutput }>()
    const requestor = (this.client as unknown as { requestor?: { request(m: string, p: unknown[]): Promise<unknown> } }).requestor
    if (!requestor) return out
    let pool: { pending?: string[]; proposed?: string[] }
    try {
      pool = (await requestor.request('get_raw_tx_pool', [false])) as { pending?: string[]; proposed?: string[] }
    } catch {
      return out
    }
    const hashes = [...(pool.pending ?? []), ...(pool.proposed ?? [])].slice(0, 200)
    const want = lock.hash()
    await Promise.all(
      hashes.map(async (h) => {
        const r = await this.client.getTransaction(h).catch(() => undefined)
        const tx = r?.transaction
        if (!tx) return
        // A plate output carries no type and no data; a decoy that does is not followed.
        const i = tx.outputs.findIndex((o, k) => o.lock.hash() === want && !o.type && (tx.outputsData[k] ?? '0x') === '0x')
        if (i < 0) return
        const plate = { outPoint: ccc.OutPoint.from({ txHash: h, index: i }), cellOutput: tx.outputs[i] }
        for (const inp of tx.inputs) out.set(`${inp.previousOutput.txHash}:${Number(inp.previousOutput.index)}`, plate)
      }),
    )
    return out
  }

  /**
   * The plates a holder's transaction should spend: each committed plate followed through the
   * pool to the newest one a pending meal sets, so taking does not collide with meals on their
   * way, nor replace them (review of 2026-10-02).
   */
  private async newestPlates(
    lock: ccc.Script,
    cells: { outPoint: ccc.OutPointLike; cellOutput: ccc.CellOutputLike }[],
  ): Promise<{ outPoint: ccc.OutPoint; cellOutput: ccc.CellOutput }[]> {
    const pending = await this.pendingPlates(lock)
    return cells.map((c) => followPlate({ outPoint: ccc.OutPoint.from(c.outPoint), cellOutput: ccc.CellOutput.from(c.cellOutput) }, pending))
  }

  /** The witness that takes from a plate, on the first plate input of `tx` (deed.ts). */
  private signPlateInput(tx: ccc.Transaction, at: number): void {
    while (tx.witnesses.length <= at) tx.witnesses.push('0x')
    tx.witnesses[at] = PLATE_TAKE_WITNESS
  }

  /**
   * Every cell on a deed's plate, into a transaction that melts its Spore (or replaces it,
   * on a new card). Like the cells under the deed's lock, this is the last chance anyone has
   * to take them: the plate's owner is the deed's lock, which never opens again once the
   * Spore is gone. The transaction must also spend a cell under the deed's lock (the proxy
   * cell does), or the plate refuses. A typed cell stays where it is, as in `sweepable`.
   */
  private async takePlates(tx: ccc.Transaction, sporeTypeHash: Hex, room = PLATE_PAGE): Promise<void> {
    const lock = await plateLock(this.client, sporeTypeHash)
    const found: ccc.Cell[] = []
    for await (const c of this.client.findCellsByLock(lock, undefined, false)) {
      if (c.cellOutput.type) continue
      if (found.length === room)
        throw new Error(`cells: more than ${room} cells sit on this being's plate, more than one transaction can take; empty its belly into your wallet first, then try again`)
      found.push(c)
    }
    if (!found.length) return
    const at = tx.inputs.length
    for (const p of await this.newestPlates(lock, found))
      tx.inputs.push(ccc.CellInput.from({ previousOutput: p.outPoint, cellOutput: p.cellOutput, outputData: '0x' }))
    this.signPlateInput(tx, at)
    await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.OmniLock)
  }

  /**
   * A new holder makes the name theirs in the ways a Spore sale does not: the manager
   * becomes their key (the seller's delegate loses edit rights). The payout addresses
   * still say what the seller published; that is an `editRecords`, which the holder may
   * do next through the same deed.
   */
  async claimDeed(signer: ccc.Signer, name: string): Promise<Hex> {
    const me = await signer.getRecommendedAddressObj()
    await this.refuseOpenLock(me.script, "this wallet's address", 'manager')
    return this.setManager(signer, name, me.toString())
  }

  /**
   * Every deed of this deployment a wallet holds, live or not. One that is not live
   * holds nothing: its name was recycled, or is owned by something else now. Those are
   * ended with `endDeed`, which gives `reclaim` back.
   */
  async heldDeeds(lock: ccc.ScriptLike): Promise<HeldDeed[]> {
    const clusters = this.deedClusterIds()
    if (!clusters.length) return []
    const info = getSporeScriptInfo(this.client)
    const spores: ccc.Cell[] = []
    for await (const c of this.client.findCells(
      // the filter script matches by prefix, so an empty args means "any Spore"
      { script: lock, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: { codeHash: info.codeHash, hashType: info.hashType, args: '0x' } }, withData: true },
      'asc',
      50,
    ))
      spores.push(c)
    if (!spores.length) return []
    const accounts: LiveAccountLite[] = []
    for await (const a of this.liveCellsLite()) accounts.push(a)
    const out: HeldDeed[] = []
    for (const c of spores) {
      const d = await this.readDeed(c, clusters, accounts)
      if (d) out.push(d)
    }
    return out
  }

  /**
   * End a deed that no longer holds a name: melt the Spore and bring every plain cell
   * under its proxy lock back to the holder, in one transaction. A deed that still holds
   * its name is refused, because melting it alone would freeze the name until it lapses;
   * that one is ended with `takeBack`, which hands the name to the holder's key first.
   */
  async endDeed(signer: ccc.Signer, sporeId: Hex, onSent?: (txHash: Hex) => void): Promise<Hex> {
    const found = await findSpore(this.client, sporeId).catch(() => undefined)
    if (!found) throw new Error('cells: that Spore is not live')
    const accounts: LiveAccountLite[] = []
    for await (const a of this.liveCellsLite()) accounts.push(a)
    const d = await this.readDeed(found.cell, this.deedClusterIds(), accounts)
    if (!d) throw new Error('cells: that Spore is not a deed of this deployment')
    if (d.standing === 'live')
      throw new Error(
        `cells: this deed still holds ${d.label ? `${d.label}.cell` : 'its name'}; take the name back instead, or melting it would freeze the name until it lapses`,
      )
    const addrs = await signer.getAddressObjs()
    if (!addrs.some((x) => x.script.eq(found.cell.cellOutput.lock))) throw new Error('cells: that deed is not in this wallet')
    // The cells under the proxy lock go in first, as in `finalize`, so the cobuild
    // witness the Spore package adds lands after every input.
    let tx = ccc.Transaction.from({})
    const lock = await deedLock(this.client, found.cell.cellOutput.type!.hash() as Hex)
    await this.sweepDeedDown(signer, sporeId, found.cell.cellOutput.type!.hash() as Hex, DEED_PAGE)
    const swept = await sweepable(this.client, lock, DEED_PAGE)
    for (const x of swept) tx.inputs.push(ccc.CellInput.from({ previousOutput: x.outPoint }))
    if (swept.length) await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.InputTypeProxyLock)
    // No co-signer here, so no 32-input limit: a stranger's cells parked on the plate must not
    // be able to stop a deed from ending (review of 2026-10-02).
    await this.takePlates(tx, found.cell.cellOutput.type!.hash() as Hex, DEED_PAGE)
    tx = (await meltSpore({ signer, id: sporeId, tx })).tx
    await tx.completeFeeBy(signer, FEE_RATE)
    const signed = await signer.signTransaction(tx)
    const h = (await this.client.sendTransaction(signed)) as Hex
    onSent?.(h)
    await this.client.waitTransaction(h, 0, 300_000)
    this.invalidate()
    return h
  }

  /**
   * The cluster's side of a deed's transaction (decision 0036). One of the cluster key's
   * plain cells when it has any ('lockProxy'): it is spent and handed back unchanged while
   * the cluster is only read, so deeds made at the same moment each take their own instead
   * of queueing on the one cluster cell. The cluster cell itself otherwise ('clusterCell').
   * `lease` asks the resolver for a free cell; without it, or when its answer is no longer
   * a live plain cell of the key, one is picked at random from what the chain shows.
   *
   * The cell goes in as an input here, before the Spore is minted, so the spore package
   * uses it instead of reaching for the first cell of the key it can find.
   */
  private async addDeedClusterLeg(
    tx: ccc.Transaction,
    clusterLock: ccc.Script,
    lease?: () => Promise<ccc.OutPointLike | null>,
  ): Promise<'lockProxy' | 'clusterCell'> {
    let pick: ccc.Cell | undefined
    const leased = lease ? await lease().catch(() => null) : null
    if (leased) {
      const c = await this.client.getCellLive(leased, true).catch(() => undefined)
      if (c && c.cellOutput.lock.eq(clusterLock) && !c.cellOutput.type) pick = c
    }
    if (!pick) {
      const plain: ccc.Cell[] = []
      for await (const c of this.client.findCellsByLock(clusterLock, undefined, true)) {
        if (!c.cellOutput.type) plain.push(c)
        if (plain.length >= 200) break
      }
      pick = plain[Math.floor(Math.random() * plain.length)]
    }
    if (!pick) return 'clusterCell'
    tx.inputs.push(ccc.CellInput.from({ previousOutput: pick.outPoint }))
    return 'lockProxy'
  }

  private deedClusterIds(): string[] {
    return [this.dep.deedCluster, ...(this.dep.previousDeedClusters ?? [])].filter((x): x is Hex => !!x).map((x) => x.toLowerCase())
  }

  /** A Spore cell read as one of this deployment's deeds, or null when it is not one. */
  private async readDeed(c: ccc.Cell, clusters: string[], accounts: LiveAccountLite[]): Promise<HeldDeed | null> {
    const type = c.cellOutput.type
    if (!type) return null
    let raw: ReturnType<typeof unpackToRawSporeData>
    try {
      raw = unpackToRawSporeData(c.outputData)
    } catch {
      return null
    }
    const clusterId = raw.clusterId ? ccc.hexFrom(raw.clusterId).toLowerCase() : null
    if (!clusterId || !clusters.includes(clusterId)) return null
    const label = deedCard(raw.content)?.label ?? null
    const lock = await deedLock(this.client, type.hash() as Hex)
    let reclaim = c.cellOutput.capacity
    let n = 0
    for await (const x of this.client.findCellsByLock(lock, undefined, true)) {
      if (x.cellOutput.type) continue
      reclaim += x.cellOutput.capacity
      if (++n >= 20) break
    }
    // and what sits on its plate (decision 0042)
    for await (const x of this.client.findCellsByLock(await plateLock(this.client, type.hash() as Hex), undefined, false)) {
      if (x.cellOutput.type) continue
      reclaim += x.cellOutput.capacity
      if (++n >= 40) break
    }
    return { sporeId: type.args as Hex, label, standing: deedStanding(accounts, ownerId(lock.hash() as Hex), label), reclaim }
  }

  /**
   * Publish (or clear, with `null`) the name's Fiber endpoint. Merges with the name's
   * other records, `editRecords` replaces the whole set, so writing these by hand
   * would silently drop the name's addresses.
   */
  async setFiber(
    signer: ccc.Signer,
    name: string,
    ep: FiberEndpoint | null,
    ttl = 300,
  ): Promise<Hex> {
    // The same refusal as `setLightning`, for the same reason: a bare string here reached
    // `fiberRecords` and came back as `undefined is not iterable`, from inside a helper,
    // naming neither the argument nor its shape.
    if (ep !== null && ep !== undefined && typeof ep !== 'object')
      throw new Error(
        `cells: setFiber takes a { nodeId, address } endpoint or null, not ${JSON.stringify(String(ep).slice(0, 40))}.`,
      )
    const a = await this.getAccount(name)
    if (!a) throw new Error(`cells: ${name} is not registered`)
    const kept = a.records.filter((r) => r.key !== FIBER_NODE_KEY && r.key !== FIBER_ADDR_KEY)
    return this.editRecords(signer, name, ep ? [...kept, ...fiberRecords(ep, ttl)] : kept)
  }

  /**
   * Publish (or clear, with `null`) what the name accepts over Lightning: a Lightning
   * Address, a BOLT12 offer, or both. Merges with the name's other records like
   * `setFiber`. An empty field clears that one record and leaves the other.
   */
  async setLightning(
    signer: ccc.Signer,
    name: string,
    ln: { address: string | null; offer: string | null } | null,
    ttl = 300,
  ): Promise<Hex> {
    // `null` clears, an object sets. Anything else is refused, and this is not pedantry:
    // passing the Lightning Address as a bare string, which is the obvious thing to try,
    // used to send a transaction that rewrote every record unchanged and published
    // nothing. It returned a hash, so it looked like it had worked, and it cost a fee to
    // do nothing. Found on 2026-09-21 by calling it that way against testnet.
    if (ln !== null && ln !== undefined && (typeof ln !== 'object' || (!('address' in ln) && !('offer' in ln))))
      throw new Error(
        `cells: setLightning takes { address, offer } or null, not ${JSON.stringify(String(ln).slice(0, 40))}. ` +
          `For a Lightning Address write { address: "you@example.com" }.`,
      )
    const a = await this.getAccount(name)
    if (!a) throw new Error(`cells: ${name} is not registered`)
    const kept = a.records.filter((r) => r.key !== LIGHTNING_ADDRESS_KEY && r.key !== LIGHTNING_OFFER_KEY)
    const add: RecordEntry[] = []
    if (ln?.address) add.push({ key: LIGHTNING_ADDRESS_KEY, label: '', value: textToValue(ln.address.trim()), ttl })
    if (ln?.offer) add.push({ key: LIGHTNING_OFFER_KEY, label: '', value: textToValue(ln.offer.trim()), ttl })
    return this.editRecords(signer, name, [...kept, ...add])
  }

  /**
   * Publish (or clear, with `null`) the name's CKB on-chain address. Merges with the
   * name's other records, like `setFiber`. The address is parsed before it is written,
   * so a typo fails here instead of silently publishing an unpayable name.
   */
  async setCkbAddress(signer: ccc.Signer, name: string, address: string | null, ttl = 300): Promise<Hex> {
    const a = await this.getAccount(name)
    if (!a) throw new Error(`cells: ${name} is not registered`)
    if (address) await ccc.Address.fromString(address, this.client) // throws if malformed
    const kept = a.records.filter((r) => r.key !== CKB_ADDRESS_KEY)
    return this.editRecords(
      signer,
      name,
      address ? [...kept, { key: CKB_ADDRESS_KEY, label: '', value: textToValue(address), ttl }] : kept,
    )
  }

  /**
   * Publish (or clear, with `null`) an address for another chain, under `address.<coinType>`
   * (SLIP-44: 0 = BTC, 60 = ETH, 501 = SOL). Stored as text, the same convention as the
   * CKB address, so any chain's human-readable address round-trips. Merges with the name's
   * other records. Validation is the caller's job, since it is chain-specific.
   */
  async setAddressRecord(
    signer: ccc.Signer,
    name: string,
    coinType: string,
    address: string | null,
    ttl = 300,
  ): Promise<Hex> {
    const key = `address.${coinType}`
    const a = await this.getAccount(name)
    if (!a) throw new Error(`cells: ${name} is not registered`)
    const kept = a.records.filter((r) => r.key !== key)
    return this.editRecords(signer, name, address ? [...kept, { key, label: '', value: textToValue(address.trim()), ttl }] : kept)
  }

  /**
   * Delegate (or change) the **manager**, a lock that may edit records but not transfer
   * or re-delegate. Owner-only; migrates a v1 name to v2 in place.
   *
   * `manager` is an **address**, so the lock behind it can be checked: a manager rewrites
   * the records, which is where payments go, so a lock anyone can spend is refused
   * (`permissiveLock`). A bare hash is taken only when it is the owner's own, which is how
   * a delegation is revoked; any other hash names a lock nobody can check.
   */
  async setManager(signer: ccc.Signer, name: string, manager: string): Promise<Hex> {
    const a = await this.getLive(name)
    const m = manager.trim()
    let managerLockHash: Hex
    if (/^0x[0-9a-fA-F]*$/.test(m)) {
      const theOwner = (() => {
        try {
          return ownerId(m as Hex) === a.ownerLockHash
        } catch {
          return false
        }
      })()
      if (!theOwner)
        throw new Error('cells: give the manager as an address, so its lock can be checked; a bare hash is taken only to hand the name back to its owner')
      managerLockHash = a.ownerLockHash
    } else {
      const lock = (await ccc.Address.fromString(m, this.client)).script
      await this.refuseOpenLock(lock, 'that address', 'manager')
      managerLockHash = lock.hash() as Hex
    }
    const { deed } = await this.authority(signer, a, 'owner', 'cells: only the owner may set the manager')
    // The manager field is always present (decision 0015): delegating changes no
    // byte count and needs no top-up.
    const cap = a.capacity
    const data = buildAccountData(a.witnessHash, a.next, a.expiredAt, a.ownerLockHash, managerLockHash, a.label)
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: a.outPoint }],
      outputs: [this.out(cap)],
      outputsData: [data],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep)],
    })
    return this.finalize(tx, signer, [{ index: 0, inputType: EDIT_MANAGER, outputType: a.witness }], undefined, undefined, deed && { link: deed })
  }

  /**
   * Transfer the name to a new owner. Owner-gated by the *current* owner; the only
   * action that changes `owner_lock_hash`. The manager is reset to the new owner, so
   * no delegation survives a sale.
   *
   * `newOwner` is an **address**. An address is what a person actually has, and parsing
   * it here means a typo fails locally instead of handing the name to a lock nobody can
   * spend, and the lock behind it can be checked: one anyone can spend is refused
   * (`permissiveLock`). A bare lock hash was taken until 2026-09-27; it cannot be turned
   * back into its lock, so nothing about it could be checked. A transfer cannot be
   * undone, so that matters.
   */
  async transfer(signer: ccc.Signer, name: string, newOwner: string, opts: { fundCkb?: number } = {}): Promise<Hex> {
    const a = await this.getLive(name)
    if (/^0x[0-9a-fA-F]*$/.test(newOwner.trim()))
      throw new Error('cells: give the new owner as an address, not a lock hash: a hash cannot be turned back into its lock, so it cannot be checked')
    const newOwnerScript = (await ccc.Address.fromString(newOwner.trim(), this.client)).script
    await this.refuseOpenLock(newOwnerScript, 'that address', 'owner')
    const newOwnerLockHash = newOwnerScript.hash() as Hex
    const { deed } = await this.authority(signer, a, 'owner', 'cells: signer is not the current owner')
    if (ownerId(newOwnerLockHash) === a.ownerLockHash) throw new Error('cells: that is already the owner of this name')
    // The manager is reset to the new owner: a delegation does not survive a sale.
    const data = buildAccountData(a.witnessHash, a.next, a.expiredAt, newOwnerLockHash, newOwnerLockHash, a.label)
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: a.outPoint }],
      outputs: [this.out(a.capacity)],
      outputsData: [data],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep)],
    })
    // Optionally leave some CKB with the new owner in the same transaction. The
    // protect flow (decision 0016) uses it: the quantum lock pays its own fees and
    // starts with nothing, and an address is needed to know its lock, not just a hash.
    if (opts.fundCkb) tx.addOutput({ lock: newOwnerScript, capacity: ccc.fixedPointFrom(opts.fundCkb) })
    // Handing a deed-held name to a key ends the deed: the Spore is melted and the
    // proxy cell reclaimed in the same transaction, so no stale deed is left behind.
    return this.finalize(tx, signer, [{ index: 0, inputType: TRANSFER, outputType: a.witness }], undefined, undefined, deed && { link: deed, melt: true })
  }

  /**
   * Put a name behind a post-quantum owner (decision 0016): the current owner hands
   * the name to the quantum lock, funding it for its own fees in the same transaction,
   * and the quantum key then delegates day-to-day control back to the wallet that
   * did it. Two transactions, two signatures, the second one made here with the
   * quantum key, which the caller then forgets.
   *
   * The contract resets the manager on every transfer, which is why the delegation
   * is a second step rather than a field of the first.
   */
  async protect(
    signer: ccc.Signer,
    name: string,
    pq: PqSigner,
    onStep?: (step: 'transfer' | 'waiting' | 'indexing' | 'delegate' | 'delegate-sent', txHash?: Hex) => void,
  ): Promise<{ transfer: Hex; delegate: Hex }> {
    // The hand-over is a `transfer`, and a transfer out of a deed ends it and melts the
    // Spore. Until 2026-09-29 this did exactly that, with no word said. A deed goes behind
    // the key whole with `protectDeed`.
    if (await this.deedOf(name))
      throw new Error(`cells: ${name.replace(/\.cell$/, '')}.cell is held as a deed, and protect would melt the Spore; use protectDeed, which moves the Spore behind the key`)
    // Checked before the transfer: refused after it, the name would sit behind the quantum
    // key with nobody to manage it.
    const back = await signer.getRecommendedAddressObj()
    await this.refuseOpenLock(back.script, "this wallet's address", 'manager')
    onStep?.('transfer')
    const transfer = await this.transfer(signer, name, await pq.getRecommendedAddress(), { fundCkb: PQ_FUND_CKB })
    onStep?.('waiting', transfer)
    await this.client.waitTransaction(transfer, 0, 300_000)
    // The indexer lags a committed block by a few seconds; the second step reads the
    // name through it, so wait until it shows the quantum owner. Said to the caller:
    // until 2026-09-17 this wait, up to two minutes, was invisible, and a page showed
    // "confirming" for a transaction the explorer already had as confirmed.
    onStep?.('indexing')
    const deadline = Date.now() + 120_000
    for (;;) {
      const a = await this.getAccount(name)
      if (a && a.ownerLockHash === pq.ownerId()) break
      if (Date.now() > deadline) throw new Error('cells: the network has not shown the new owner yet; the transfer went through, try the delegation again in a moment')
      await new Promise((r) => setTimeout(r, 3000))
    }
    onStep?.('delegate')
    const delegate = await this.setManager(pq, name, back.toString())
    // Out, and only then confirmed: "done" has to mean the wallet manages the name now,
    // not that a transaction was broadcast a moment ago.
    onStep?.('delegate-sent', delegate)
    await this.client.waitTransaction(delegate, 0, 300_000)
    return { transfer, delegate }
  }

  /**
   * Put a deed behind a post-quantum key: the Spore that stands for the name moves to the
   * quantum address, and the name stays in the deed. No contract changes: the deed's lock
   * asks only that the Spore be among the inputs, and the Spore's own lock is now the
   * quantum key's, so every owner action needs the key. The wallet is made the manager
   * first when it is not already, so everyday use goes on without the key, and the key
   * gets `PQ_FUND_CKB` for its own fees in the same transaction as the Spore.
   *
   * Proven on Pudge by `scripts/89-quantum-deed-proof.mjs`, and attacked by
   * `scripts/90-quantum-deed-angles.mjs`. `returnDeed` undoes it.
   */
  async protectDeed(
    signer: ccc.Signer,
    name: string,
    pq: PqSigner,
    onStep?: (step: 'manager' | 'managed' | 'transfer', txHash?: Hex) => void,
  ): Promise<{ manager?: Hex; transfer: Hex }> {
    const a = await this.getLive(name)
    const { deed } = await this.authority(signer, a, 'owner', `cells: only the holder of the deed of ${a.label}.cell may put it behind a quantum key`)
    if (!deed) throw new Error(`cells: ${a.label}.cell is not held as a deed; protect is for a name owned by a key`)
    if (!deed.sporeId) throw new Error(`cells: the deed of ${a.label}.cell cannot be found, so it cannot be moved`)
    const back = await signer.getRecommendedAddressObj()
    await this.refuseOpenLock(back.script, "this wallet's address", 'manager')
    let manager: Hex | undefined
    if (a.managerLockHash !== ownerId(back.script.hash() as Hex)) {
      onStep?.('manager')
      manager = await this.setManager(signer, name, back.toString())
      onStep?.('managed', manager)
      // The Spore went in and came back out of that transaction. The indexer shows the new
      // cell a few seconds after the block, and moving the old one would be refused.
      const deadline = Date.now() + 120_000
      while ((await findSpore(this.client, deed.sporeId).catch(() => undefined))?.cell.outPoint.txHash !== manager) {
        if (Date.now() > deadline) throw new Error('cells: the network has not shown the deed since the manager changed; try again in a moment')
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    const q = (await pq.getRecommendedAddressObj()).script
    const tx = (await transferSpore({ signer, id: deed.sporeId, to: q })).tx
    tx.addOutput({ lock: q, capacity: ccc.fixedPointFrom(PQ_FUND_CKB) })
    onStep?.('transfer')
    return { manager, transfer: await this.sendSpore(tx, signer) }
  }

  /**
   * Bring a deed back from its quantum key, the reverse of `protectDeed`: the key signs,
   * and the Spore moves to `to`, an address. The name never leaves the deed.
   */
  async returnDeed(pq: PqSigner, name: string, to: string): Promise<Hex> {
    const a = await this.getLive(name)
    const d = await this.deedOf(name)
    if (!d?.sporeId || !d.holder) throw new Error(`cells: ${a.label}.cell is not held as a deed that can be found`)
    const q = (await pq.getRecommendedAddressObj()).script
    if (!d.holder.lock.eq(q)) throw new Error(`cells: the deed of ${a.label}.cell is not held by this quantum key`)
    const dest = (await ccc.Address.fromString(to.trim(), this.client)).script
    // Whoever holds the Spore owns the name, so the same check as giving the name away.
    await this.refuseOpenLock(dest, 'that address', 'owner')
    const tx = (await transferSpore({ signer: pq, id: d.sporeId, to: dest })).tx
    return this.sendSpore(tx, pq)
  }

  /**
   * Extend a name by whole years. Permissionless: anyone may renew anyone's name,
   * they simply pay for it (decision 0009). The extension runs from the current
   * expiry, not from today, so renewing early loses nothing.
   *
   * Pass a number of years (1 to 10). A unix timestamp is still accepted for the
   * older signature, and is charged for the whole years it covers, rounded up.
   *
   * A sub-name is the exception to "anyone": it lives at the pleasure of whoever holds
   * its parent, at creation and at every renewal (2026-09-17), so the transaction must
   * carry the parent owner's signature. That is `signer` when the same wallet holds
   * both, and `parentSigner` when it does not, exactly as `register` takes it. A parent
   * held as a deed (decision 0036) is kept alive by whichever of the two holds the deed.
   */
  async renew(
    signer: ccc.Signer,
    name: string,
    yearsOrExpiry: number,
    opts: { parentSigner?: ccc.Signer } = {},
  ): Promise<Hex> {
    const a = await this.getLive(name)
    // Anything up to the maximum term is a count of years; anything larger can only
    // be a unix timestamp, since a ten-year term is 3.2e8 seconds.
    const asYears = yearsOrExpiry <= MAX_TERM_YEARS
    const years = asYears ? yearsOrExpiry : yearsForTerm(yearsOrExpiry - a.expiredAt)
    const newExpiredAt = asYears ? a.expiredAt + years * SECONDS_PER_YEAR : yearsOrExpiry

    if (newExpiredAt <= a.expiredAt) throw new Error('cells: renew must extend expired_at')
    if (!Number.isInteger(years) || years < MIN_TERM_YEARS || years > MAX_TERM_YEARS)
      throw new Error(`cells: renew buys ${MIN_TERM_YEARS} to ${MAX_TERM_YEARS} whole years at a time`)

    // A sub-name may not be renewed past its parent, or the parent could lapse and be
    // recycled while the child kept resolving. The contract needs the parent as a dep
    // to check it; this catches the case here with a message that says why.
    const parentDeps: { outPoint: { txHash: Hex; index: number }; depType: 'code' }[] = []
    const parentInputs: { previousOutput: ccc.OutPointLike }[] = []
    const parentOutputs: { lock: ccc.Script; capacity: bigint }[] = []
    let parentOwnerLock: ccc.Script | null = null
    let parentDeed: { link: DeedLink; holder: ccc.Signer } | undefined
    const parent = parentLabel(a.label)
    if (parent) {
      const p = await this.getAccount(parent)
      if (!p) throw new Error(`cells: parent ${parent}.cell is not registered`)
      if (newExpiredAt > p.expiredAt)
        throw new Error(
          `cells: a sub-name may not outlive its parent (${parent}.cell expires ${p.expiredAt}); renew the parent first`,
        )
      parentDeps.push({ outPoint: p.outPoint, depType: 'code' })
      // The contract wants an input under the parent owner's lock, so a child's holder
      // cannot keep it alive by renewing the parent themselves and then the child.
      const parentKey = opts.parentSigner ?? signer
      parentOwnerLock = (await parentKey.getRecommendedAddressObj()).script
      if (p.ownerLockHash !== ownerId(parentOwnerLock.hash() as Hex)) {
        const refusal = opts.parentSigner
          ? `cells: the key given as the owner of ${parent}.cell does not own it`
          : `cells: only the owner of ${parent}.cell may renew ${a.label}.cell; a sub-name lives as long as its parent's owner keeps it`
        // A parent held as a deed: its proxy cell is that input, as at register.
        const { deed } = await this.authority(parentKey, p, 'owner', refusal)
        if (!deed) throw new Error(refusal)
        parentDeed = { link: deed, holder: parentKey }
      }
      if (opts.parentSigner && !parentDeed) {
        const cell = await this.plainCell(parentOwnerLock)
        if (!cell)
          throw new Error(
            `cells: the owner of ${parent}.cell holds no ordinary cell to prove it with; send it a little CKB first`,
          )
        parentInputs.push({ previousOutput: cell.outPoint })
        parentOutputs.push({ lock: parentOwnerLock, capacity: cell.cellOutput.capacity })
      }
    }

    const data = buildAccountData(a.witnessHash, a.next, newExpiredAt, a.ownerLockHash, a.managerLockHash, a.label)
    // The schedule after the price cell's discount (decision 0014), as at register.
    const price = await this.priceCell()
    const fee = applyPriceFactor(ccc.fixedPointFrom(registrationFeeCkb(a.label, years)), price?.factorBps ?? PRICE_FACTOR_MAX)
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: a.outPoint }, ...parentInputs],
      outputs: [
        this.out(a.capacity),
        {
          lock: this.treasuryLock(),
          capacity: fee < this.treasuryMin() ? this.treasuryMin() : fee,
        },
        ...parentOutputs,
      ],
      outputsData: [data, '0x', ...parentOutputs.map(() => '0x' as Hex)],
      cellDeps: [
        this.cd(this.dep.accountDep),
        this.cd(this.dep.lockDep),
        ...parentDeps,
        ...(price ? [{ outPoint: price.outPoint, depType: 'code' as const }] : []),
      ],
    })
    // The parent's owner is the signer: prove it by spending something of theirs, the
    // way a cancelled listing does, rather than trusting the fee to come from them.
    if (parentOwnerLock && !opts.parentSigner && !parentDeed) await this.spendOneCellUnder(tx, parentOwnerLock)
    return this.finalize(tx, signer, [{ index: 0, inputType: RENEW, outputType: a.witness }], undefined, opts.parentSigner, parentDeed)
  }

  /**
   * Recycle an *expired* name, splice it out of the list and reclaim its
   * capacity. Permissionless; the type script requires the target's input `since`
   * to prove (via consensus timing) that it is past its `expired_at` plus the thirty
   * days of grace (`recycleSince`).
   */
  async recycle(signer: ccc.Signer, name: string): Promise<Hex> {
    const x = await this.getLive(name)
    let predLite: LiveAccountLite | null = null
    for await (const c of this.liveCellsLite()) {
      if (c.next === x.id) {
        predLite = c
        break
      }
    }
    if (!predLite) throw new Error('cells: predecessor not found (list inconsistent?)')
    const pred = await this.hydrate(predLite)
    // p', predecessor with x spliced out (next jumps past x); witness/version/manager preserved.
    const pData = buildAccountData(pred.witnessHash, x.next, pred.expiredAt, pred.ownerLockHash, pred.managerLockHash, pred.label)
    const tx = ccc.Transaction.from({
      inputs: [
        { previousOutput: pred.outPoint },
        { previousOutput: x.outPoint, since: ABS_TS | BigInt(recycleSince(x.expiredAt)) },
      ],
      outputs: [this.out(pred.capacity)], // x's capacity becomes the recycler's change
      outputsData: [pData],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep)],
    })
    return this.finalize(tx, signer, [{ index: 0, inputType: RECYCLE, outputType: pred.witness }])
  }

  // --- selling a name (decision 0012) ---------------------------------------

  /**
   * The lock a listed name is owned by: the seller and the asking price, in its args.
   *
   * Because the price is in the args it is in the lock hash, and the lock hash is
   * what the name's own data records as its owner. So a listing's price is on chain
   * from the moment it is made and cannot be changed by anybody, seller included,
   * without an act the seller signs.
   */
  saleLock(sellerLockHash: Hex, priceShannons: bigint): ccc.Script {
    if (!this.dep.sale) throw new Error('cells: this deployment has no sale lock')
    return ccc.Script.from({
      codeHash: this.dep.sale.codeHash,
      hashType: this.dep.sale.hashType,
      args: ccc.hexFrom(ccc.bytesConcat(ccc.bytesFrom(sellerLockHash), ccc.numLeToBytes(priceShannons, 8))),
    })
  }

  /**
   * Every live offer cell, keyed by the lock hash that identifies its listing.
   *
   * Listings need no registry: the offer cells **are** the listings, and they are
   * found by asking the chain for cells under this code hash. Anyone can do it, and
   * two people asking get the same answer.
   */
  async offers(): Promise<Map<Hex, SaleOffer>> {
    return this.cached('offers', () => this.offersFresh())
  }

  /** `offers()` without the cache. Write paths use it, they must not spend a stale offer. */
  private async offersFresh(): Promise<Map<Hex, SaleOffer>> {
    const out = new Map<Hex, SaleOffer>()
    if (!this.dep.sale) return out
    for await (const c of this.client.findCells({
      script: { codeHash: this.dep.sale.codeHash, hashType: this.dep.sale.hashType, args: '0x' },
      scriptType: 'lock',
      scriptSearchMode: 'prefix',
    })) {
      const args = ccc.bytesFrom(c.cellOutput.lock.args)
      if (args.length !== 40) continue // not a listing this client understands
      const price = ccc.numLeFromBytes(args.slice(32, 40))
      const seller = ccc.hexFrom(args.slice(0, 32)) as Hex
      if (c.cellOutput.type) {
        const listed = await this.deedListing(c, seller, price).catch(() => null)
        if (listed) out.set(listed[0], listed[1])
        continue
      }
      // The offer carries the seller's own lock script in its data, because the args
      // hold only a hash and a hash cannot be turned back into somewhere to send
      // money. It is checked against that hash: a listing whose data lies about its
      // seller could never be paid, so it is not shown as for sale.
      let sellerLock: ccc.Script
      try {
        sellerLock = ccc.Script.fromBytes(ccc.bytesFrom(c.outputData))
      } catch {
        continue
      }
      if ((sellerLock.hash() as Hex) !== seller) continue
      // Keyed by the identity a listed name stores as its owner: the sale lock's hash,
      // truncated the way every owner is (decision 0015).
      out.set(ownerId(c.cellOutput.lock.hash() as Hex), {
        seller,
        sellerLock,
        priceShannons: price,
        ...offerSplit(price),
        outPoint: { txHash: c.outPoint.txHash as Hex, index: Number(c.outPoint.index) },
        capacity: c.cellOutput.capacity,
      })
    }
    return out
  }

  /**
   * A deed listed whole: its Spore alone under the sale lock. Only from this deployment's
   * deeds clusters, only while the Spore still holds the name its card names, and only
   * while the manager is the deed itself, so nobody the seller chose can edit the name
   * after it is sold (`listDeed` sees to that; a listing made some other way is not
   * shown). Keyed like any listing, by the identity the name stores as its owner, which
   * for a deed is its proxy lock and does not change when the Spore is listed.
   */
  private async deedListing(c: ccc.Cell, seller: Hex, price: bigint): Promise<[Hex, SaleOffer] | null> {
    const type = c.cellOutput.type!
    const info = getSporeScriptInfo(this.client)
    if (type.codeHash !== info.codeHash || type.hashType !== info.hashType) return null
    const data = unpackToRawSporeData(c.outputData)
    const cluster = data.clusterId ? (ccc.hexFrom(data.clusterId) as Hex) : null
    if (!cluster || !this.deedClusterIds().includes(cluster)) return null
    const card = deedCard(data.content)
    if (!card) return null
    const sporeTypeHash = type.hash() as Hex
    const owner = ownerId((await deedLock(this.client, sporeTypeHash)).hash() as Hex)
    const a = await this.getAccount(card.label)
    if (!a || a.ownerLockHash !== owner || a.managerLockHash !== owner) return null
    const sellerLock = await this.sellerLockOf(c.outPoint.txHash as Hex, seller)
    if (!sellerLock) return null
    return [
      owner,
      {
        seller,
        sellerLock,
        priceShannons: price,
        ...offerSplit(price),
        outPoint: { txHash: c.outPoint.txHash as Hex, index: Number(c.outPoint.index) },
        capacity: c.cellOutput.capacity,
        deed: { sporeId: type.args as Hex, sporeTypeHash, cluster, label: card.label },
      },
    ]
  }

  /**
   * The lock behind a seller's hash, for a deed listing, whose Spore cannot carry it the
   * way an offer cell does: from the transaction that listed it, which the seller paid
   * for and had their change back in, or else from the cell it took the Spore out of.
   */
  private async sellerLockOf(txHash: Hex, seller: Hex): Promise<ccc.Script | null> {
    const r = await this.client.getTransaction(txHash)
    if (!r) return null
    for (const o of r.transaction.outputs) if (o.lock.hash() === seller) return o.lock
    for (const i of r.transaction.inputs.slice(0, 8)) {
      const prev = await this.client.getCell(i.previousOutput)
      if (prev && prev.cellOutput.lock.hash() === seller) return prev.cellOutput.lock
    }
    return null
  }

  /** The listing for one name, or null if it is not for sale. */
  async listing(name: string): Promise<SaleOffer | null> {
    const a = await this.getAccount(name)
    if (!a) return null
    return (await this.offers()).get(a.ownerLockHash) ?? null
  }

  /**
   * The smallest price a listing may ask.
   *
   * Not a policy: CKB requires every cell to hold at least its own size in capacity, so
   * what binds is that **the seller's own payout has to be a cell**, about 63 CKB. That
   * is the whole floor, and it does not move with the fee.
   *
   * It did until 2026-09-14, and that was the bug. The protocol's share also has to be a
   * cell, so the floor was written as a hundred times one: 630 CKB at a ten percent fee,
   * and 6,300 when the fee fell to one, which made cheaper names **less** sellable for
   * charging less. The contract now waives a share too small to be a cell (`sale_fee` in
   * cells-core), so a cheap name is sold with no fee at all and the seller keeps the
   * whole price.
   *
   * @param sellerLock - The seller's own lock, when it is known. Without it this answers
   *   for the treasury's lock, which is the same 63 bytes and is what the help page shows
   *   before anybody has connected a wallet. `listForSale` passes the real one.
   */
  minListingPriceCkb(sellerLock?: ccc.ScriptLike): number {
    const lock = sellerLock ? ccc.Script.from(sellerLock) : this.treasuryLock()
    return ccc.CellOutput.from({ lock, capacity: 0 }).occupiedSize
  }

  /**
   * Put a name up for sale at `priceCkb`.
   *
   * Ownership moves to the sale lock and one small cell is left under it, the offer.
   * From then on any stranger can complete the sale alone, and the seller can take it
   * back at any time. While listed the name cannot be edited or given away, because
   * the wallet is no longer its owner; cancel first.
   *
   * Not `list`: a class keeps the last method of a name, and `list()` (every live
   * name) is what the whole app reads through.
   */
  async listForSale(signer: ccc.Signer, name: string, priceCkb: number, opts: { keepDeed?: boolean } = {}): Promise<Hex> {
    const a = await this.getLive(name)
    // The sale lock lets the seller out by any spend under the seller's lock, so a lock
    // anyone can spend would let anyone take the name off sale and keep it.
    const me = (await signer.getRecommendedAddressObj()).script
    await this.refuseOpenLock(me, "this wallet's address", 'seller')
    const seller = me.hash() as Hex
    // A name held as a deed (decision 0036) is listed by whoever holds the deed. By
    // default listing ends it: the Spore is melted and its deposits come back in the same
    // transaction, so the buyer receives the name and not a Spore, and may make a deed
    // of their own. The sale is then an ordinary one, paid to the holder's key. With
    // `keepDeed` the deed is sold whole instead (`listDeed`).
    let deed: DeedLink | undefined
    if (ownerId(seller) !== a.ownerLockHash) {
      const via = await this.authority(signer, a, 'owner', 'cells: only the owner can put a name up for sale')
      if (!via.deed) throw new Error('cells: only the owner can put a name up for sale')
      deed = via.deed
    }
    if (deed && opts.keepDeed) return this.listDeed(signer, a, deed, priceCkb)
    const min = this.minListingPriceCkb((await signer.getRecommendedAddressObj()).script)
    if (!(priceCkb >= min))
      throw new Error(
        `cells: the lowest a name can be listed for is ${min} CKB, because your own payout has to be a cell on the chain and a cell cannot be smaller than that`,
      )
    const price = ccc.fixedPointFrom(priceCkb)
    const sale = this.saleLock(seller, price)
    const owner = sale.hash() as Hex
    const data = buildAccountData(a.witnessHash, a.next, a.expiredAt, owner, owner, a.label)
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: a.outPoint }],
      outputs: [this.out(a.capacity), { lock: sale, capacity: ccc.fixedPointFrom(OFFER_CELL_CKB) }],
      outputsData: [data, ccc.hexFrom((await signer.getRecommendedAddressObj()).script.toBytes())],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep)],
    })
    return this.finalize(tx, signer, [{ index: 0, inputType: TRANSFER, outputType: a.witness }], undefined, undefined, deed && { link: deed, melt: true })
  }

  /**
   * List a deed whole: its Spore goes under the sale lock alone, and whoever pays the
   * price takes it, and with it the name, its being and its belly. No offer cell: the
   * lock asks its price of every cell it guards, so a second cell would be a second
   * price. When the manager is not the deed (a delegate, or a holder who claimed it) it
   * is handed back to the deed in the same transaction, so nobody the seller chose can
   * edit the name once it is sold.
   */
  private async listDeed(signer: ccc.Signer, a: LiveAccount, deed: DeedLink, priceCkb: number): Promise<Hex> {
    if (!(priceCkb >= 1)) throw new Error('cells: a deed is listed for at least 1 CKB')
    if (!deed.sporeId) throw new Error('cells: the deed of this name cannot be found, so it cannot be listed')
    const me = (await signer.getRecommendedAddressObj()).script
    const sale = this.saleLock(me.hash() as Hex, ccc.fixedPointFrom(priceCkb))
    if (a.managerLockHash !== a.ownerLockHash) {
      const data = buildAccountData(a.witnessHash, a.next, a.expiredAt, a.ownerLockHash, a.ownerLockHash, a.label)
      const tx = ccc.Transaction.from({
        inputs: [{ previousOutput: a.outPoint }],
        outputs: [this.out(a.capacity)],
        outputsData: [data],
        cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep)],
      })
      return this.finalize(tx, signer, [{ index: 0, inputType: EDIT_MANAGER, outputType: a.witness }], undefined, undefined, { link: deed, to: sale })
    }
    const tx = (await transferSpore({ signer, id: deed.sporeId, to: sale })).tx
    return this.sendSpore(tx, signer)
  }

  /**
   * A transaction that moves only a Spore (listing, buying or withdrawing a deed): the
   * signer's cells pay for it, and it is sent and waited for like every other here.
   */
  private async sendSpore(tx: ccc.Transaction, signer: ccc.Signer): Promise<Hex> {
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, FEE_RATE)
    const signed = await signer.signTransaction(tx)
    const h = (await this.client.sendTransaction(signed)) as Hex
    await this.client.waitTransaction(h, 0, 300_000)
    this.invalidate()
    return h
  }

  /**
   * Take a name off sale. Only the seller can, and they always can.
   *
   * The name goes back to the seller's lock even when `permissiveLock` refuses it: it was
   * theirs before it was listed, and on sale it is no safer, because the sale lock takes
   * any spend under the seller's lock for the seller.
   */
  async cancelListing(signer: ccc.Signer, name: string): Promise<Hex> {
    const a = await this.getLive(name)
    const offer = (await this.offersFresh()).get(a.ownerLockHash)
    if (!offer) throw new Error(`cells: ${name} is not for sale`)
    const seller = (await signer.getRecommendedAddressObj()).script.hash() as Hex
    if (seller !== offer.seller) throw new Error('cells: only the seller can cancel a listing')
    if (offer.deed) {
      // The seller is here, which opens the sale lock; the Spore comes back to them.
      const me = (await signer.getRecommendedAddressObj()).script
      let tx = ccc.Transaction.from({ cellDeps: [this.cd(this.dep.sale!.dep)] })
      await this.spendOneCellUnder(tx, me)
      tx = (await transferSpore({ signer, id: offer.deed.sporeId, to: me, tx })).tx
      return this.sendSpore(tx, signer)
    }
    const data = buildAccountData(a.witnessHash, a.next, a.expiredAt, seller, seller, a.label)
    const tx = ccc.Transaction.from({
      // The offer cell unlocks because the seller is here; its capacity comes back
      // to them as change.
      inputs: [{ previousOutput: a.outPoint }, { previousOutput: offer.outPoint }],
      outputs: [this.out(a.capacity)],
      outputsData: [data],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep), this.cd(this.dep.sale!.dep)],
    })
    // The offer cell alone more than pays for this transaction, so nothing would
    // otherwise be spent from the seller's own wallet, and "the seller is here" is
    // proved only by spending something of theirs. Found by the chain refusing it.
    await this.spendOneCellUnder(tx, (await signer.getRecommendedAddressObj()).script)
    return this.finalize(tx, signer, [{ index: 0, inputType: TRANSFER, outputType: a.witness }])
  }

  /**
   * Buy a listed name. One transaction: the seller and the treasury are paid, and
   * the name changes hands. There is no instant at which either side holds both.
   *
   * The protocol's fee (decision 0025) comes out of the seller's proceeds, so the buyer
   * pays exactly the price the listing advertises.
   *
   * A lapsed name is refused. Past its grace period anybody may recycle it, so buying
   * it buys nothing the next block cannot take away; inside the grace period it is still
   * the seller's, but the buyer inherits a renewal due at once, and has to say so with
   * `allowLapsed`. The app's market has shown "expired" and offered no button since
   * 2026-09-05; a client built on this method got no such word until 2026-09-17,
   * because `getLive` only ever meant "the cell exists".
   *
   * The listing is read again here, when the buyer acts, so a screen passes what it showed:
   * `maxPriceShannons`, the price, and `outPoint`, the listing's cell. A seller can cancel
   * and list again at a higher price while the buyer's page is open, and until 2026-09-27
   * this paid the new price: the box said 1,000 CKB and the transaction paid 90,000. A
   * listing dearer than `maxPriceShannons`, or other than `outPoint`, is refused before
   * the wallet is asked for anything.
   */
  async buy(
    signer: ccc.Signer,
    name: string,
    opts: { allowLapsed?: boolean; maxPriceShannons?: bigint; outPoint?: ccc.OutPointLike } = {},
  ): Promise<Hex> {
    const a = await this.getLive(name)
    const state = nameState(a.expiredAt)
    if (state === 'free')
      throw new Error(`cells: ${a.label}.cell has lapsed past its grace period, so anybody may recycle it; buying it buys nothing`)
    if (state === 'grace' && !opts.allowLapsed)
      throw new Error(`cells: ${a.label}.cell has expired and must be renewed at once; pass { allowLapsed: true } to buy it anyway`)
    const offer = (await this.offersFresh()).get(a.ownerLockHash)
    if (!offer) throw new Error(`cells: ${name} is not for sale`)
    const asks = `${ccc.fixedPointToString(offer.priceShannons)} CKB`
    if (opts.maxPriceShannons !== undefined && offer.priceShannons > opts.maxPriceShannons)
      throw new Error(
        `cells: ${a.label}.cell now asks ${asks}, more than the ${ccc.fixedPointToString(opts.maxPriceShannons)} CKB agreed to; nothing was signed`,
      )
    if (opts.outPoint !== undefined) {
      const shown = ccc.OutPoint.from(opts.outPoint)
      if (shown.txHash !== offer.outPoint.txHash || Number(shown.index) !== offer.outPoint.index)
        throw new Error(`cells: the listing of ${a.label}.cell changed after it was shown, and it now asks ${asks}; nothing was signed`)
    }
    const me = (await signer.getRecommendedAddressObj()).script
    const buyer = me.hash() as Hex
    if (buyer === offer.seller)
      throw new Error('cells: this is your own listing; cancel it instead of buying it back')
    await this.refuseOpenLock(me, "this wallet's address", offer.deed ? 'holder' : 'owner')
    if (offer.deed) {
      // The name does not move: its owner is the deed's lock, and the Spore that opens it
      // becomes the buyer's. The seller is paid the price less the fee, plus the Spore's
      // own capacity, which was theirs; the buyer brings a new one for the Spore they take.
      let tx = ccc.Transaction.from({
        outputs: [
          { lock: offer.sellerLock, capacity: offer.toSellerShannons + offer.capacity },
          ...(offer.toTreasuryShannons > 0n ? [{ lock: this.treasuryLock(), capacity: offer.toTreasuryShannons }] : []),
        ],
        outputsData: offer.toTreasuryShannons > 0n ? ['0x', '0x'] : ['0x'],
        cellDeps: [this.cd(this.dep.sale!.dep)],
      })
      tx = (await transferSpore({ signer, id: offer.deed.sporeId, to: me, tx })).tx
      return this.sendSpore(tx, signer)
    }
    const data = buildAccountData(a.witnessHash, a.next, a.expiredAt, buyer, buyer, a.label)
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: a.outPoint }, { previousOutput: offer.outPoint }],
      outputs: [
        this.out(a.capacity),
        {
          lock: offer.sellerLock,
          // The price, plus the deposit the seller parked in the offer cell coming back
          // to them. The buyer therefore brings exactly the price: the deposit is in the
          // inputs already and passes straight through. Before 2026-09-14 it went to the
          // buyer instead, which meant any listing cheaper than the deposit could be
          // taken for nothing, and the seller paid to give the name away.
          capacity: offer.toSellerShannons + offer.capacity,
        },
        // No treasury output at all when nothing is owed. Building one anyway would mean
        // a cell of 63 CKB for a share of one, so a name listed at 100 would cost the
        // buyer 162: the price they were shown plus a fee nobody charged them.
        ...(offer.toTreasuryShannons > 0n ? [{ lock: this.treasuryLock(), capacity: offer.toTreasuryShannons }] : []),
      ],
      outputsData: offer.toTreasuryShannons > 0n ? [data, '0x', '0x'] : [data, '0x'],
      cellDeps: [this.cd(this.dep.accountDep), this.cd(this.dep.lockDep), this.cd(this.dep.sale!.dep)],
    })
    return this.finalize(tx, signer, [{ index: 0, inputType: TRANSFER, outputType: a.witness }])
  }

  /**
   * Take the plain cells under a deed's lock back to its holder, a page per transaction,
   * until no more than `room` are left beside the one `skip` names, for the transaction
   * that melts the Spore or puts the deed on a new card to carry.
   *
   * Anyone may park a cell under any lock, and a melt has to take them all or strand them
   * for good, so until 2026-09-27 a stranger who parked more than one transaction carries,
   * with a byte of data in each so the belly would not count them, froze the deed. A page
   * spends the Spore and hands it straight back, which is what opens the lock, so only the
   * holder can send one; the name, the proxy cell and the Spore stay as they were, and
   * what a page takes comes back to the holder as change.
   */
  private async sweepDeedDown(
    signer: ccc.Signer,
    sporeId: Hex,
    sporeTypeHash: Hex,
    room: number,
    skip?: { txHash: string; index: number },
  ): Promise<void> {
    const lock = await deedLock(this.client, sporeTypeHash)
    const key = (o: ccc.OutPointLike) => {
      const x = ccc.OutPoint.from(o)
      return `${x.txHash}:${Number(x.index)}`
    }
    // Taken, or not to be taken: the indexer trails a committed block by a few seconds, so
    // a cell a page just spent can still be listed when the next page is read.
    const done = new Set<string>(skip ? [key(skip)] : [])
    for (;;) {
      const left: ccc.Cell[] = []
      for await (const c of this.client.findCellsByLock(lock, undefined, true)) {
        if (c.cellOutput.type || done.has(key(c.outPoint))) continue
        left.push(c)
        if (left.length > Math.max(room, DEED_PAGE)) break
      }
      if (left.length <= room) return
      const page = left.slice(0, DEED_PAGE)
      let tx = ccc.Transaction.from({ inputs: page.map((c) => ({ previousOutput: c.outPoint })) })
      await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.InputTypeProxyLock)
      const me = (await signer.getRecommendedAddressObj()).script
      tx = (await transferSpore({ signer, id: sporeId, to: me, tx })).tx
      await tx.completeFeeBy(signer, FEE_RATE)
      const h = (await this.client.sendTransaction(await signer.signTransaction(tx))) as Hex
      await this.client.waitTransaction(h, 0, 300_000)
      for (const c of page) done.add(key(c.outPoint))
      // The next page, and the melt after the last, find the Spore through the indexer.
      const deadline = Date.now() + 120_000
      while ((await findSpore(this.client, sporeId).catch(() => undefined))?.cell.outPoint.txHash !== h) {
        if (Date.now() > deadline)
          throw new Error('cells: the network has not shown the deed where the last page left it; what that page took is in your wallet, so try again in a moment')
        await sleep(2_000)
      }
    }
  }

  /**
   * Refuse `lock` as a name's owner, manager or seller, or a deed's holder, when anyone can
   * spend a cell under it (`permissiveLock`, which says why). Asked before anything is
   * signed, by every path that sets one of the four.
   */
  private async refuseOpenLock(lock: ccc.ScriptLike, whose: string, role: 'owner' | 'manager' | 'seller' | 'holder'): Promise<void> {
    const kind = await permissiveLock(this.client, lock, this.dep)
    if (!kind) return
    const as = { owner: "a name's owner", manager: "a name's manager", seller: 'a seller', holder: "a deed's holder" }[role]
    throw new Error(
      `cells: ${whose} is under ${kind}, which lets anyone spend a cell under it, so it cannot be ${as}: ` +
        `the contracts would take a stranger's spend there for the ${role} acting. Use an address that only its own key can spend.`,
    )
  }

  /**
   * Put one ordinary cell under `lock` into the transaction.
   *
   * Control of a lock is proved by spending something it owns, and nothing else. A
   * transaction that happens to balance without touching the wallet proves nothing,
   * which is exactly how cancelling a listing failed the first time it ran.
   */
  private async spendOneCellUnder(tx: ccc.Transaction, lock: ccc.Script): Promise<void> {
    const already = new Set(tx.inputs.map((i) => `${i.previousOutput.txHash}:${i.previousOutput.index}`))
    for await (const c of this.client.findCellsByLock(lock, undefined, true)) {
      if (c.cellOutput.type || (c.outputData ?? '0x') !== '0x') continue // pure cells only
      const key = `${c.outPoint.txHash}:${c.outPoint.index}`
      if (already.has(key)) continue
      tx.inputs.push(ccc.CellInput.from({ previousOutput: c.outPoint }))
      return
    }
    throw new Error('cells: this wallet has no ordinary cell to spend, so it cannot prove it is the owner')
  }

  /**
   * Complete capacity+fee, inject the type-script witness payloads, sign, broadcast,
   * await.
   *
   * The payloads go in **before** the fee is completed, because a record set is the
   * bulk of the transaction once a name publishes anything larger than an address.
   * CCC's `estimateFee` measures the real serialized transaction (`toBytes().length
   * + 4`) and its `prepareSighashAllWitness` overwrites only the witness `lock`,
   * leaving `inputType`/`outputType` alone, so a payload that is already there is
   * both counted and kept. `prepareTransaction` also runs before the estimate, so
   * the lock placeholder is counted too.
   *
   * It used to be injected *after* `completeFeeBy`, which paid for a transaction
   * that did not yet contain the records. The 2x over-provision hid that while every
   * record was a ~100-byte address: the headroom it buys is about the base
   * transaction's own size, so roughly a kilobyte. Anything bigger, an avatar for
   * one, underpaid and the node rejected the transaction with
   * `PoolRejectedTransactionByMinFeeRate`, which a wallet surfaces as a failure with
   * no useful cause. DOB Studio hit exactly this with CKBFS content witnesses.
   */
  /** The first plain cell under a lock: no type script, no data, spendable as proof. */
  private async plainCell(lock: ccc.Script): Promise<ccc.Cell | null> {
    for await (const c of this.client.findCellsByLock(lock, undefined, true)) {
      if (!c.cellOutput.type && c.outputData === '0x') return c
    }
    return null
  }

  private async finalize(
    tx: ccc.Transaction,
    signer: ccc.Signer,
    injects: { index: number; inputType?: ccc.BytesLike; outputType?: ccc.BytesLike }[],
    onSent?: (txHash: Hex) => void,
    /**
     * A second signer whose own input is already in the transaction (a sub-name's
     * parent owner). Its witness placeholder must exist before the fee is sized, or
     * the fee would be short by the size of a signature, which for a quantum key is
     * eight kilobytes. Its signature covers only its own script group, so the two
     * signatures are independent and order does not matter.
     */
    coSigner?: ccc.Signer,
    /**
     * The name is held as a deed (decision 0036) and `signer` holds it: spend the deed's
     * proxy cell, and the deed itself, in this transaction. The Spore comes back to its
     * holder unchanged, or is melted when `melt` is set (the name is leaving the deed),
     * in which case the proxy cell is not recreated either and both capacities return
     * as change. `holder` is the wallet the deed sits in when it is not `signer`: a
     * sub-name's parent held as a deed by the co-signer. `to` hands the Spore to another
     * lock instead of back to its holder: the sale lock, when a deed is listed whole.
     */
    deed?: { link: DeedLink; melt?: boolean; holder?: ccc.Signer; to?: ccc.Script },
  ): Promise<Hex> {
    // Idempotent: it preserves whatever lock placeholder is already in the slot, so
    // running it before and after fee completion writes the same bytes twice.
    const inject = () => {
      for (const inj of injects) {
        while (tx.witnesses.length <= inj.index) tx.witnesses.push('0x')
        let cur: ccc.WitnessArgs
        try {
          cur = ccc.WitnessArgs.fromBytes(tx.witnesses[inj.index])
        } catch {
          cur = ccc.WitnessArgs.from({})
        }
        tx.witnesses[inj.index] = ccc.hexFrom(
          ccc.WitnessArgs.from({
            lock: cur.lock,
            inputType: inj.inputType ?? cur.inputType,
            outputType: inj.outputType ?? cur.outputType,
          }).toBytes(),
        )
      }
    }

    inject()
    if (deed) {
      // The cell `authority` chose, by outpoint: the one that names the deed truthfully
      // when there is one, so a melt reclaims it and not a stranger's decoy.
      const p = await this.client.getCellLive(deed.link.proxy.outPoint, true)
      if (!p) throw new Error('cells: the deed\'s proxy cell is no longer live')
      tx.inputs.push(ccc.CellInput.from({ previousOutput: p.outPoint }))
      if (!deed.melt) tx.addOutput(p.cellOutput, p.outputData)
      else {
        // Ending the deed is the one chance anyone has to spend what sits under that
        // lock: afterwards the Spore is gone and the lock never opens again. Anyone may
        // put a cell there, so a decoy left by a stranger is swept here too, and its
        // capacity comes back as change rather than being stranded forever.
        const lock = await deedLock(this.client, deed.link.sporeTypeHash)
        const at = { txHash: p.outPoint.txHash, index: Number(p.outPoint.index) }
        await this.sweepDeedDown(deed.holder ?? signer, deed.link.sporeId!, deed.link.sporeTypeHash, DEED_PAGE, at)
        for (const stray of await sweepable(this.client, lock, DEED_PAGE, at))
          tx.inputs.push(ccc.CellInput.from({ previousOutput: stray.outPoint }))
        await this.takePlates(tx, deed.link.sporeTypeHash, DEED_PAGE)
      }
      await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.InputTypeProxyLock)
      // Spore v2 wants its cobuild action on every transfer or melt; the spore package
      // adds it, after the inputs, and leaves witness 0 alone.
      const holderSigner = deed.holder ?? signer
      const holder = (await holderSigner.getRecommendedAddressObj()).script
      tx = deed.melt
        ? (await meltSpore({ signer: holderSigner, id: deed.link.sporeId!, tx })).tx
        : (await transferSpore({ signer: holderSigner, id: deed.link.sporeId!, to: deed.to ?? holder, tx })).tx
      inject()
    }
    if (coSigner) await coSigner.prepareTransaction(tx)
    await tx.completeInputsByCapacity(signer)
    await tx.completeFeeBy(signer, FEE_RATE)
    // Belt and braces: CCC preserves the payload, but re-injecting costs nothing and
    // means a future CCC that does not cannot silently ship an unsigned-for witness.
    inject()

    // Refuse to broadcast a transaction the node would reject for fee anyway, so the
    // cause is stated here rather than read backwards out of a pool error.
    const paid = await tx.getFee(this.client)
    const floor = tx.estimateFee(MIN_FEE_RATE)
    if (paid < floor)
      throw new Error(
        `cells: this transaction pays ${paid} shannons but needs at least ${floor}. ` +
          `Its records are ${(ccc.bytesFrom(tx.witnesses[injects[0]?.index ?? 0] ?? '0x').length / 1024).toFixed(1)} KB; ` +
          `publish fewer or smaller ones.`,
      )

    let signed = await signer.signTransaction(tx)
    if (coSigner) signed = await coSigner.signTransaction(signed)
    const h = (await this.client.sendTransaction(signed)) as Hex
    onSent?.(h)
    await this.client.waitTransaction(h, 0, 300_000)
    // This transaction just changed a name or an offer; do not serve the old scan.
    this.invalidate()
    return h
  }
}
