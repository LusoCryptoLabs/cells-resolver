/**
 * Which locks may stand for a name.
 *
 * The contracts take any input under a name's owner lock as the owner's consent: to
 * transfer it, rewrite its records, mint a sub-name, and, for a listed name, the seller's
 * way out of the sale lock (decision 0012). The manager's lock is taken the same way for an
 * edit. That is consent only while spending a cell under the lock needs its owner's
 * signature. Some locks let anyone spend one without it: the anyone-can-pay lock opens for
 * any transaction that pays the cell back at least what it held. Under such a lock a
 * stranger makes a cell of their own there, spends it back to the same lock in their own
 * transaction, and the contract reads the owner acting (review of 2026-09-27, proven in a
 * mock VM). A deed inherits its holder's lock, so the same goes for whoever holds one.
 *
 * The contracts are to refuse these themselves in an upgrade. Until then, and for any
 * client after, `CellsClient` refuses to make one a name's owner, manager or seller, or a
 * deed's holder, and the app and the resolver ask this same function.
 */
import { ccc } from '@ckb-ccc/core'
import type { Hex } from './codec.ts'
import type { Deployment } from './client.ts'

/**
 * The code hashes of the locks with an anyone-can-pay path, as deployed on each network and
 * as CCC's known scripts give them (`permissive-lock.test.ts` holds the two to each other),
 * plus the older testnet deployments that still hold cells. All of these are type ids. Both
 * networks are listed whatever the client's, so a script built for the other one is judged
 * the same way. The same list as the contracts carry (cells-core `lets_anyone_spend`).
 */
const AS_DEPLOYED: Record<'AnyoneCanPay' | 'PWLock' | 'OmniLock', Hex[]> = {
  // RFC 0026, mainnet then testnet, then the older testnet deployment (2026-09-27).
  AnyoneCanPay: [
    '0xd369597ff47f29fbc0d47d2e3775370d1250b85140c670e4718af712983a2354',
    '0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356',
    '0x86a1c6987a4acbe1a887cca4c9dd2ac9fcb07405bbeda51b861b18bbf7492c4b',
  ],
  // The Portal Wallet's lock. Its README: it "integrates the features of anyone-can-pay,
  // which is consistent with the official anyone-can-pay".
  PWLock: [
    '0xbf43c3602455798c1a61a596e0d95278864c552fafe231c063b3fabf97a8febc',
    '0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63',
  ],
  // RFC 0042. Permissive only in anyone-can-pay mode, below. Mainnet, testnet, and the
  // older testnet deployment.
  OmniLock: [
    '0x9b819793a64463aed77c615d6cb226eea5487ccfc0783043a587254cda2b6f26',
    '0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb',
    '0x79f90bb5e892d80dd213439eeab551120eb417678824f282b4ffb5f21bad2e1e',
  ],
}

/**
 * The same binaries by their data hash, which is how a lock names them when it does not go
 * through a type id (`data`, `data1`): the anyone-can-pay bytes both networks run today,
 * the older anyone-can-pay bytes, and PW-Lock's and Omnilock's on each network. Read from
 * both chains on 2026-09-27.
 */
const BY_DATA: Record<'AnyoneCanPay' | 'PWLock' | 'OmniLock', Hex[]> = {
  AnyoneCanPay: [
    '0xcd69ba816f7471e59110058aa37387c362ed9a240cd178f7bb1ecee386cb31e6',
    '0x0fb343953ee78c9986b091defb6252154e0bb51044fd2879fde5b27314506111',
  ],
  PWLock: [
    '0xd6a5a0edb152e88e8bbc702e164441cb3890fae35da672b408d28ca9a1bde3ee',
    '0xeffe377419256d150d68368d7cb5731edad39d1805a8c2c73ce8e9615b9f9878',
  ],
  OmniLock: [
    '0x768f306681da232ceb0b94f436c5f813377179762a831c5ad8797bd4fd2d118d',
    '0x6b29b6f10346b43c540e53806ba88ba0fe3a0c3a29d7448ef555840c8f8318fa',
  ],
}

/** Omnilock's args are 21 bytes of auth, then a byte of flags; this bit is anyone-can-pay mode (RFC 0042). */
const OMNILOCK_FLAGS_AT = 21
const OMNILOCK_ANYONE_CAN_PAY = 0b0000_0010

/**
 * Why `lock` cannot stand for a name's owner, manager or seller, or a deed's holder,
 * as a few words naming the kind of lock, or null when it can.
 *
 * The rule, in full: refused are the anyone-can-pay lock and PW-Lock, whatever their args;
 * Omnilock when the anyone-can-pay bit is set in its flags byte; a lock that always opens
 * (CCC's `AlwaysSuccess`, by any of the data hash types); and, when `dep` is given, the
 * deployment's own name-cell lock, which always opens too. The first three are matched on
 * the code hash alone, as the contracts match them: the type ids of both networks' current
 * and older deployments, the data hashes of their binaries, and whatever the client's known
 * scripts say.
 *
 * A lock that hands its decision to another script (the proxy locks, Omnilock's delegated
 * auth) is not judged here: that depends on a script its args only name.
 */
export async function permissiveLock(
  client: ccc.Client,
  lockLike: ccc.ScriptLike,
  dep?: Pick<Deployment, 'lock'>,
): Promise<string | null> {
  const lock = ccc.Script.from(lockLike)
  const codeHash = lock.codeHash.toLowerCase()
  const known = async (s: ccc.KnownScript) => {
    try {
      return await client.getKnownScript(s)
    } catch {
      return null
    }
  }
  const listed = async (name: keyof typeof AS_DEPLOYED) => {
    const k = await known(ccc.KnownScript[name])
    if (k && codeHash === k.codeHash.toLowerCase()) return true
    return AS_DEPLOYED[name].includes(codeHash as Hex) || BY_DATA[name].includes(codeHash as Hex)
  }
  if (await listed('AnyoneCanPay')) return 'the anyone-can-pay lock'
  if (await listed('PWLock')) return 'PW-Lock, the Portal Wallet lock'
  if (await listed('OmniLock')) {
    const args = ccc.bytesFrom(lock.args)
    return args.length > OMNILOCK_FLAGS_AT && (args[OMNILOCK_FLAGS_AT] & OMNILOCK_ANYONE_CAN_PAY) !== 0
      ? 'Omnilock in anyone-can-pay mode'
      : null
  }
  const always = await known(ccc.KnownScript.AlwaysSuccess)
  if (always && codeHash === always.codeHash.toLowerCase() && lock.hashType !== 'type') return 'a lock that always opens'
  if (dep && codeHash === dep.lock.codeHash.toLowerCase() && lock.hashType === dep.lock.hashType)
    return 'the lock every name cell sits under'
  return null
}
