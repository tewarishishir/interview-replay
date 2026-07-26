# InterviewReplay

Record your real interviews. Get structured AI coaching on every answer — running entirely on your own machine.

## What it does

InterviewReplay records your microphone during real interviews (only your side — never the interviewer), transcribes the audio locally with faster-whisper, and feeds the transcript to a local LLM for structured coaching feedback. You get an evidence-anchored report with strengths, improvements, communication signal analysis, and per-question breakdowns — all without your data leaving your machine.

It supports coding, system design, behavioral, and general interview rounds, with round-specific rubrics that adapt feedback to what actually matters in each format.

## Features

- Record only YOUR microphone during real interviews
- Automatic transcription with speaker diarization (faster-whisper, fully local)
- AI-generated coaching feedback calibrated to your target level
- Detailed per-question analytics with evidence quotes
- Story highlights and STAR completeness analysis for behavioral rounds
- Communication signal analysis (pace, filler words, structure, presence)
- Round-specific feedback (coding, system design, behavioral, general)
- Resume parsing for profile-aware feedback
- Completely self-hosted — your data never leaves your machine

## Where your data lives

All data stays on your local machine. Nothing is sent to any external service unless you explicitly configure a cloud LLM (see below).

| Data | Location |
|---|---|
| Audio recordings | `./data/uploads/audio/<user-id>/<session-id>/<uuid>.webm` |
| Uploaded resume PDFs | `./data/uploads/resumes/<user-id>/<uuid>.pdf` |
| Artifact images (whiteboard, diagrams) | `./data/uploads/artifacts/<user-id>/<session-id>/<uuid>.png` |
| Transcripts & reports | PostgreSQL database (localhost) |
| Session metadata | PostgreSQL database (localhost) |

The storage root defaults to `./data/uploads` and is configurable via `STORAGE_PATH` in `.env.local`.

## How transcription works

