import { ccc } from '@ckb-ccc/core'
import type { Hex } from './codec.ts'
import { parsePayWitness, payWitness } from './request.ts'

/**
 * The bytes of a USDC payment, and how to read them back.
 *
 * A request in dollars is paid as an ERC-20 `transfer` on the chain the unit names. The
 * call is 68 bytes: a four-byte selector and two 32-byte arguments. Solidity's decoder
 * reads exactly the bytes it expects and ignores whatever follows, so the same 45 bytes
 * that ride in a CKB payment's witness (`cells:pay:1`, a zero, the request hash) are
 * appended after the arguments. The token contract never sees them; the receipt keeps
 * them. That is what lets the payer's browser say "paid" for the right request and not
 * merely "some dollars arrived at that address".
 *
 * Nothing here talks to a chain. It makes and reads bytes, and the tests pin both
 * directions against the selector and topic computed with keccak from the signatures,
 * rather than trusting the constants written below.
 */

/** `keccak256("transfer(address,uint256)")[..4]`. */
export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb' as Hex
/** `keccak256("Transfer(address,address,uint256)")`, the topic of the event a transfer emits. */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex

const strip = (h: string) => h.replace(/^0x/, '').toLowerCase()
const word = (hex: string) => strip(hex).padStart(64, '0')

/**
 * The calldata of `transfer(to, amount)`, with the request fingerprint appended when
 * there is one. `amount` is in the token's smallest unit, so six decimals for USDC.
 */
export function transferCalldata(to: string, amount: bigint, requestHash: Hex | null = null): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('cells: not an EVM address')
  if (amount <= 0n) throw new Error('cells: the amount must be above zero')
  const args = word(to) + word(amount.toString(16))
  const tail = requestHash ? strip(payWitness(requestHash, null)) : ''
  return (ERC20_TRANSFER_SELECTOR + args + tail) as Hex
}

/**
 * What a transaction's `input` says: the recipient, the amount, and the request hash it
 * was paying, if any. Null when it is not an ERC-20 transfer at all.
 */
export function parseTransferInput(input: string): { to: string; amount: bigint; requestHash: Hex | null } | null {
  const h = strip(input)
  if (h.length < 8 + 128 || !h.startsWith(strip(ERC20_TRANSFER_SELECTOR))) return null
  const to = ('0x' + h.slice(8 + 24, 8 + 64)) as Hex
  const amount = BigInt('0x' + h.slice(8 + 64, 8 + 128))
  const rest = h.slice(8 + 128)
  let requestHash: Hex | null = null
  if (rest.length > 0) {
    const w = parsePayWitness(('0x' + rest) as Hex)
    requestHash = w?.hash ?? null
  }
  return { to, amount, requestHash }
}

/** One log of a transaction receipt, as an EVM JSON-RPC node returns it. */
export interface EvmLog {
  address: string
  topics: string[]
  data: string
}

/**
 * Every `Transfer` of `token` to `to` in a successful receipt, with who sent each one.
 *
 * Read from the event the token contract emitted, not from the calldata: the calldata is
 * what was asked, the event is what happened, and a reverted transfer has the first and
 * not the second. `status` must be `0x1` as well, because a failed transaction still has
 * logs from before the revert in some clients. A reverted or missing receipt has no
 * transfers, which is the same answer as a receipt that paid somebody else.
 *
 * The amount is left to the caller rather than matched here, because a payer who is a
 * cent over should not read as a payer who sent nothing, and only the caller knows
 * whether it is owed an exact figure or at least one.
 */
export function transfersTo(
  receipt: { status?: string; logs?: EvmLog[] } | null | undefined,
  token: string,
  to: string,
): { from: string; amount: bigint }[] {
  if (!receipt || receipt.status !== '0x1' || !Array.isArray(receipt.logs)) return []
  const wantTo = word(to)
  return receipt.logs
    .filter(
      (l) =>
        strip(l.address) === strip(token) &&
        Array.isArray(l.topics) &&
        l.topics.length === 3 &&
        strip(l.topics[0]) === strip(ERC20_TRANSFER_TOPIC) &&
        strip(l.topics[2]) === wantTo &&
        /^0x[0-9a-fA-F]{64}$/.test(l.data),
    )
    .map((l) => ({ from: ('0x' + strip(l.topics[1]).slice(24)) as Hex, amount: BigInt(l.data) }))
}

/**
 * Whether a receipt shows exactly `amount` of `token` reaching `to`. What a payer's own
 * browser asks about its own payment, where the figure is the one it just sent.
 */
export function transferInReceipt(
  receipt: { status?: string; logs?: EvmLog[] } | null | undefined,
  token: string,
  to: string,
  amount: bigint,
): boolean {
  return transfersTo(receipt, token, to).some((t) => t.amount === amount)
}

/** The `Transfer` topic, computed rather than recalled, for the tests' control. */
export function keccakOf(signature: string): Hex {
  return new ccc.HasherKeecak256().update(ccc.bytesFrom(signature, 'utf8')).digest() as Hex
}
