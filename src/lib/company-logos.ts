/**
 * Company name → primary web domain map.
 *
 * Drives the small inline company logo rendered on dashboard session
 * cards / rows. Used together with `getCompanyLogoUrl` to compose a
 * Clearbit Logo API URL — Clearbit's API is public, free, and
 * requires no auth, and the URLs are CDN-served so first paint is
 * fast.
 *
 * Matching is intentionally permissive (lowercased, punctuation
 * stripped, common corporate suffixes removed) so user-entered
 * variants like "Google", "google", "Google LLC", "Google Inc." all
 * resolve to the same domain. Anything we can't recognize falls back
 * to a generic building icon in the consumer component — never a
 * broken image.
 *
 * Curated for the interview-prep audience: heavy on Indian + global
 * tech, FAANG-adjacent, fintech, and prominent startups. Add new
 * entries by company name (normalized form below) → bare domain.
 */
const COMPANY_DOMAINS: Record<string, string> = {
  // ── FAANG + global big tech ──────────────────────────────────
  google: "google.com",
  alphabet: "google.com",
  meta: "meta.com",
  facebook: "facebook.com",
  apple: "apple.com",
  amazon: "amazon.com",
  aws: "aws.amazon.com",
  microsoft: "microsoft.com",
  netflix: "netflix.com",
  nvidia: "nvidia.com",
  tesla: "tesla.com",
  spacex: "spacex.com",
  oracle: "oracle.com",
  ibm: "ibm.com",
  intel: "intel.com",
  amd: "amd.com",
  cisco: "cisco.com",
  adobe: "adobe.com",
  salesforce: "salesforce.com",
  sap: "sap.com",
  vmware: "vmware.com",

  // ── Social / consumer ────────────────────────────────────────
  linkedin: "linkedin.com",
  twitter: "x.com",
  x: "x.com",
  snap: "snap.com",
  snapchat: "snap.com",
  pinterest: "pinterest.com",
  reddit: "reddit.com",
  tiktok: "tiktok.com",
  bytedance: "bytedance.com",
  spotify: "spotify.com",
  discord: "discord.com",
  twitch: "twitch.tv",
  airbnb: "airbnb.com",
  uber: "uber.com",
  lyft: "lyft.com",
  doordash: "doordash.com",
  instacart: "instacart.com",

  // ── Fintech / payments ───────────────────────────────────────
  stripe: "stripe.com",
  square: "squareup.com",
  block: "block.xyz",
  paypal: "paypal.com",
  visa: "visa.com",
  mastercard: "mastercard.com",
  coinbase: "coinbase.com",
  robinhood: "robinhood.com",
  plaid: "plaid.com",
  brex: "brex.com",
  ramp: "ramp.com",
  klarna: "klarna.com",
  revolut: "revolut.com",
  wise: "wise.com",
  chime: "chime.com",
  affirm: "affirm.com",

  // ── Banks ────────────────────────────────────────────────────
  "goldman sachs": "goldmansachs.com",
  goldman: "goldmansachs.com",
  jpmorgan: "jpmorganchase.com",
  "jp morgan": "jpmorganchase.com",
  "morgan stanley": "morganstanley.com",
  citi: "citi.com",
  citigroup: "citi.com",
  hsbc: "hsbc.com",
  barclays: "barclays.com",
  "bank of america": "bankofamerica.com",
  wellsfargo: "wellsfargo.com",
  "wells fargo": "wellsfargo.com",

  // ── Dev tools / cloud / data ─────────────────────────────────
  github: "github.com",
  gitlab: "gitlab.com",
  atlassian: "atlassian.com",
  jira: "atlassian.com",
  bitbucket: "atlassian.com",
  notion: "notion.so",
  figma: "figma.com",
  slack: "slack.com",
  zoom: "zoom.us",
  dropbox: "dropbox.com",
  box: "box.com",
  cloudflare: "cloudflare.com",
  vercel: "vercel.com",
  netlify: "netlify.com",
  cursor: "cursor.com",
  postman: "postman.com",
  mongodb: "mongodb.com",
  redis: "redis.com",
  datadog: "datadoghq.com",
  snowflake: "snowflake.com",
  databricks: "databricks.com",
  confluent: "confluent.io",
  elastic: "elastic.co",
  splunk: "splunk.com",
  hashicorp: "hashicorp.com",
  docker: "docker.com",
  twilio: "twilio.com",
  segment: "segment.com",
  sentry: "sentry.io",
  intercom: "intercom.com",
  zendesk: "zendesk.com",
  shopify: "shopify.com",
  squarespace: "squarespace.com",
  wix: "wix.com",
  webflow: "webflow.com",
  servicenow: "servicenow.com",
  workday: "workday.com",
  okta: "okta.com",

  // ── AI / ML ──────────────────────────────────────────────────
  openai: "openai.com",
  anthropic: "anthropic.com",
  "hugging face": "huggingface.co",
  huggingface: "huggingface.co",
  cohere: "cohere.com",
  mistral: "mistral.ai",
  deepmind: "deepmind.com",
  perplexity: "perplexity.ai",
  scale: "scale.com",
  "scale ai": "scale.com",

  // ── Gaming ───────────────────────────────────────────────────
  "riot games": "riotgames.com",
  riot: "riotgames.com",
  "epic games": "epicgames.com",
  epic: "epicgames.com",
  valve: "valvesoftware.com",
  blizzard: "blizzard.com",
  ea: "ea.com",
  "electronic arts": "ea.com",
  ubisoft: "ubisoft.com",
  unity: "unity.com",
  roblox: "roblox.com",
  nintendo: "nintendo.com",
  playstation: "playstation.com",
  sony: "sony.com",

  // ── Indian unicorns + tech ───────────────────────────────────
  flipkart: "flipkart.com",
  razorpay: "razorpay.com",
  zomato: "zomato.com",
  swiggy: "swiggy.com",
  paytm: "paytm.com",
  phonepe: "phonepe.com",
  ola: "olacabs.com",
  olacabs: "olacabs.com",
  byjus: "byjus.com",
  "byju's": "byjus.com",
  unacademy: "unacademy.com",
  freshworks: "freshworks.com",
  zoho: "zoho.com",
  cred: "cred.club",
  meesho: "meesho.com",
  nykaa: "nykaa.com",
  dream11: "dream11.com",
  sharechat: "sharechat.com",
  oyo: "oyorooms.com",
  policybazaar: "policybazaar.com",
  pharmeasy: "pharmeasy.in",
  groww: "groww.in",
  upstox: "upstox.com",
  zerodha: "zerodha.com",
  cleartax: "cleartax.in",
  urbancompany: "urbancompany.com",
  "urban company": "urbancompany.com",
  bigbasket: "bigbasket.com",
  acko: "acko.com",
  rapido: "rapido.bike",
  delhivery: "delhivery.com",
  postman_india: "postman.com",
  tcs: "tcs.com",
  infosys: "infosys.com",
  wipro: "wipro.com",
  hcl: "hcltech.com",
  hcltech: "hcltech.com",
  "hcl technologies": "hcltech.com",
  techmahindra: "techmahindra.com",
  "tech mahindra": "techmahindra.com",
  mindtree: "ltimindtree.com",
  ltimindtree: "ltimindtree.com",
  mphasis: "mphasis.com",
  persistent: "persistent.com",
  "persistent systems": "persistent.com",
  cognizant: "cognizant.com",
  accenture: "accenture.com",
  capgemini: "capgemini.com",
  deloitte: "deloitte.com",
  ey: "ey.com",
  pwc: "pwc.com",
  kpmg: "kpmg.com",
  reliance: "ril.com",
  jio: "jio.com",
  "tata consultancy services": "tcs.com",

  // ── Other prominent ──────────────────────────────────────────
  walmart: "walmart.com",
  target: "target.com",
  costco: "costco.com",
  ebay: "ebay.com",
  etsy: "etsy.com",
  expedia: "expedia.com",
  booking: "booking.com",
  "booking.com": "booking.com",
  yelp: "yelp.com",
  zillow: "zillow.com",
  redfin: "redfin.com",
  peloton: "onepeloton.com",
  spacex_dup: "spacex.com",
  rivian: "rivian.com",
  lucid: "lucidmotors.com",
  ford: "ford.com",
  gm: "gm.com",
  "general motors": "gm.com",
};

