# Cells resolver gateway

A tiny public read API for `.cell` names. It keeps an in-memory snapshot of every live
name (refreshed on an interval) and answers lookups over HTTP with permissive CORS, so
any web app can resolve a name with one `fetch`, no CKB knowledge, no package, no key.

It is a cache in front of the chain: the blockchain is the source of truth, and every
answer can be re-derived from it. Reads here are for speed and convenience, not trust.

## Routes

| route | returns |
|---|---|
| `GET /resolve/:name` | everything about a name, decoded: `addresses` per chain, `fiber`, expiry, owner |
| `GET /resolve/:name?coinType=309` | one address by SLIP-44 coin type (`0` btc, `60` eth, `309` ckb, `501` sol) |
| `GET /reverse/:address?coinType=309` | the names that publish this address |
| `GET /avatar/:name` | the name's picture, as an ordinary image. A name with none gets the mark drawn from its id, so an `<img>` is never broken; `?fallback=none` returns 404 instead |
| `GET /profile/:name` | what a name says about itself: display name, bio, location, colour, links, and where its picture lives on chain |
| `GET /name/:name` | the raw on-chain record set |
| `GET /archive/:name` | the record set the resolver kept a copy of, so anyone holding it can publish it again. Named and re-checked by the chain's own commitment, so it can return what a name published or nothing, never something else |
| `GET /latest?limit=20` | the most recently registered names, newest first, with the block and time each was claimed |
| `GET /names` | every registered name |
| `GET /directory?q=&sale=&pay=&page=1&size=10` | the names a page at a time, in label order: `q` is part of a label, `sale=1` only names listed for sale, `pay` one of `ckb` `lightning` `fiber` `btc` `eth`. Each row has what a list shows and the outpoint it was read at; `exists` says whether the exact name `q` exists. Withdrawn names are left out of the rows, not out of `exists`. 503 until the first read |
| `GET /health` | snapshot freshness |
| `GET /` | this route list, as JSON |

`:name` accepts `alice` or `alice.cell`. A missing name returns `404 {registered:false}`.

## Example

```bash
curl https://testnet.cellula.id/api/resolve/alice.cell   # or the older host, cells-resolver.compartmentalizer.lusocryptolabs.com
```

```json
{
  "name": "alice.cell",
  "registered": true,
  "expires": "2027-09-04T11:14:29.000Z",
  "addresses": { "ckb": "ckt1qrfrwcdn..." },
  "fiber": null,
  "records": [ ... ]
}
```

Records ride in a witness, which is not live state, so no node is obliged to keep it. The
chain guarantees the content's *integrity* forever, because the cell commits to
`blake2b(records)`; it does not guarantee anyone still has the bytes. The resolver
therefore keeps a content-addressed copy of every record set it sees, files each one under
the commitment the chain holds, and re-hashes it on the way out. `/avatar/:name` falls back
to that copy only when the chain has stopped yielding the name at all, so a picture the
owner removed can never come back. `/archive/:name` hands the record set to anyone who
wants to publish it again and move the bytes into a recent block, which costs about
0.00002 CKB (`sdk/scripts/reseed-live.ts`). This is an availability aid, not a guarantee:
a guarantee costs 1 CKB per byte and is called cell data.

A name carries no registration date: `expiredAt` is the only date on the cell, and a
renewal moves it. `/latest` derives the real one by walking every transaction that
touched the account type script in block order, taking the first block each account id
appears in as an output. That scan is incremental and runs in the background, so the
route answers immediately and reports `complete: false` until the first pass finishes.

Put a name's picture on a page, with no library and no blockchain knowledge:

```html
<img src="https://<host>/avatar/telmo.cell" alt="telmo.cell" width="64" height="64">
```

Those bytes come out of the name's own transaction witness on CKB. Nothing is stored
here: this endpoint reads the same snapshot every other route does, and you can check it
against the chain yourself with `sdk/scripts/recover-picture.ts`, which uses only a
public node. Only PNG, JPEG, GIF and WebP are ever served, decided by sniffing the bytes
rather than by trusting the record, and never SVG, so an embedded avatar cannot carry
script.

Pay a name in three lines, no dependency:

```js
const r = await fetch(`https://<host>/resolve/${name}`).then((r) => r.json())
if (r.registered && r.addresses.ckb) sendCkbTo(r.addresses.ckb)
```

## Run it

```bash
cd services/gateway && npm install
node src/server.ts            # PORT=8787, REFRESH_MS=15000, RECONCILE_MS=600000 by default
SELFTEST=1 node src/server.ts # exercise the routes in-process and exit
```

## Deploy

It imports the SDK by relative path, so the Docker build context is the **repo root**:

```bash
docker build -f services/gateway/Dockerfile -t comp_cells-resolver:latest .
```

Keep `src/deployment.ts` in sync with `ui/src/deployment.ts` (both mirror
`scripts/.testnet/deployment.json`); a stale `account.dep` outpoint stops it resolving.

## The public copy

https://github.com/LusoCryptoLabs/cells-resolver is this folder as deployed, with the SDK from npm
(`cellula-sdk`) so it builds on its own: `docker build -t cells-resolver .`. It is a copy,
not a checkout: after a change here that reaches the hosts, carry it over (the 15 SDK
imports become `from 'cellula-sdk'`, `tsconfig.json` loses the `paths` mapping), run its
tests, and push. Bump and publish the SDK first if the change needs a newer one.
