import { parseProfile, type LiveAccount } from 'cellula-sdk'

/**
 * The little document a link preview reads.
 *
 * Sharing a name used to show the site's own card, the same picture and the same sentence
 * whichever name you sent, because the app is one static HTML file and its `og:` tags are
 * written at build time. A crawler never runs the JavaScript that would fix them, so no
 * amount of work in the browser could ever change what was shared.
 *
 * So the crawler is answered here instead, where every name is already in memory. It gets
 * the name, what the name says about itself, and the name's own picture. A person who
 * lands on this page (a crawler that follows nothing, someone opening the URL by hand) is
 * sent on to the real page immediately.
 */

/** Escape for HTML text and double-quoted attributes. Every value below is a stranger's. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** One line about the name, in the order of what a stranger would find useful. */
function describe(acc: LiveAccount): string {
  const p = parseProfile(acc.records)
  if (p.bio) return p.bio
  const paid = acc.records.some((r) => r.key.startsWith('address.') || r.key.startsWith('lightning.'))
  const bits: string[] = []
  if (p.name) bits.push(p.name)
  if (p.location) bits.push(p.location)
  if (paid) bits.push('Pay this name instead of an address')
  if (bits.length) return bits.join(' · ')
  return 'A name on the Nervos blockchain. Look it up, or pay it by name instead of by address.'
}

export interface CardInput {
  /** Null when the name is not registered: the card then says so, honestly. */
  acc: LiveAccount | null
  label: string
  /** Where the name's real page lives, for the canonical link and the redirect. */
  pageUrl: string
  /** Absolute base the crawler can fetch the image from. */
  imageBase: string
  /** A notice or a withdrawal under the disputes policy, if the name is under one. */
  dispute?: { status: 'notice' | 'withdrawn'; claim: string; since: string; note?: string } | null
}

export function cardHtml({ acc, label, pageUrl, imageBase, dispute }: CardInput): string {
  const name = `${label}.cell`
  const registered = acc !== null
  const withdrawn = dispute?.status === 'withdrawn'
  const title = withdrawn ? `${name} is withdrawn from cellula.id` : registered ? name : `${name} is unclaimed`
  const description = withdrawn
    ? `${name} is not served by this site under its disputes policy (${dispute.claim}, since ${dispute.since}). The name still exists on the blockchain.`
    : registered
      ? (dispute ? `Disputed (${dispute.claim}): ${(dispute.note ?? 'a claim is being checked').replace(/\.$/, '')}. ` : '') + describe(acc)
      : `Nobody has claimed ${name}. It is free to take on the Nervos blockchain.`
  // Always the name's own image: its published picture, or the mark drawn from its id,
  // as a raster because a preview will not render SVG.
  const image = `${imageBase}/avatar/${encodeURIComponent(name)}?raster=1`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="canonical" href="${esc(pageUrl)}">
<meta name="description" content="${esc(description)}">${
    registered
      ? ''
      : `
<!-- Every path this site does not recognise is the page of a name nobody has claimed,
     which is deliberate: it offers to sell it rather than apologising. What is not
     deliberate is telling a search engine that an unbounded number of those pages exist,
     each answering 200 with a real title. A name that exists is worth indexing; the
     infinite set of names that do not is a soft 404 repeated forever. Link previews are
     unaffected: this hides the page from an index, not from anybody who is sent it. -->
<meta name="robots" content="noindex, follow">`
  }
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(name)}">
<meta property="og:site_name" content="cellula.id">
<!-- A profile picture is square, so the small card is the honest shape for it: the wide
     one would letterbox it into a strip. -->
<meta name="twitter:card" content="summary">
<!-- Whose card this is. A name's page is the most shared thing this service draws, and
     without this the account gets none of the reach of its own pages. -->
<meta name="twitter:site" content="@cellula_id">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0; url=${esc(pageUrl)}">
</head>
<body>
<p><a href="${esc(pageUrl)}">${esc(name)}</a></p>
</body>
</html>
`
}

/**
 * The site's own card, for a crawler that asked for the site rather than for a name.
 *
 * It exists so that routing crawlers here cannot quietly take away the preview the
 * landing page already had. It mirrors the tags in `ui/index.html`; if those change, this
 * is the other place to change, which is the price of answering crawlers outside the app.
 */
export function siteCardHtml(origin: string): string {
  const title = 'cellula.id: get paid by name, not by address'
  const description =
    'Claim a .cell name on Nervos and get paid by name, not by a long address. You own it yourself on-chain: nobody approves it, nobody can take it back.'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="canonical" href="${esc(origin)}/">
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(origin)}/">
<meta property="og:image" content="${esc(origin)}/og.png">
<meta property="og:image:width" content="2400">
<meta property="og:image:height" content="1260">
<meta property="og:site_name" content="cellula.id">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@cellula_id">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(origin)}/og.png">
<meta http-equiv="refresh" content="0; url=${esc(origin)}/">
</head>
<body><p><a href="${esc(origin)}/">cellula.id</a></p></body>
</html>
`
}
