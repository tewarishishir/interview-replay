# Contributing to InterviewReplay

Thanks for considering a contribution. This document covers the basics to get you up and running.

## Development setup

### Prerequisites

- Node.js 20+ (see `.node-version`)
- pnpm (corepack-managed — `corepack enable pnpm`)
- PostgreSQL 16 (Docker works fine: `docker compose up db -d`)
- Python 3.10+ (for faster-whisper — optional for UI-only work)
- Ollama (optional for UI-only work)

### Getting started

```bash
git clone https://github.com/tewarishishir/interview-replay.git
cd interview-replay
pnpm install

cp .env.example .env.local
# Edit .env.local:
#   DATABASE_URL="postgres://interview_replay:interview_replay@localhost:5432/interview_replay"
#   AUTH_SECRET="$(openssl rand -base64 32)"

docker compose up db -d
pnpm db:migrate
pnpm db:seed

pnpm dev
```

The app runs at `http://localhost:3000`. Sign in with the default admin credentials:

| Field | Value |
|---|---|
| Email | `admin@interview-replay.local` |
| Password | `admin123` |

If you're only working on the UI or API routes, you don't need Ollama or faster-whisper installed. The app gracefully degrades — it shows placeholder reports when the LLM isn't available and skips transcription when whisper isn't installed.

### Running tests

```bash
# Unit tests
pnpm test

# Watch mode
pnpm test:watch

# E2E tests (requires Playwright browsers)
pnpm test:e2e:install   # one-time
pnpm test:e2e
```

Tests run against a local database. Never point `DATABASE_URL` at a remote/production database when running tests.

### Linting and type checking

```bash
pnpm lint        # ESLint
pnpm lint:fix    # ESLint with auto-fix
pnpm typecheck   # TypeScript compiler check (no emit)
```

## Code style

- **TypeScript** everywhere — no `.js` files in `src/`.
- **ESLint** with the Next.js config. Run `pnpm lint` before committing.
- **Tailwind CSS 4** for styling. Use utility classes; avoid custom CSS unless there's no Tailwind equivalent.
- **Radix UI** for accessible primitives (dialogs, dropdowns, tooltips, etc.).
- **Drizzle ORM** for database access. Schema lives in `src/lib/db/schema/`.
- **Zod** for runtime validation of API inputs, env vars, and LLM outputs.

Prefer small, focused functions. Avoid comments that just narrate what the code does — comments should explain *why*, not *what*.

## Making changes

### Branch naming

Use prefixed branch names:

- `feat/description` — new features
- `fix/description` — bug fixes
- `chore/description` — tooling, deps, docs, refactoring

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add session export as PDF
fix: prevent duplicate analysis on rapid resubmit
chore: upgrade drizzle-orm to 0.45
docs: add GPU setup guide to self-hosting docs
```

Keep the subject line under 72 characters. Add a body if the *why* isn't obvious from the subject.

### Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your changes. Add or update tests if applicable.
3. Run `pnpm lint && pnpm typecheck && pnpm test` locally.
4. Open a PR against `main` with a clear description of what changed and why.
5. Fill in the PR template if one exists.

PRs should be focused — one logical change per PR. If you're fixing a bug *and* refactoring nearby code, split them into separate PRs.

### Database migrations

If your change modifies the database schema:

1. Edit the schema files in `src/lib/db/schema/`.
2. Run `pnpm db:generate` to create a migration file in `drizzle/`.
3. Run `pnpm db:migrate` to apply it locally.
4. Commit both the schema change and the generated migration.

Never use `pnpm db:push` against anything other than your local database — it can drop columns to reconcile drift.

## Project structure

```
src/
├── app/                    # Next.js App Router pages and API routes
│   ├── (admin)/            # Admin dashboard
│   ├── (app)/              # Authenticated app pages
│   ├── (auth)/             # Login/signup
│   ├── (marketing)/        # Public pages
│   └── api/                # API routes
├── components/
│   ├── admin/              # Admin UI components
│   ├── app/                # App UI components
│   ├── marketing/          # Marketing page components
│   └── ui/                 # Shared primitives (buttons, inputs, etc.)
├── lib/
│   ├── auth/               # NextAuth.js configuration
│   ├── db/                 # Drizzle schema and queries
│   ├── llm/                # LLM client, prompts, and schema
│   ├── storage/            # Local filesystem storage
│   └── whisper/            # faster-whisper integration
├── scripts/                # Admin and seed scripts
└── styles/                 # Global CSS
```

## Finding work

- Check [open issues](https://github.com/tewarishishir/interview-replay/issues) for bugs and feature requests.
- Issues labeled `good first issue` are a good starting point.
- If you want to work on something that doesn't have an issue, open one first to discuss the approach.

## Questions?

Open a [discussion](https://github.com/tewarishishir/interview-replay/discussions) or comment on the relevant issue. We're happy to help.
