// The API described so a machine can read it: served at /openapi.json, and the same
// document a code generator, a typed client or an agent is given when it asks what
// this service can do. The prose list at `/` stays, because a person opening the root
// URL in a browser wants sentences; this is the other audience.
//
// It is written by hand rather than generated, because the server is a plain handler
// with no decorators to read, and a generated-from-nothing document would drift just
// as easily. The defence against drift is `test/openapi.test.ts`, which asks the
// running server for every path in here and fails when one answers 404, and which
// checks that every route the root document advertises has an entry below.
//
// The base URL is passed in rather than baked, because the same code serves the
// testnet host today and a mainnet one later, and a document that names the wrong
// server sends every generated client to the wrong chain.

const RECORD = {
  type: 'object',
  description: 'One published record. `value` is hex of the bytes as the chain holds them.',
  properties: {
    key: { type: 'string', example: 'address.309' },
    label: { type: 'string', description: 'An optional label distinguishing two records with the same key.', example: '' },
    value: { type: 'string', example: '0x636b74...' },
    ttl: { type: 'integer', example: 300 },
  },
  required: ['key', 'label', 'value', 'ttl'],
} as const

const NOT_REGISTERED = {
  type: 'object',
  properties: {
    name: { type: 'string', example: 'nobody.cell' },
    registered: { type: 'boolean', enum: [false] },
  },
  required: ['name', 'registered'],
} as const

const WITHDRAWN = {
  type: 'object',
  description:
    'The name exists on chain but is withdrawn from this service under the disputes policy. The chain is unaffected and still holds it.',
  properties: {
    name: { type: 'string' },
    withdrawn: { type: 'boolean', enum: [true] },
    reason: { type: 'string' },
    policy: { type: 'string', format: 'uri' },
  },
  required: ['name', 'withdrawn'],
} as const

const ERROR = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
} as const

