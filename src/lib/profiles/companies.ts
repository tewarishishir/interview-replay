/**
 * Curated suggestions for the "Target companies" tag input on
 * `/profile`. Same UX role as `SUGGESTED_COMPANIES` for
 * `/sessions/new`: the input accepts free text, this list just
 * powers a `<datalist>`-style autocomplete.
 *
 * We intentionally re-export the session-level list rather than
 * forking it — keeping one canonical "common companies" curation
 * means the dashboard "company you're interviewing with" suggestions
 * and the profile "companies you're targeting" suggestions stay in
 * sync.
 */

export { SUGGESTED_COMPANIES as TARGET_COMPANY_SUGGESTIONS } from "@/lib/sessions/companies";
