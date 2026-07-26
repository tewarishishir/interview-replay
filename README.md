# InterviewReplay

Record your real interviews. Get structured AI coaching on every answer — running entirely on your own machine.

## What it does

InterviewReplay records your microphone during real interviews (only your side — never the interviewer), transcribes the audio locally with faster-whisper, and feeds the transcript to a local LLM for structured coaching feedback. You get an evidence-anchored report with strengths, improvements, communication signal analysis, and per-question breakdowns — all without your data leaving your machine.

It supports coding, system design, behavioral, and general interview rounds, with round-specific rubrics that adapt feedback to what actually matters in each format.

## Features

- Record only YOUR microphone during real interviews
- Automatic transcription with speaker diarization (faster-whisper + whisperX, fully local)
- AI-generated coaching feedback calibrated to your target level
- Detailed per-question analytics with evidence quotes
- Story highlights and STAR completeness analysis for behavioral rounds
- Communication signal analysis (pace, filler words, structure, presence)
- Round-specific feedback (coding, system design, behavioral, general)
- Resume parsing for profile-aware feedback
- Completely self-hosted — your data never leaves your machine

## Quick Start (Docker)

```bash
git clone https://github.com/tewarishishir/interview-replay.git
cd interview-replay
cp .env.example .env.local

# Start all services (Postgres, Ollama, app)
docker compose up -d

# Pull LLM models (one-time — the 70b model is ~40 GB)
docker exec ir-ollama ollama pull llama3.3:70b
docker exec ir-ollama ollama pull llama3.3:8b

# Run database migrations
docker exec ir-app npx drizzle-kit migrate

# Seed the default admin user
docker exec ir-app pnpm db:seed

# Open in browser
open http://localhost:3000
```

### Default credentials

After running `pnpm db:seed`, you can sign in with:

| Field | Value |
|---|---|
| Email | `admin@interview-replay.local` |
| Password | `admin123` |

This user has admin access. **Change these credentials before deploying to production.**

See [docs/self-hosting.md](docs/self-hosting.md) for GPU setup, reverse proxy configuration, and production deployment.

## Manual Setup (Development)

### Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL 16
- Python 3.10+ with faster-whisper and whisperX
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

# Install Python STT dependencies
pip install faster-whisper whisperx

# Pull Ollama models
ollama pull llama3.3:70b
ollama pull llama3.3:8b

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
| `OLLAMA_BASE_URL` | No | `http://localhost:11434/v1` | Ollama API endpoint |
| `LLM_MODEL_LARGE` | No | `llama3.3:70b` | Model for main analysis |
| `LLM_MODEL_SMALL` | No | `llama3.3:8b` | Model for lighter tasks (question inference) |
| `WHISPER_MODEL_SIZE` | No | `medium` | faster-whisper model (`tiny`, `base`, `small`, `medium`, `large-v3`) |
| `WHISPER_DEVICE` | No | `auto` | `cpu`, `cuda`, or `auto` |
| `STORAGE_PATH` | No | `./data/uploads` | Where audio files are stored on disk |
| `STORAGE_SECRET` | No | — | Secret for signing file download URLs |

### LLM models

The app uses two model tiers through Ollama's OpenAI-compatible API:

- **Large** (`LLM_MODEL_LARGE`): Powers the main analysis — executive summary, strengths/improvements, round-specific feedback. Default: `llama3.3:70b`. Needs ~40 GB RAM/VRAM.
- **Small** (`LLM_MODEL_SMALL`): Handles lighter tasks like question inference from transcripts. Default: `llama3.3:8b`. Needs ~5 GB RAM/VRAM.

For machines with less RAM, swap the large model for `llama3.3:8b` (both tiers). Reports will be less detailed but still useful. Any OpenAI-compatible endpoint works — set `OLLAMA_BASE_URL` and optionally `LLM_API_KEY`.

### Whisper models

| Model | VRAM | Speed | Accuracy |
|---|---|---|---|
| `tiny` | ~1 GB | Very fast | Low |
| `base` | ~1 GB | Fast | Fair |
| `small` | ~2 GB | Moderate | Good |
| `medium` | ~5 GB | Slow | Very good |
| `large-v3` | ~10 GB | Slowest | Best |

CPU transcription works but is significantly slower. Set `WHISPER_DEVICE=cuda` if you have an NVIDIA GPU.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Browser                                     │
│  ┌────────────┐  ┌──────────────────────┐    │
│  │  Recorder   │  │  Report / Dashboard  │    │
│  │ (MediaRec.) │  │  (React + Chart.js)  │    │
│  └──────┬──────┘  └──────────────────────┘    │
└─────────┼────────────────────────────────────┘
          │ upload audio
┌─────────▼────────────────────────────────────┐
│  Next.js 15 (App Router)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ API routes│ │ Auth.js  │ │ Background   │  │
│  │          │ │ (v5)     │ │ workers      │  │
│  └────┬─────┘ └──────────┘ └──────┬───────┘  │
│       │                           │           │
│  ┌────▼───────────────────────────▼────────┐  │
│  │         Drizzle ORM                     │  │
│  └────┬────────────────────────────────────┘  │
└───────┼───────────────────────────────────────┘
        │
┌───────▼───────┐  ┌───────────────┐  ┌─────────┐
│  PostgreSQL   │  │  faster-whisper│  │ Ollama  │
│  (data)       │  │  (local STT)  │  │ (LLM)   │
└───────────────┘  └───────────────┘  └─────────┘
```

Audio is stored on the local filesystem (`data/uploads/` by default). Transcription runs as a Python subprocess. LLM analysis uses Ollama's OpenAI-compatible API.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