/**
 * Common suffixes that show up when users paste a legal company name
 * ("Google LLC", "Acme, Inc.") but shouldn't affect logo lookup.
 * Stripped during normalization so the bare brand token is what we
 * key on.
 */
const CORPORATE_SUFFIXES = [
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "pvt",
  "private",
  "holdings",
];

/**
 * Normalize a user-entered company name for lookup. Lowercases,
 * strips punctuation (keeping internal whitespace and apostrophes),
 * collapses repeated whitespace, and drops trailing corporate
 * suffixes ("Inc.", "LLC", etc.).
 */
function normalizeCompanyName(name: string): string {
  // Replace any character that isn't a-z, 0-9, apostrophe, or
  // whitespace with a space, then collapse whitespace runs. This
  // turns "Booking.com" → "booking com", "Tata Consultancy Services,"
  // → "tata consultancy services", etc.
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  // Strip trailing corporate suffixes. We only strip the LAST token
  // (not deeper) because intra-name suffixes are part of the brand
  // (e.g. "Block Inc Cash App" — unlikely, but defensive).
  const tokens = cleaned.split(" ");
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (last && CORPORATE_SUFFIXES.includes(last)) {
      tokens.pop();
    } else {
      break;
    }
  }
  return tokens.join(" ");
}

/**
 * Resolve a company name to its primary web domain (e.g. "Google" →
 * "google.com"). Returns `null` when the name doesn't appear in our
 * curated list — callers should fall back to a generic icon rather
 * than guessing the domain (we'd hit lots of 404s otherwise).
 */
export function getCompanyDomain(name: string): string | null {
  const normalized = normalizeCompanyName(name);
  if (!normalized) return null;
  return COMPANY_DOMAINS[normalized] ?? null;
}

/**
 * Compose a logo URL for the given company, or `null` if we don't
 * recognize the name. Uses Google's public `s2/favicons` endpoint —
 * stable Google infrastructure, free, no auth, served via CDN, and
 * crucially still alive (Clearbit's free Logo API was shut down by
 * HubSpot after the 2023 acquisition; the `logo.clearbit.com`
 * hostname no longer resolves, which is why this used to render
 * the Building icon fallback for every row).
 *
 * The size param maxes out around 64–128px server-side; we pass 128
 * so high-DPI displays still get a crisp render at our 14px
 * inline footprint.
 *
 * We deliberately gate this behind the curated `COMPANY_DOMAINS`
 * lookup. Google's endpoint returns a generic "globe" placeholder
 * for unknown / typo'd hosts (it never 404s), so without the gate
 * we'd litter the dashboard with identical globes for every
 * misspelled company. The Building icon fallback is the better
 * UX for "we don't know this one yet".
 *
 * If Google ever 404s or the response is blocked (corporate
 * firewall, ad blocker hitting `gstatic.com`), the consuming
 * `<img>` `onError` falls through to the Building icon — so an
 * outage degrades to today's UI, not a broken-image glyph.
 */
export function getCompanyLogoUrl(name: string): string | null {
  const domain = getCompanyDomain(name);
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}
