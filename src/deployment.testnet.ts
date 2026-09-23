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
    dep: { txHash: '0x57ed78e4b2d7c07372719ef6177b6fd3b33ea63272e7d63f25ab277d3c764ae6', index: 0, depType: 'code' },
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
    dep: { txHash: '0x7b2c9f76950889df83077c6540c55a521ab67029b4b086df469df4c72175714f', index: 0, depType: 'code' },
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
}
