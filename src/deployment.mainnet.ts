// The live deployment on Pudge, kept in sync with ui/src/deployment.ts and
// scripts/.testnet/deployment.json (see docs/TESTNET.md). Supersedes the 0x08d4b89d
// namespace, whose upgrade key was lost.
//
// `account.dep` MOVES on every in-place upgrade (the type-id and code hash stay, the
// code cell is respent), so a stale outpoint here stops resolving. Last moved by the
// 2026-09-05 audit fixes (cell-lock pin), tx 0x2dba4faf.
export const DEPLOYMENT = {
  deployTx: '0x522c91d3242450fdc5ae4cc6891d566de34d6f99663679f15e96c03d01c59268',
  account: {
    codeHash: '0xd96cee56727a2bb9a21408c154d278df5095fb4b4dcfd50516156424479bfe54',
    hashType: 'type',
    dep: { txHash: '0xe9122f59d58625f8040926606cfb6e244ca557e5f83fed7cc1e6dea6b81804fc', index: 0, depType: 'code' },
  },
  lock: {
    codeHash: '0x9f0f0ba142b58cba2fe047546cfd8481d5b1769437cd3533e6458b21b61871ab',
    hashType: 'type',
    dep: { txHash: '0x522c91d3242450fdc5ae4cc6891d566de34d6f99663679f15e96c03d01c59268', index: 1, depType: 'code' },
  },
  configTypeHash: '0xb4f4302965b7d6421481a520ee7eb5971a5e808c57a85a112841511492bf4cf6',
  sale: {
    codeHash: '0x086c8f4e9d4272e3dfbaca399792f730e6604591e87931ee6d67047a3c900879',
    hashType: 'type',
    dep: { txHash: '0x192db7b607f331ba09883f74e646fa7f983a7b0682d3e8dcc472599114d4bbaf', index: 0, depType: 'code' },
  },
  price: {
    codeHash: '0x97bf5f760cf72f918f13704d7184933b79d4ddc1fd85075762373e531152d4f9',
    hashType: 'type',
    dep: { txHash: '0xb3d2428eb96ff9ebbb77e9b3d73ce97118e847bbb2b8f9f86ec1cc7e8f3432b1', index: 0, depType: 'code' },
    typeHash: '0x3f1c9a47d666bd0b5f9a4b2b3afd7c20216280dbcfaddd13748780cdfcbb7586',
    typeArgs: '0xa7653aa180b0982f7f1d45761ced7c8d701d95e905684fcc7ae6fea4b5393a0d',
  },
  treasury: { codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8', hashType: 'type', args: '0xe1f601a90f38dc2b551ee97a2f3d83876b2e6707' },
  treasuryLockHash: '0x57d926a44d83fc13b21ce037b1e31f4223e3c867cfa3f60e1324d5bfd5cd742d',
}