/** The document, with `servers` pointing at wherever this instance actually answers. */
export function openapiSpec(origin: string, network: string) {
  const name = {
    name: 'name',
    in: 'path',
    required: true,
    description: 'The name, with or without the .cell suffix.',
    schema: { type: 'string', example: 'satoshi.cell' },
  }
  const ok = (schema: unknown, description = 'ok') => ({
    description,
    content: { 'application/json': { schema } },
  })
  const notFound = {
    404: { description: 'No such name.', content: { 'application/json': { schema: NOT_REGISTERED } } },
    451: { description: 'Withdrawn under the disputes policy.', content: { 'application/json': { schema: WITHDRAWN } } },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'cellula.id resolver',
      version: '1.0.0',
      summary: 'Resolve .cell names on Nervos CKB over HTTP.',
      description: [
        'A read-only cache in front of the Nervos blockchain, which is the source of truth.',
        'Every answer here can be derived from the chain by anyone, with no permission and',
        'without this service: see /verify, which checks the running contract against its',
        'published source, and the resolver document in the repository, which explains how',
        'to read a name with none of our code at all.',
        '',
        'No key, no account and no registration. Cross-origin requests are allowed from any',
        'origin, so a browser can call this directly. Reads are rate limited per address.',
      ].join('\n'),
      license: { name: 'MIT' },
    },
    servers: [{ url: origin, description: `${network} resolver` }],
    tags: [
      { name: 'names', description: 'Reading a name.' },
      { name: 'addresses', description: 'Going the other way, from an address to a name.' },
      { name: 'service', description: 'The state of this instance and of the contracts it reads.' },
      { name: 'payments', description: 'Payment requests and the Lightning Address bridge.' },
    ],
    paths: {
      '/resolve/{name}': {
        get: {
          tags: ['names'],
          operationId: 'resolve',
          summary: 'Everything a name publishes, decoded.',
          description:
            'With `coinType`, one address instead: the answer is then `{name, coinType, value}` and `value` is null when the name publishes no address for that chain.',
          parameters: [
            name,
            {
              name: 'coinType',
              in: 'query',
              required: false,
              description: 'A SLIP-44 coin type. 0 bitcoin, 60 ethereum, 309 ckb; any other coin type a name publishes is answered too.',
              schema: { type: 'string', example: '60' },
            },
          ],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                name: { type: 'string' },
                registered: { type: 'boolean' },
                expiredAt: { type: 'integer', description: 'Unix seconds.' },
                expires: { type: 'string', format: 'date-time' },
                expired: { type: 'boolean' },
                owner: { type: 'string', description: "The first twenty bytes of the owner's lock hash." },
                addresses: {
                  type: 'object',
                  description: 'Payout addresses by short chain name, already decoded from the records.',
                  additionalProperties: { type: 'string' },
                  example: { ckb: 'ckb1...', eth: '0x...' },
                },
                fiber: { type: ['object', 'null'], description: 'The Fiber node and address the name publishes.' },
                lightning: {
                  type: ['object', 'null'],
                  description: 'Its Lightning Address and BOLT12 offer. An object, not a string: it was documented as a string until 2026-09-21, so a client generated before then has the wrong type here.',
                  properties: {
                    address: { type: ['string', 'null'], description: 'user@host, LUD-16.' },
                    offer: { type: ['string', 'null'], description: 'lno1…, reusable and non-expiring.' },
                  },
                },
                records: { type: 'array', items: RECORD },
                proof: {
                  type: 'object',
                  description:
                    'Where this answer came from on chain, so it can be checked against any CKB node: the outpoint, the full type script, the data hash, and the block that committed the cell.',
                  properties: {
                    outPoint: {
                      type: 'object',
                      properties: { txHash: { type: 'string' }, index: { type: 'integer' } },
                    },
                    type: {
                      type: 'object',
                      description: 'The whole type script. Its args are the namespace, and the right code in the wrong namespace is a different protocol.',
                      properties: { codeHash: { type: 'string' }, hashType: { type: 'string' }, args: { type: 'string' } },
                    },
                    dataHash: { type: 'string', description: 'blake2b of the cell data this answer decoded.' },
                    blockNumber: {
                      type: ['integer', 'null'],
                      description: 'The block that committed the transaction behind outPoint. A light client can fetch the transaction by hash and watch for the cell being spent from here, instead of scanning from genesis.',
                    },
                    blockHash: { type: ['string', 'null'], description: 'The hash of that block.' },
                    network: { type: 'string' },
                    how: { type: 'string', description: 'What to do with all of this, in one sentence.' },
                  },
                },
                domain: {
                  type: ['object', 'null'],
                  description:
                    'A website that answers for this name, when one does. Show nothing unless `verdict` is `answers`: `silent` means the name claims a domain that does not confirm it, and printing the claim anyway would read as a verification nobody performed.',
                  properties: {
                    claimed: { type: 'string', description: 'The bare host the name claims, from its own proof.domain record.' },
                    verdict: { type: 'string', enum: ['answers', 'silent', 'unchecked'] },
                    url: { type: ['string', 'null'], description: "Where the website's half is, so a reader can confirm it without this API." },
                    how: { type: ['string', 'null'], enum: ['well-known', 'dns', null] },
                    boundToOwner: { type: 'boolean', description: 'True when the website named this owner too, so a transfer breaks the proof.' },
                    checkedAt: { type: 'integer', description: 'Unix milliseconds of the last look that produced a verdict.' },
                  },
                },
                dispute: { type: ['object', 'null'], description: 'A notice against this name, if one is logged.' },
                quantumOwner: {
                  type: 'boolean',
                  description:
                    'True when the owner is a key proven post-quantum. False means not shown to be, never shown not to be.',
                },
              },
              required: ['name', 'registered', 'addresses', 'records'],
            }),
            ...notFound,
          },
        },
      },
      '/name/{name}': {
        get: {
          tags: ['names'],
          operationId: 'rawName',
          summary: 'The cell as it stands on chain, undecoded.',
          parameters: [name],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                name: { type: 'string' },
                label: { type: 'string' },
                id: { type: 'string', description: 'The twenty-byte id derived from the label.' },
                next: { type: 'string', description: 'The next id in the uniqueness list.' },
                expiredAt: { type: 'integer' },
                ownerLockHash: { type: 'string' },
                records: { type: 'array', items: RECORD },
                capacity: { type: 'string', description: 'Shannons, as a decimal string.' },
                outPoint: { type: 'object', properties: { txHash: { type: 'string' }, index: { type: 'integer' } } },
              },
              required: ['name', 'label', 'id', 'expiredAt', 'ownerLockHash', 'records'],
            }),
            ...notFound,
          },
        },
      },
      '/profile/{name}': {
        get: {
          tags: ['names'],
          operationId: 'profile',
          summary: 'What a name says about itself.',
          parameters: [name],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                name: { type: 'string' },
                displayName: { type: ['string', 'null'] },
                bio: { type: ['string', 'null'] },
                location: { type: ['string', 'null'] },
                accent: { type: ['string', 'null'], description: 'A colour the name chose.' },
                avatar: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', example: '/avatar/satoshi.cell' },
                    published: { type: 'boolean', description: 'False means the picture below is the mark drawn from the id.' },
                    type: { type: ['string', 'null'] },
                    bytes: { type: 'integer' },
                    witnessOf: { type: ['string', 'null'] },
                  },
                },
                cover: {
                  type: 'object',
                  description: 'The wide picture across the top of the page, if the name publishes one.',
                  properties: {
                    path: { type: 'string', example: '/cover/satoshi.cell' },
                    published: { type: 'boolean', description: 'False means the band below is the one drawn from the id.' },
                    type: { type: ['string', 'null'] },
                    bytes: { type: 'integer' },
                    witnessOf: { type: ['string', 'null'] },
                  },
                },
                links: { type: 'array', items: { type: 'object' } },
                other: { type: 'array', items: RECORD },
              },
              required: ['name', 'avatar', 'links'],
            }),
            ...notFound,
          },
        },
      },
      '/avatar/{name}': {
        get: {
          tags: ['names'],
          operationId: 'avatar',
          summary: "The name's picture, as an ordinary image.",
          description:
            'Put it straight in an `img` tag. A name that publishes no picture gets the mark drawn from its id, unless `fallback=none`. Carries an ETag, so a repeat request answers 304.',
          parameters: [
            name,
            { name: 'fallback', in: 'query', required: false, schema: { type: 'string', enum: ['none'] } },
            { name: 'raster', in: 'query', required: false, description: 'Ask for PNG instead of SVG.', schema: { type: 'string', enum: ['1'] } },
          ],
          responses: {
            200: { description: 'The image.', content: { 'image/svg+xml': {}, 'image/png': {}, 'image/jpeg': {}, 'image/webp': {} } },
            304: { description: 'Unchanged since the ETag you sent.' },
            404: { description: 'No such name, or it publishes no picture and you asked for no fallback.' },
            451: { description: 'Withdrawn under the disputes policy.' },
          },
        },
      },
      '/cover/{name}': {
        get: {
          tags: ['names'],
          operationId: 'cover',
          summary: "The name's cover picture, as an ordinary image.",
          description:
            'The wide band across the top of the page. Like the avatar it always answers: a name that publishes no cover gets the band drawn from its id, unless `fallback=none`. Carries an ETag, so a repeat request answers 304.',
          parameters: [
            name,
            { name: 'fallback', in: 'query', required: false, schema: { type: 'string', enum: ['none'] } },
            { name: 'raster', in: 'query', required: false, description: 'Ask for PNG instead of SVG.', schema: { type: 'string', enum: ['1'] } },
          ],
          responses: {
            200: { description: 'The image.', content: { 'image/svg+xml': {}, 'image/png': {}, 'image/jpeg': {}, 'image/webp': {} } },
            304: { description: 'Unchanged since the ETag you sent.' },
            404: { description: 'No such name, or it publishes no cover and you asked for no fallback.' },
            451: { description: 'Withdrawn under the disputes policy.' },
          },
        },
      },
      '/archive/{name}': {
        get: {
          tags: ['names'],
          operationId: 'archive',
          summary: 'The kept copy of a record set, so it can be published again.',
          description:
            "A name's records live in a witness, which a node may prune. This returns the copy we kept, with the chain's own commitment over it, so anyone holding it can put the bytes back in a recent block. Nothing here is signed by us; the chain accepts the records only if they hash to that commitment.",
          parameters: [name],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                name: { type: 'string' },
                commitment: { type: 'string' },
                current: { type: ['boolean', 'null'], description: 'Does the chain still agree this is the current set?' },
                bytes: { type: 'integer' },
                records: { type: 'array', items: RECORD },
                witness: { type: 'string', description: 'The witness bytes, hex.' },
                note: { type: 'string' },
              },
              required: ['name', 'commitment', 'records', 'witness'],
            }),
            404: { description: 'Nothing archived for this name.', content: { 'application/json': { schema: ERROR } } },
            451: { description: 'Withdrawn under the disputes policy.', content: { 'application/json': { schema: WITHDRAWN } } },
          },
        },
      },
      '/primary/{address}': {
        get: {
          tags: ['addresses'],
          operationId: 'primary',
          summary: 'The name an address chose for itself, verified both ways.',
          description:
            'Reads the address\'s reverse record, then resolves the name it claims and returns it only if that name is actually owned by the same address. A forged record answers null. Takes a CKB address (ckb1… on mainnet, ckt1… on the test network) or an Ethereum address (0x and forty hex digits), which is asked as the two OmniLock locks that key owns CKB under, the same two CCC\'s EVM signer derives; a Bitcoin address, or a key behind a passkey lock, cannot be derived from its address and is a 400. An expired name keeps answering here, flagged, until somebody else registers it.',
          parameters: [
            { name: 'address', in: 'path', required: true, description: 'A CKB address, or an Ethereum 0x address. Anything else answers 400.', schema: { type: 'string', example: 'ckb1qzda0cr0...' } },
          ],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                address: { type: 'string' },
                name: { type: ['string', 'null'] },
                expiredAt: { type: ['integer', 'null'], description: 'When the registration runs out, in seconds since the epoch. Null when there is no name.' },
                expires: { type: ['string', 'null'], description: 'The same instant as ISO 8601.' },
                expired: { type: 'boolean', description: 'Whether that instant has passed. An expired name is still returned, with this true, until somebody else registers it. Same three fields, same meaning, as /resolve.' },
              },
              required: ['address', 'name', 'expiredAt', 'expires', 'expired'],
            }),
            400: { description: 'The address could not be read.', content: { 'application/json': { schema: ERROR } } },
          },
        },
      },
      '/primary': {
        post: {
          tags: ['addresses'],
          operationId: 'primaryBatch',
          summary: 'The same answer as GET /primary/{address}, for up to fifty addresses at once.',
          description:
            'Send `{ "addresses": [...] }` and get `{ "results": [...] }` in the same order, each entry shaped exactly like a single answer. An address this side cannot read does not fail the batch: that entry carries `error` and the others are answered. For a list on a page, an explorer, a contacts list: one call instead of one per row, against the same per-IP limit.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { addresses: { type: 'array', items: { type: 'string' }, maxItems: 50 } },
                  required: ['addresses'],
                },
              },
            },
          },
          responses: {
            200: ok({
              type: 'object',
              properties: {
                results: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      address: { type: 'string' },
                      name: { type: ['string', 'null'] },
                      expiredAt: { type: ['integer', 'null'] },
                      expires: { type: ['string', 'null'] },
                      expired: { type: 'boolean' },
                      error: { type: 'string', description: 'Only on an address that could not be read.' },
                    },
                    required: ['address', 'name', 'expiredAt', 'expires', 'expired'],
                  },
                },
              },
              required: ['results'],
            }),
            400: { description: 'Not an addresses array, or more than fifty of them.', content: { 'application/json': { schema: ERROR } } },
            413: { description: 'More than sixteen kilobytes.', content: { 'application/json': { schema: ERROR } } },
          },
        },
      },
      '/reverse/{address}': {
        get: {
          tags: ['addresses'],
          operationId: 'reverse',
          summary: 'Every name that publishes this address as a payout.',
          description: 'Unverified by nature: anyone may publish anyone\'s address. Use /primary for the claim a wallet makes about itself. This is the route for an address that is not a CKB one: an Ethereum or Bitcoin address cannot be asked on /primary, but it can be looked up here as a payout somebody publishes.',
          parameters: [
            { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'coinType', in: 'query', required: false, description: 'SLIP-0044 coin type: 309 is CKB (the default), 60 is Ethereum, 0 is Bitcoin.', schema: { type: 'string', default: '309' } },
          ],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                address: { type: 'string' },
                coinType: { type: 'string' },
                names: { type: 'array', items: { type: 'string' } },
              },
              required: ['address', 'coinType', 'names'],
            }),
          },
        },
      },
      '/market': {
        get: {
          tags: ['names'],
          operationId: 'market',
          summary: 'Every name currently listed for sale, cheapest first.',
          description:
            'The listings are cells under a public lock, so this is not the only way to read them. It is the way that ' +
            'carries this service\u2019s disputes policy: a name under a notice is flagged and a withdrawn name is absent, ' +
            'so anything mirroring this inherits both. The asking price is not ours: it lives in the sale lock\u2019s own ' +
            'args, which means it is inside the lock hash and inside what the name records as its owner, so it has been ' +
            'on the chain since the listing and nobody can move it without an act the seller signs. The split is the ' +
            'arithmetic the contract enforces on any purchase, read back, not a quote.',
          responses: {
            200: ok({
              type: 'object',
              properties: {
                ready: { type: 'boolean' },
                count: { type: 'integer' },
                asOf: { type: 'string', format: 'date-time', description: 'when the listings were last scanned' },
                note: { type: 'string' },
                listings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', example: 'satoshi.cell' },
                      label: { type: 'string', example: 'satoshi' },
                      priceShannons: { type: 'string', description: 'what the buyer brings; a string, because a price can exceed 2^53' },
                      priceCkb: { type: 'number' },
                      toSellerCkb: { type: 'number' },
                      toTreasuryCkb: { type: 'number' },
                      seller: { type: 'string', description: 'the seller lock hash, which is what the name records as its owner' },
                      outPoint: { type: 'string', description: 'the offer cell, to go and look at it yourself' },
                      expiresAt: { type: 'string', format: 'date-time' },
                      notice: { type: ['string', 'null'], description: 'the class of claim, where a notice stands' },
                    },
                  },
                },
              },
            }),
            503: ok({
              type: 'object',
              properties: { ready: { type: 'boolean' }, note: { type: 'string' } },
              description: 'the listings have not been scanned yet, which is not the same as nothing being for sale',
            }),
          },
        },
      },
      '/names': {
        get: {
          tags: ['names'],
          operationId: 'allNames',
          summary: 'Every registered name.',
          responses: {
            200: ok({
              type: 'object',
              properties: { count: { type: 'integer' }, names: { type: 'array', items: { type: 'string' } } },
              required: ['count', 'names'],
            }),
          },
        },
      },
      '/.well-known/lnurlp/{name}/invoice': {
        get: {
          tags: ['payments'],
          operationId: 'lnurlpInvoice',
          summary: 'An invoice from the wallet the name publishes.',
          description:
            'The second half of LUD-16. Forwarded to the wallet the name publishes and returned byte for byte, because the invoice commits to that wallet’s own metadata: no money passes through here and nothing is re-signed. Served but undocumented until 2026-09-16, when the developers page and this document were compared against each other.',
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'amount', in: 'query', required: true, schema: { type: 'integer' }, description: 'Millisats.' },
            { name: 'comment', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'The wallet’s own answer, unchanged: `{ pr }` and whatever else it sent.' },
            404: { description: 'The name does not publish a Lightning address.', content: { 'application/json': { schema: ERROR } } },
          },
        },
      },
      '/directory': {
        get: {
          tags: ['names'],
          operationId: 'directory',
          summary: 'The names a page at a time, searched and filtered here.',
          description:
            'Every live name in label order, from the snapshot this service refreshes every few seconds, so a list of thousands costs one call instead of a round trip per name. Withdrawn names are left out. `exists` says whether a name spelled exactly like `q` exists on the chain, served here or not, because a withdrawn name is not free. Each row carries the outpoint it was read at. Returns 503 until the first snapshot has been taken.',
          parameters: [
            { name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: 'Part of a label; `.cell` and case are ignored.' },
            { name: 'sale', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'Only names listed for sale (`1` or `true`).' },
            { name: 'pay', in: 'query', required: false, schema: { type: 'string', enum: ['ckb', 'lightning', 'fiber', 'btc', 'eth'] }, description: 'Only names that publish a way to be paid by this.' },
            { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1, minimum: 1 } },
            { name: 'size', in: 'query', required: false, schema: { type: 'integer', default: 10, minimum: 1, maximum: 50 } },
          ],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                ready: { type: 'boolean' },
                asOf: { type: 'string', format: 'date-time', description: 'When the snapshot was taken.' },
                listingsRead: { type: 'boolean', description: 'False until the sale listings have been scanned; the sale filter means nothing before.' },
                total: { type: 'integer', description: 'Names served.' },
                count: { type: 'integer', description: 'Names matching the query.' },
                page: { type: 'integer' },
                size: { type: 'integer' },
                pages: { type: 'integer' },
                exists: { type: 'boolean' },
                rows: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      label: { type: 'string' },
                      id: { type: 'string' },
                      expiresAt: { type: 'string', format: 'date-time' },
                      details: { type: 'integer', description: 'How many records the name publishes.' },
                      methods: { type: 'array', items: { type: 'string', enum: ['ckb', 'lightning', 'fiber', 'btc', 'eth'] } },
                      saleCkb: { type: ['number', 'null'] },
                      avatar: { type: 'boolean', description: 'Publishes a picture, served at /avatar/{name}.' },
                      accent: { type: ['string', 'null'] },
                      outPoint: { type: 'string' },
                    },
                  },
                },
              },
            }),
            503: { description: 'The first snapshot has not been taken yet.' },
          },
        },
      },
      '/expiring': {
        get: {
          tags: ['names'],
          operationId: 'expiring',
          summary: 'Names running out, and the ones that are free to register now.',
          description:
            'Three states. `expiring` is still paid up and runs out inside the window. `grace` has lapsed but for thirty days more nobody else may take it: the cell is live, the name still resolves, and anybody may renew it (a sub-name, only the owner of its parent). `free` is past expiry plus grace, so recycling is permissionless and the label can be registered. A lapsed name is never dropped by the window, however long ago it lapsed. `format=rss` returns the same list as a feed.',
          parameters: [
            {
              name: 'days',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 30, minimum: 1, maximum: 3650 },
              description: 'How far ahead to look. Bounds the future only.',
            },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 100, minimum: 1, maximum: 1000 } },
            { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['all', 'expiring', 'grace', 'free'], default: 'all' } },
            { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'rss'], default: 'json' } },
          ],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                complete: { type: 'boolean', description: 'False until the first snapshot of the chain has been taken.' },
                known: { type: 'integer' },
                graceSeconds: { type: 'integer', description: 'What the contract enforces, so a reader need not assume it.' },
                now: { type: 'integer', description: 'Unix seconds, the clock these answers were computed against.' },
                names: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      label: { type: 'string' },
                      expiredAt: { type: 'integer', description: 'Unix seconds, from the cell.' },
                      state: { type: 'string', enum: ['expiring', 'grace', 'free'] },
                      freeAt: { type: 'integer', description: 'Unix seconds at which recycling becomes permissible.' },
                      daysToExpiry: { type: 'integer', description: 'Negative once it has lapsed.' },
                      daysToFree: { type: 'integer', description: 'Zero once it is free.' },
                    },
                  },
                },
              },
            }),
          },
        },
      },
      '/latest': {
        get: {
          tags: ['names'],
          operationId: 'latest',
          summary: 'The most recently registered names, newest first.',
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 } }],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                complete: { type: 'boolean', description: 'False while the first pass over history is still running.' },
                known: { type: 'integer' },
                names: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      label: { type: 'string' },
                      registeredAt: { type: ['integer', 'null'], description: 'Unix seconds.' },
                      registered: { type: ['string', 'null'], format: 'date-time' },
                      block: { type: ['integer', 'null'] },
                      txHash: { type: ['string', 'null'] },
                      avatarPath: { type: 'string' },
                    },
                  },
                },
              },
              required: ['complete', 'known', 'names'],
            }),
          },
        },
      },
      '/health': {
        get: {
          tags: ['service'],
          operationId: 'health',
          summary: 'Snapshot freshness and what this instance is carrying.',
          responses: {
            200: ok({
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                names: { type: 'integer' },
                lastRefresh: { type: 'integer' },
                ageMs: { type: ['integer', 'null'] },
                network: { type: 'string' },
                price: { type: ['object', 'null'] },
                archive: { type: 'object' },
                quantum: { type: 'object' },
                sealed: { type: 'object' },
                disputes: { type: 'object', description: 'Reports filed, answered and acted on, and how long the oldest unanswered one has waited.' },
                domain: {
                  type: 'object',
                  description: 'Names claiming a website, and how many of those websites answer, are silent, or could not be read.',
                },
                lock: { type: 'object', description: 'Whether the post-quantum lock code is still the code we recorded.' },
                wallet: { type: 'object', description: 'The same watch over the wallet lock the app connects through.' },
              },
              required: ['ok', 'names', 'network'],
            }),
          },
        },
      },
      '/verify': {
        get: {
          tags: ['service'],
          operationId: 'verify',
          summary: 'Is the running contract the published, reproducible-build source?',
          responses: {
            200: ok({
              type: 'object',
              properties: {
                verified: { type: 'boolean' },
                hashes: { type: 'string', description: 'Which hash each `expected` is, so a reader knows what to compare against.' },
                note: { type: 'string' },
                network: { type: 'string' },
                contracts: {
                  type: 'object',
                  additionalProperties: {
                    type: 'object',
                    properties: {
                      matches: { type: 'boolean' },
                      expected: { type: 'string' },
                      onchain: { type: ['string', 'null'] },
                      depOutPoint: { type: 'string' },
                    },
                  },
                },
              },
              required: ['verified', 'contracts'],
            }),
          },
        },
      },
      '/quantum': {
        get: {
          tags: ['service'],
          operationId: 'quantum',
          summary: 'Owners proven to be post-quantum keys, and the state of the lock they obey.',
          responses: {
            200: ok({
              type: 'object',
              properties: {
                cells: { type: 'integer' },
                scannedAt: { type: 'integer' },
                lock: { type: 'array', items: { type: 'object' } },
                wallet: { type: 'array', items: { type: 'object' }, description: 'The same watch over the wallet lock.' },
                owners: { type: 'array', items: { type: 'string' } },
              },
              required: ['owners'],
            }),
          },
        },
      },
      '/price': {
        get: {
          tags: ['service'],
          operationId: 'price',
          summary: 'What a coin is worth, so a page can quote a name in money.',
          responses: {
            200: ok({
              type: 'object',
              properties: {
                usd: { type: ['number', 'null'], description: 'CKB in dollars. Kept for callers older than the other chains.' },
                rates: { type: ['object', 'null'], additionalProperties: { type: 'object', additionalProperties: { type: 'number' } } },
                asOf: {
                  type: ['number', 'null'],
                  description:
                    'When these figures were read from the source, in milliseconds since the epoch. This route keeps serving its last good answer while the source is down, so a caller about to spend money on the rate must check this rather than assume the answer is current.',
                },
              },
            }),
            502: { description: 'No rate could be fetched upstream.' },
          },
        },
      },
      '/recheck/{name}': {
        get: {
          tags: ['names'],
          operationId: 'recheck',
          summary: "Ask for this name's website proof to be looked at again.",
          description:
            'For whoever has just published the website half and does not want to wait out the ordinary fifteen minute clock. It queues the check rather than running one, so nothing here fetches a third party on the request path; the answer arrives on `/resolve` within about a minute. At most one request a minute per name: `queued` is false when it was looked at too recently for another look to say anything new.',
          parameters: [name],
          responses: {
            200: ok({
              type: 'object',
              properties: {
                queued: { type: 'boolean' },
                retryAfterSeconds: { type: 'integer', description: '0 when it was queued.' },
              },
              required: ['queued', 'retryAfterSeconds'],
            }),
          },
        },
      },
      '/disputes': {
        get: {
          tags: ['service'],
          operationId: 'disputes',
          summary: 'Names under a notice or withdrawn from this service, and why.',
          responses: {
            200: ok({
              type: 'object',
              properties: { policy: { type: 'string', format: 'uri' }, entries: { type: 'array', items: { type: 'object' } } },
              required: ['policy', 'entries'],
            }),
          },
        },
      },
      '/report': {
        post: {
          tags: ['service'],
          operationId: 'report',
          summary: 'Report a name under the disputes policy.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    claim: { type: 'string' },
                    statement: { type: 'string' },
                    evidence: { type: 'string' },
                    contact: { type: 'string' },
                  },
                  required: ['name', 'claim', 'statement', 'contact'],
                },
              },
            },
          },
          responses: {
            200: { description: 'Logged. Acknowledged within five working days.' },
            400: { description: 'Something required was missing.', content: { 'application/json': { schema: ERROR } } },
            429: { description: 'Too many reports from this address.' },
          },
        },
      },
      '/login': {
        post: {
          tags: ['names'],
          operationId: 'loginVerify',
          summary: 'Check a "sign in with .cell" signature.',
          description:
            'The site issues its own nonce, stores it, and spends it once: this service keeps no state about logins and cannot tell a fresh nonce from a spent one. The same check is a pure function in the Cells SDK (verifyLogin), so a site that would rather trust nobody runs it against its own node and gets the same answer.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    signed: { type: 'object', description: 'The {login, sig} the wallet produced.' },
                    domain: { type: 'string', description: 'The bare host this site serves, such as example.com.' },
                    nonce: { type: 'string', description: 'The hex challenge this site issued for this attempt.' },
                    allowManager: {
                      type: 'boolean',
                      description:
                        "Accept the name's manager as well as its owner. Off by default: a manager was delegated the records, not the identity.",
                    },
                  },
                  required: ['signed', 'domain', 'nonce'],
                },
              },
            },
          },
          responses: {
            200: {
              description: 'The verdict. `ok` is true only when nothing is in `problems`; `name` carries the name when it is.',
            },
            400: { description: 'The login could not be read.', content: { 'application/json': { schema: ERROR } } },
            429: { description: 'Rate limited.' },
          },
        },
      },
      '/r': {
        post: {
          tags: ['payments'],
          operationId: 'seal',
          summary: 'Hold a sealed payment request, so its link can be short.',
          description:
            'The id is a hash of a key this service never sees, and the blob is ciphertext under that key, so the contents are not readable here. The key travels in the fragment of the link, which a browser does not send.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Twelve base64url characters.' },
                    blob: { type: 'string', description: 'Ciphertext, base64url.' },
                    days: { type: 'integer', description: 'How long to hold it. Default 90, maximum 400.' },
                  },
                  required: ['id', 'blob'],
                },
              },
            },
          },
          responses: {
            200: { description: 'Held.' },
            400: { description: 'Malformed id or blob.', content: { 'application/json': { schema: ERROR } } },
            413: { description: 'The blob is over the size cap.' },
            429: { description: 'Too many from this address this hour.' },
          },
        },
      },
      '/r/{id}': {
        get: {
          tags: ['payments'],
          operationId: 'sealed',
          summary: 'A sealed payment request, for whoever holds the key that names it.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: ok({
              type: 'object',
              properties: { blob: { type: 'string' }, expires: { type: 'integer' } },
              required: ['blob', 'expires'],
            }),
            404: {
              description: 'Expired or never here. The two are the same answer, because this side cannot tell them apart either.',
              content: { 'application/json': { schema: ERROR } },
            },
          },
        },
      },
      '/.well-known/lnurlp/{name}': {
        get: {
          tags: ['payments'],
          operationId: 'lnurlp',
          summary: 'The Lightning Address lookup (LUD-16) for a name.',
          description: 'Forwarded unchanged to the wallet the name publishes. This service holds no key and issues no invoice of its own.',
          parameters: [name],
          responses: {
            // LNURL carries its own failures inside a 200, so this answers 200 either
            // way: the wallet's document, or {status: "ERROR", reason}. A wallet
            // reading this expects that, and a generated client should not treat the
            // second as success.
            200: {
              description: 'The LUD-16 document from the wallet, or {status: "ERROR", reason} when there is no wallet to ask.',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { type: 'object', description: "The wallet's own LUD-16 document, passed through unchanged." },
                      {
                        type: 'object',
                        properties: { status: { type: 'string', enum: ['ERROR'] }, reason: { type: 'string' } },
                        required: ['status', 'reason'],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  }
}