Audio is transcribed locally using [faster-whisper](https://github.com/SYSTRAN/faster-whisper), a reimplementation of OpenAI Whisper optimized for CPU/GPU inference. It runs as a Python subprocess — no audio is ever sent to a remote API.

**Model used:** controlled by `WHISPER_MODEL_SIZE` in `.env.local`.

| Model | Disk | Speed | Accuracy |
|---|---|---|---|
| `tiny` | ~75 MB | Very fast | Low |
| `base` | ~145 MB | Fast | Fair |
| `small` | ~465 MB | Moderate | Good |
| `medium` | ~1.5 GB | Slow | Very good |
| `large-v3` | ~3 GB | Slowest | Best |

Recommended starting point: `medium`. Use `large-v3` for the best accuracy if you have the disk space and can wait a few extra minutes per session.

CPU transcription works on any machine. Set `WHISPER_DEVICE=cuda` if you have an NVIDIA GPU for a significant speed boost.

## How analysis works

After transcription, the transcript is sent to a local LLM (via [Ollama](https://ollama.com)) that generates the full coaching report. The LLM never sees your audio — only the redacted text transcript.

**Model used:** controlled by `LLM_MODEL_LARGE` in `.env.local`.

### Local models (default — fully offline)

```bash
# Recommended starting point — good quality, ~5 GB RAM
ollama pull qwen2.5:7b

# Better quality — ~9 GB RAM
ollama pull qwen2.5:14b

# Best local quality — ~40 GB RAM (needs a high-end machine)
ollama pull llama3.3:70b
```

Create a custom Ollama model with a larger context window for better results with longer transcripts:

```bash
cat > Modelfile <<EOF
FROM qwen2.5:7b
PARAMETER num_ctx 16384
EOF
ollama create interview-replay-llm -f Modelfile
```

Then set in `.env.local`:
```
LLM_MODEL_LARGE=interview-replay-llm
LLM_MODEL_SMALL=interview-replay-llm
```

### Using a paid cloud LLM (recommended for best quality)

You can point the app at any OpenAI-compatible API — including OpenAI, Anthropic (via compatible proxy), or other providers. Analysis quality with GPT-4o or Claude is significantly better than local 7B models.

**Option A — OpenAI:**
```env
OLLAMA_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL_LARGE=gpt-4o
LLM_MODEL_SMALL=gpt-4o-mini
```
Cost: ~$0.02–0.05 per session analysis.

**Option B — Anthropic Claude (via OpenAI-compatible proxy):**

Claude doesn't have a native OpenAI-compatible endpoint, but you can use a proxy like [LiteLLM](https://github.com/BerriAI/litellm):

```bash
pip install litellm
litellm --model claude-opus-4-5 --port 4000
```

Then set in `.env.local`:
```env
OLLAMA_BASE_URL=http://localhost:4000/v1
LLM_API_KEY=your-anthropic-key
LLM_MODEL_LARGE=claude-opus-4-5
LLM_MODEL_SMALL=claude-haiku-4-5
```

**Option C — Use the transcript yourself:**

The raw transcript is always available at **Session → View transcript**. You can copy it and paste it directly into Claude, ChatGPT, or any LLM with a prompt like:

> "I'm a software engineer interviewing for a [role] at [company]. Below is my side of a [behavioral / coding / system design] interview. Please give me structured feedback on my strengths, areas to improve, and how well I used the STAR framework."

This works even without any LLM configured in the app.

## Accessing your data

Everything is stored locally — in PostgreSQL and on the local filesystem. You can query or copy it directly at any time.

### Database tables

Connect to the database with `psql`:

```bash
psql "$DATABASE_URL"
# or with the default local setup:
psql postgres://ir:ir@localhost:5432/ir
```

| Table | What it holds |
|---|---|
| `users` | Accounts — email, name, password hash, admin flag |
| `interview_sessions` | One row per session — company, role, level, round type, state |
| `transcripts` | Redacted transcript text, word count, duration, optional edited text |
| `audio_files` | File key (relative path on disk) for each session's recording |
| `reports` | Full AI coaching report as JSON, one per analysis run |
| `artifacts` | Uploaded files attached to a session (whiteboard images, question lists, etc.) |
| `stories` | Story bank entries (STAR format) |
| `story_rebuilds` | AI-assisted STAR draft revisions |
| `session_outcomes` | Outcome recorded after the interview (offer, rejected, etc.) |
| `audit_log` | Server-side event log |

### Useful queries

**List all sessions:**
```sql
SELECT
  s.id,
  s.company_name,
  s.role_title,
  s.level,
  s.round_type,
  s.state,
  s.created_at
FROM interview_sessions s
JOIN users u ON u.id = s.user_id
WHERE u.email = 'admin@interview-replay.local'
ORDER BY s.created_at DESC;
```

**Read the transcript for a session:**
```sql
SELECT
  redacted_text,
  edited_text,
  word_count,
  duration_seconds
FROM transcripts
WHERE session_id = '<session-uuid>';
```

**Get the AI report JSON for a session:**
```sql
SELECT
  report_json,
  model_version,
  created_at
FROM reports
WHERE session_id = '<session-uuid>'
ORDER BY created_at DESC
LIMIT 1;
```

**Find the audio file path on disk:**
```sql
SELECT s3_key
FROM audio_files
WHERE session_id = '<session-uuid>';
```

The `s3_key` is a relative path from the storage root (default `./data/uploads`). Prefix it with your storage path to get the full location — see the section below.

### Audio recordings on disk

Audio is stored as `.webm` files under the storage root. The default path is `./data/uploads` relative to the project root (configurable via `STORAGE_PATH`).

```
data/uploads/
├── audio/
│   └── <user-id>/
│       └── <session-id>/
│           └── <uuid>.webm        ← the recording
├── artifacts/
│   └── <user-id>/
│       └── <session-id>/
│           └── <uuid>.png         ← uploaded whiteboard/diagram images
└── resumes/
    └── <user-id>/
        └── <uuid>.pdf             ← uploaded resume
```

**To find and play a specific session's recording:**

1. Get the file key from the database:
   ```sql
   SELECT s3_key FROM audio_files WHERE session_id = '<session-uuid>';
   -- returns: audio/<user-id>/<session-id>/<uuid>.webm
   ```

2. Combine with your storage root:
   ```bash
   # Default path
   open ./data/uploads/audio/<user-id>/<session-id>/<uuid>.webm
   ```

**To list all recordings on disk:**
```bash
find ./data/uploads/audio -name "*.webm" -exec ls -lh {} \;
```

**To download/copy a recording:**
```bash
cp ./data/uploads/audio/<user-id>/<session-id>/<uuid>.webm ~/Desktop/interview-recording.webm
```

`.webm` files open in VLC, QuickTime (with a codec pack), Chrome, or any modern browser via `File → Open`.

## Quick Start (Docker)

```bash
git clone https://github.com/tewarishishir/interview-replay.git
cd interview-replay
cp .env.example .env.local

# Start all services (Postgres, Ollama, app)
docker compose up -d

# Pull an LLM model
docker exec ir-ollama ollama pull qwen2.5:7b

# Run database migrations
docker exec ir-app npx drizzle-kit migrate

# Seed the default admin user
docker exec ir-app pnpm db:seed

# Open in browser
open http://localhost:3000
```

### Default credentials

After running `pnpm db:seed`, sign in with:

| Field | Value |
|---|---|
| Email | `admin@interview-replay.local` |
| Password | `admin123` |

**Change these credentials before sharing access with anyone.**

See [docs/self-hosting.md](docs/self-hosting.md) for GPU setup, reverse proxy configuration, and production deployment.

## Manual Setup (Development)

### Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL 16
- Python 3.10+ with faster-whisper
- Ollama

### Steps

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env.local
# Edit .env.local — at minimum set AUTH_SECRET (generate with `openssl rand -base64 32`)

# Start Postgres (or use the bundled container)
docker compose up db -d

# Run migrations
pnpm db:migrate

# Install Python transcription dependency
pip install faster-whisper

# Pull an Ollama model (qwen2.5:7b is a good starting point)
ollama pull qwen2.5:7b

# Seed the default admin user
pnpm db:seed

# Start dev server
pnpm dev
```

The app starts at `http://localhost:3000`. Sign in with the default credentials above, record a session, and submit it for analysis.

## Configuration

### Environment variables

Copy `.env.example` to `.env.local`. The key variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `AUTH_SECRET` | Yes | — | 32+ char secret for session signing |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434/v1` | LLM API endpoint (Ollama or any OpenAI-compatible URL) |
| `LLM_API_KEY` | No | `ollama` | API key — required for cloud providers, ignored by Ollama |
| `LLM_MODEL_LARGE` | No | `llama3.3:70b` | Model for main analysis |
| `LLM_MODEL_SMALL` | No | `llama3.3:8b` | Model for lighter tasks |
| `WHISPER_MODEL_SIZE` | No | — | faster-whisper model size (enables transcription when set) |
| `WHISPER_DEVICE` | No | `auto` | `cpu`, `cuda`, or `auto` |
| `STORAGE_PATH` | No | `./data/uploads` | Root directory for audio, resumes, and artifact files |
| `STORAGE_SECRET` | No | — | Secret for signing file access tokens |

## Architecture

```
┌──────────────────────────────────────────────┐
│  Browser                                     │
│  ┌────────────┐  ┌──────────────────────┐    │
│  │  Recorder   │  │  Report / Dashboard  │    │
│  │ (MediaRec.) │  │  (React + Chart.js)  │    │
│  └──────┬──────┘  └──────────────────────┘    │
└─────────┼────────────────────────────────────┘
          │ upload audio (.webm)
┌─────────▼────────────────────────────────────┐
│  Next.js 15 (App Router)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ API routes│ │ Auth.js  │ │  Analysis    │  │
│  │          │ │ (v5)     │ │  pipeline    │  │
│  └────┬─────┘ └──────────┘ └──────┬───────┘  │
│       │                           │           │
│  ┌────▼───────────────────────────▼────────┐  │
│  │         Drizzle ORM                     │  │
│  └────┬────────────────────────────────────┘  │
└───────┼───────────────────────────────────────┘
        │
┌───────▼───────┐  ┌───────────────┐  ┌─────────────────────┐
│  PostgreSQL   │  │ faster-whisper │  │ Ollama / OpenAI API │
│  transcripts  │  │  (local STT)   │  │ (LLM analysis)      │
│  & reports    │  └───────────────┘  └─────────────────────┘
└───────────────┘
        │
┌───────▼───────────────┐
│  ./data/uploads/      │
│  audio/  resumes/     │
│  artifacts/           │
└───────────────────────┘
```

Audio files are written to the local filesystem. Transcription runs as a Python subprocess (faster-whisper). LLM analysis calls Ollama's OpenAI-compatible API — or any cloud LLM you configure.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
