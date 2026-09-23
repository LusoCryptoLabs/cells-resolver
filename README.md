# cells-resolver

The HTTP read API for `.cell` names on Nervos CKB, as it runs at
[cellula.id/api](https://cellula.id/api) and
[testnet.cellula.id/api](https://testnet.cellula.id/api). One `fetch` instead of a chain
read, CORS open, no key.

It is a cache in front of the chain. It keeps a snapshot of every live name in memory,
rebuilds it every fifteen seconds from a public CKB node, and answers from that. The chain
is the source of truth, and every answer says which cell it came from so you can check
it against any node without trusting this service.

## What an answer proves

`GET /resolve/alice.cell` returns the name decoded (owner, expiry, payout addresses per
chain, records) and a `proof`:

```json
"proof": {
  "outPoint": { "txHash": "0x…", "index": 1 },
  "type": { "codeHash": "0x…", "hashType": "type", "args": "0x…" },
  "dataHash": "0x…",
  "network": "mainnet",
  "how": "get_live_cell(outPoint, true) on any CKB node: the cell must be live, its type must be this one, and blake2b(its data) must be dataHash. …"
}
```

That is the whole check: the cell is live, its type script is the namespace, and the data
hashes to what you were told. The layout of the data and of the records is in the
[contracts' spec](https://github.com/LusoCryptoLabs/cells-contracts/blob/main/docs/SPEC.md),
and `llms-full.txt` on either host has a reader in plain JavaScript that needs nothing of
ours.

The service holds no keys and signs nothing. It can be down, stale by a refresh, rate
limited, or wrong, and none of those change who owns a name. If an answer would move
money, read the cell.

## Run your own

A second instance anywhere is a complete instance: there is no database and nothing to
sync. Node 24 or later.

```sh
npm ci
CKB_NETWORK=mainnet node src/server.ts
```

Or with Docker:

```sh
docker build -t cells-resolver .
docker run -e CKB_NETWORK=mainnet -p 8787:8787 -v cells-data:/app/data cells-resolver
curl localhost:8787/health
```

`/health` says `ok: true` once the first snapshot is in. The volume is optional:
`/app/data` holds the record archive, the dispute log and the short-link store, and the
service runs without it.

Everything is an environment variable, all optional:

| | default | |
|---|---|---|
| `CKB_NETWORK` | `testnet` | `mainnet` or `testnet`; picks the node, the namespace and the label |
| `CKB_RPC` | the public node for that network | a JSON-RPC endpoint, yours if you have one |
| `PORT` | `8787` | |
| `REFRESH_MS` | `15000` | how often the snapshot is rebuilt |
| `REFRESH_TIMEOUT_MS` | `30000` | give up on a refresh that hangs |
| `RATE_MAX` | `120` | requests per window per address |
| `RATE_WINDOW_MS` | `60000` | |
| `PRIMARY_TTL_MS` | `60000` | how long a reverse lookup is cached |
| `DATA_DIR` | `/app/data` | archive, disputes, short links |
| `ARCHIVE_DIR` | `$DATA_DIR/archive` | the content-addressed copy of every record set seen |
| `SEALED_DIR` | `$DATA_DIR/sealed` | sealed payment requests behind short links |
| `SEALED_PER_HOUR` | `60` | short links one address may leave per hour |
| `LOCK_MS` | `600000` | how often the quantum lock's code is checked |
| `QUANTUM_MS` | `180000` | how often quantum-owned names are rescanned |
| `GATEWAY_DOMAIN` | empty | the domain names get a page and a Lightning Address under, `<name>.<domain>`; empty disables it |
| `SITE_DOMAIN` | empty | the separate host a name's own website answers on; empty disables sites |
| `APP_URL` | `https://testnet.cellula.id` | where links back to the app point |
| `SELFTEST` | unset | `1` exercises the routes in-process and exits |

`src/deployment.testnet.ts` and `src/deployment.mainnet.ts` are the live namespaces: the
type scripts and code cells the service reads. They are the same values
[TRUST.md](https://github.com/LusoCryptoLabs/cells-contracts/blob/main/docs/TRUST.md)
publishes for the contracts.

## Routes

`GET /` lists every route with a sentence each, and `GET /openapi.json` is the same list as
an OpenAPI 3.1 document, built per request so it names the host that answered. A test
fails when a route is added to the server and forgotten there.

The ones most integrations use:

| route | |
|---|---|
| `GET /resolve/:name` | everything about a name, decoded, with its proof |
| `GET /resolve/:name?coinType=309` | one address by SLIP-44 coin type (`0` btc, `60` eth, `309` ckb) |
| `GET /primary/:address` | the address's own name, forward-verified, or `null` |
| `POST /primary` | the same for up to fifty addresses, `{addresses}` in, results in order |
| `GET /reverse/:address` | names that publish this address as a payout |
| `GET /avatar/:name`, `GET /cover/:name` | the name's picture and banner as ordinary images, drawn from its id when it has none |
| `GET /profile/:name` | display name, bio, links |
| `GET /name/:name` | the raw record set |
| `GET /latest`, `GET /names`, `GET /expiring`, `GET /market` | lists |
| `GET /price` | the current registration price factor, from the price cell |
| `GET /verify` | are the running contracts the published, reproducible source |
| `GET /health` | snapshot age, network, price cell, the lock and wallet watches |

`:name` accepts `alice` or `alice.cell`. A name nobody holds is `404 {registered: false}`.
Failures should be treated as no name, a `200` that is not JSON included: a host that is
up but not serving the API answers HTML with a `200`.

## What it adds that the chain cannot carry

A name's cell cannot say whether it is under a dispute notice, whether its owner's key is
post-quantum, or when it was first registered, so the service works those out and says
where from:

- `dispute` on `/resolve`, and `GET /disputes`: the public log of notices and
  withdrawals. A withdrawn name answers `451` here and nowhere else; the chain does not
  care.
- `quantumOwner` on `/resolve`, and `GET /quantum`: proven from the chain by listing the
  cells under the SPHINCS+ lock and matching them to names. It proves the positive only.
- The lock watch and the wallet watch, on `/health` and `/quantum`: is the code behind the
  quantum lock, and behind the wallet lock most owners use, still the code recorded here?
  Both follow type ids across upgrades, so a redeploy of identical bytes is not a change,
  and a node that will not answer reports `unchecked` rather than an alarm.
- `/latest` derives registration dates by walking the type script's history in block
  order. The scan is incremental and reports `complete: false` until its first pass ends.
- `POST /r` and `GET /r/:id`: the store behind a short payment link. The blob is
  ciphertext sealed by the sender and the id is a hash of the key, which travels in the
  link's fragment and never reaches the server.

## Development

```sh
npm ci
npm run typecheck
npm test
```

The tests are unit tests over the pieces that do not need a chain: proof shapes, the
OpenAPI document against the handler, primary-name rules, the wallet fingerprint, domain
proofs, counts. `SELFTEST=1 node src/server.ts` runs the routes against the live test
network and exits.

This is the service as deployed. It is developed alongside the app and the SDK, and
changes land here when they land on the hosted instances.

## Related

- [cells-contracts](https://github.com/LusoCryptoLabs/cells-contracts): the on-chain
  scripts, their spec, and the reproducible builds these deployment files point at.
- [cellula-sdk](https://www.npmjs.com/package/cellula-sdk): the client library this
  service reads names with, and the write path for apps that register and manage them.
- [ckb-script-pitfalls](https://github.com/LusoCryptoLabs/ckb-script-pitfalls): the bug
  classes met while building this, as a catalogue.

MIT.
