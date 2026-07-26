/**
 * Curated suggestion list for the company-name field on `/sessions/new`.
 *
 * Why a fixed list rather than a search API: the field accepts free
 * text (a candidate interviewing at a stealth-mode startup must be
 * able to type the company in), so the suggestions are pure UX sugar
 * — autocomplete via `<datalist>`. We don't validate against this
 * list anywhere; do not gate insertion on membership.
 *
 * For the India launch the set is weighted toward Indian tech
 * (Flipkart, Razorpay, Zomato, etc.) while keeping global names that
 * Indian candidates routinely interview at (Google, Microsoft, FAANG-
 * adjacent unicorns). Sorted alphabetically so visual scanning works
 * in the dropdown. Keep it under ~80 entries — long lists dilute the
 * "did you mean…" affordance.
 */
export const SUGGESTED_COMPANIES = [
  // India-first tech + India-rooted IT services / consulting,
  // alphabetized case-insensitively. The IT-services giants (TCS,
  // Infosys, Wipro, HCLTech, Tech Mahindra, LTIMindtree, Mphasis,
  // Cognizant, Persistent Systems) are major employers of Indian
  // engineers and a frequent interview target — they belong here
  // rather than in the "global" block so they surface high in
  // the suggestion dropdown.
  "Accenture",
  "Acko",
  "BharatPe",
  "BookMyShow",
  "CRED",
  "Cars24",
  "Cleartrip",
  "Cognizant",
  "Cred",
  "Cult.fit",
  "Dream11",
  "Dunzo",
  "Flipkart",
  "Freshworks",
  "Games24x7",
  "Groww",
  "HCLTech",
  "Hotstar",
  "InMobi",
  "Infosys",
  "Jio",
  "LTIMindtree",
  "Lenskart",
  "MPL",
  "Meesho",
  "MoEngage",
  "Mphasis",
  "MyGate",
  "Myntra",
  "Nykaa",
  "Ola",
  "Persistent Systems",
  "PhonePe",
  "Postman",
  "Practo",
  "Razorpay",
  "Rapido",
  "Swiggy",
  "TCS",
  "Tata 1mg",
  "Tech Mahindra",
  "Udaan",
  "Unacademy",
  "Upstox",
  "Urban Company",
  "Vedantu",
  "Wipro",
  "Zepto",
  "Zerodha",
  "Zoho",
  "Zomato",
  // Global companies Indian candidates commonly interview at.
  "Adobe",
  "Amazon",
  "Anthropic",
  "Apple",
  "Atlassian",
  "Cloudflare",
  "Confluent",
  "Databricks",
  "Figma",
  "GitHub",
  "Google",
  "Linear",
  "LinkedIn",
  "Meta",
  "Microsoft",
  "MongoDB",
  "Netflix",
  "Notion",
  "Nvidia",
  "OpenAI",
  "Oracle",
  "Salesforce",
  "Samsung",
  "Shopify",
  "Slack",
  "Snowflake",
  "Spotify",
  "Stripe",
  "Twilio",
  "Uber",
  "Vercel",
] as const;
