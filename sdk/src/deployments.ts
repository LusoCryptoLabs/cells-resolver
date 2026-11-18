import { deploymentFromJson, type Deployment } from './client.ts'

/**
 * The live deployments, one per network, so a package that only has a CCC client can
 * find the names: the `.cell` address resolver (resolver.ts) picks one by the client's
 * address prefix. The same objects the web app and the resolver are built with
 * (`ui/src/deployment.*.ts`, `services/gateway/src/deployment.*.ts`); a test holds the
 * three copies together.
 *
 * `dep` outpoints move on every in-place upgrade of a contract (the code hash does not),
 * so a build of this package is as current as its last release. Reading a name needs
 * only the type script, which does not move.
 */
export type CellNetwork = 'mainnet' | 'testnet'

export const CELLS_DEPLOYMENT_MAINNET = {
  deployTx: '0x522c91d3242450fdc5ae4cc6891d566de34d6f99663679f15e96c03d01c59268',
  account: {
    codeHash: '0xd96cee56727a2bb9a21408c154d278df5095fb4b4dcfd50516156424479bfe54',
    hashType: 'type',
    dep: { txHash: '0x3072417e797a39a6ead341947dae3350b47a1b7d6571b326d3d7f8fe7677bf0b', index: 0, depType: 'code' },
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
    dep: { txHash: '0x020f7f9e5607a8e7d1e94d4c1f3d5c52c204d2f53fb097f43ce7f524d2edcabb', index: 0, depType: 'code' },
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
  // The deeds cluster (decision 0036), made 2026-09-28.
  deedCluster: '0xb6353355cbd7ba969c7f4324277794d1d88623b59b6e2f59daabb87b41e568cc',
}

export const CELLS_DEPLOYMENT_TESTNET = {
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
  // The deeds cluster (decision 0036) and the ones before it, whose deeds still decode.
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

const parsed: Partial<Record<CellNetwork, Deployment>> = {}

/** The deployment of a network, as `CellsClient` takes it. */
export function deploymentFor(network: CellNetwork): Deployment {
  return (parsed[network] ??= deploymentFromJson(network === 'mainnet' ? CELLS_DEPLOYMENT_MAINNET : CELLS_DEPLOYMENT_TESTNET))
}
