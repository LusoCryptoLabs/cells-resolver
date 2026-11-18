// The live deployment on Pudge, kept in sync with ui/src/deployment.ts and
// scripts/.testnet/deployment.json (see docs/TESTNET.md). Supersedes the 0x08d4b89d
// namespace, whose upgrade key was lost.
//
// `account.dep` MOVES on every in-place upgrade (the type-id and code hash stay, the
// code cell is respent), so a stale outpoint here stops resolving. Last moved by the
// 2026-09-05 audit fixes (cell-lock pin), tx 0x2dba4faf.
export const DEPLOYMENT = {
  deployTx: '0x50b82bc32202debe7cca0ca27a9355e3b12f5ebfa8d643ec17d6044f891648ee',
  account: {
    codeHash: '0xe0706b176678181d982290d93dfcd82098e60cceaa4a87f10f32dcbcc91df1d9',
    hashType: 'type',
    dep: { txHash: '0xe3c204947c3f457410af242747146b3330a05d9f02d095b2636ac9368a3acce4', index: 0, depType: 'code' },
  },
  lock: {
    codeHash: '0xede6a3d80717c3d7927eea678d095abbe68dbb08ca6fdbbbdd9de906455a4afd',
    hashType: 'type',
    dep: { txHash: '0x968ec1a8cb35aa093b1bede3b41ad769f499b481db32662645b8bd95fec5a30a', index: 1, depType: 'code' },
  },
  configTypeHash: '0x2510c78057479c9b023fe6e98ce43979e92a135333a8e1b763e4cf8511fd84fa',
  sale: {
    codeHash: '0x498ab6b49b6b25b3c47fcea74bd8a4447bc4efda6417809152a846e058ad0ae4',
    hashType: 'type',
    dep: { txHash: '0x03507c8cbe51212d10bda95575a121afeccdbe156366c7a6db95a3e90878b0fc', index: 0, depType: 'code' },
  },
  price: {
    codeHash: '0xe1057caf161b3c720fcdb80190e89c6efc36b6b4256b3c99635fda63a9dd4294',
    hashType: 'type',
    dep: { txHash: '0xec7c0690466942c6a75c6de0eec3e544505e3b77bf131847f233f01c26565c77', index: 0, depType: 'code' },
    typeHash: '0x6b3a6afbdbfd73f604372c57417bcfe66fb297375ed127052746696b6b7fa6bc',
    typeArgs: '0x1f479f068dbab1d2ab8954f8cc7900bbf3880590def2d905d8343966db596982',
  },
  treasury: { codeHash: '0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac', hashType: 'type', args: '0x000140911fa94eaef8c1d0eca81b23e1972ecb0548dc' },
  treasuryLockHash: '0xd9d177037d0888e09330bf0dd18e98c534ea3479b4376911d0a5279ead21e0f8',
  // The deeds cluster (decision 0036), under the deeds key. A cluster's description is
  // what draws the card and cannot be rewritten, so a change to the card is a new
  // cluster; deeds minted into an older one keep decoding against it. This one draws the
  // whole mark above the band; the one before cut off its first row and its last two
  // (2026-09-27).
  deedCluster: '0xd89ed75a79a6e3595427da2b51415666c46e7c2ae34a95920a25559ba9b836e2',
  // The six before it, oldest first. Their deeds still decode, and one that no longer
  // holds a name can still be ended.
  previousDeedClusters: [
    '0x95368ad3ee9cd49c6a27a118b1b95325c36689ddc8257d7663e5416db271f0ac',
    '0xdbc074b9acd1645261bc5e9697ce8a660b85b388bbdeb2e67792b4ce03aaea30',
    '0x8414e33c4bdce9750332d24e702471c18558fa0595989dc2d900cb1dbbff675b',
    '0x6bac7a49ee7c4f3ccc369c3553566433ad5635d02e5e8c41bfaea90dbd90a1dd',
    '0x05641d080ea0619bf11f88911be2013adb591b1e65abde5957a83743ffe1641b',
    '0x4fea5736f9e4e50b822139a68443f4a3a7ac45a45fb690162fdc92df6e59c441',
  ],
}
