# Self-Hosting Guide

InterviewReplay is designed to run entirely on your own hardware. This guide covers everything from a quick Docker setup to a production deployment behind a reverse proxy.

## System requirements

### Minimum (CPU-only, smaller models)

- 4 CPU cores
- 16 GB RAM
- 20 GB disk (plus ~5 GB per Ollama model)
- No GPU required — transcription and inference run on CPU, just slower

### Recommended (GPU-accelerated)

- 8+ CPU cores
- 32 GB RAM
- NVIDIA GPU with 8+ GB VRAM (for faster-whisper `medium` + Ollama `llama3.3:8b`)
- 100 GB disk (LLM models are large)

### For the full 70b model

- 48+ GB RAM or VRAM (the 70b model alone needs ~40 GB)
- NVIDIA GPU with 24+ GB VRAM, or enough system RAM for CPU inference (slow but works)

If you don't have the hardware for the 70b model, use `llama3.3:8b` for both `LLM_MODEL_LARGE` and `LLM_MODEL_SMALL`. Reports will be less detailed but still useful.

## Docker deployment (recommended)

The fastest path to a running instance.

### 1. Clone and configure

```bash
git clone https://github.com/tewarishishir/interview-replay.git
cd interview-replay
cp .env.example .env.local
```

Edit `.env.local`:

```bash
# Generate a real secret — don't use the placeholder
AUTH_SECRET="$(openssl rand -base64 32)"

# Change if you're exposing this publicly
NEXTAUTH_URL="http://localhost:3000"

# Generate a secret for signed file URLs
STORAGE_SECRET="$(openssl rand -base64 32)"
```

### 2. Start services

```bash
docker compose up -d
```

This starts three containers:

| Container | Port | Purpose |
|---|---|---|
| `ir-postgres` | 5432 | PostgreSQL 16 database |
| `ir-ollama` | 11434 | Ollama LLM server |
| `ir-app` | 3000 | Next.js application |

### 3. Pull LLM models

```bash
# Large model for main analysis (~40 GB download)
docker exec ir-ollama ollama pull llama3.3:70b

# Small model for question inference (~5 GB download)
docker exec ir-ollama ollama pull llama3.3:8b
```

Or use smaller models if you have limited resources:

```bash
docker exec ir-ollama ollama pull llama3.3:8b
# Then set LLM_MODEL_LARGE=llama3.3:8b in .env.local
```

### 4. Run migrations

```bash
docker exec ir-app npx drizzle-kit migrate
```

### 5. Open the app

Navigate to `http://localhost:3000`, create an account, and you're ready to go.

### GPU support (NVIDIA)

Uncomment the GPU section in `docker-compose.yml`:

```yaml
ollama:
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: all
            capabilities: [gpu]
```

You'll need the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed on the host.

## Manual deployment on a VPS

For more control, or if you're not using Docker.

### 1. Install system dependencies

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y nodejs npm postgresql python3 python3-pip

# Install pnpm
corepack enable pnpm

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh
```

### 2. Set up PostgreSQL

```bash
sudo -u postgres createuser interview_replay
sudo -u postgres createdb interview_replay -O interview_replay
sudo -u postgres psql -c "ALTER USER interview_replay PASSWORD 'your-password';"
```

### 3. Clone and build

```bash
git clone https://github.com/tewarishishir/interview-replay.git
cd interview-replay
pnpm install
pnpm build
```

### 4. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with your database credentials, secrets, and model preferences.

### 5. Install Python dependencies

```bash
pip3 install faster-whisper whisperx
```

### 6. Pull models and start

```bash
ollama pull llama3.3:70b
ollama pull llama3.3:8b
pnpm db:migrate
pnpm start
```

The app listens on port 3000 by default.

## Reverse proxy setup

You almost certainly want a reverse proxy in front of the app for HTTPS.

### Caddy (simplest)

```
interview.example.com {
    reverse_proxy localhost:3000
}
```

Caddy handles HTTPS automatically via Let's Encrypt. Install Caddy, drop this in `/etc/caddy/Caddyfile`, and run `sudo systemctl reload caddy`.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name interview.example.com;

    ssl_certificate /etc/letsencrypt/live/interview.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/interview.example.com/privkey.pem;

    client_max_body_size 500M;  # audio uploads can be large

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (for dev hot reload; optional in production)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

server {
    listen 80;
    server_name interview.example.com;
    return 301 https://$server_name$request_uri;
}
```

When running behind a proxy, set `TRUSTED_PROXY_HOPS=1` in `.env.local` so the app reads the correct client IP from `X-Forwarded-For`.

### SSL with Let's Encrypt

If you're using nginx:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d interview.example.com
```

Certbot will modify your nginx config and set up auto-renewal.

## Backup strategy

InterviewReplay stores data in two places:

1. **PostgreSQL** — user accounts, sessions, transcripts, reports
2. **`data/uploads/`** — audio recordings

### Database backup

```bash
# Dump the database
pg_dump -U interview_replay interview_replay > backup-$(date +%Y%m%d).sql

# Or with Docker
docker exec ir-postgres pg_dump -U interview_replay interview_replay > backup-$(date +%Y%m%d).sql
```

### File backup

```bash
# If using Docker volumes
docker cp ir-app:/app/data/uploads ./uploads-backup-$(date +%Y%m%d)

# If using a bind mount or manual install
cp -r data/uploads/ uploads-backup-$(date +%Y%m%d)
```

### Automated backups (cron)

```bash
# Add to crontab (runs daily at 3 AM)
0 3 * * * docker exec ir-postgres pg_dump -U interview_replay interview_replay | gzip > /backups/ir-db-$(date +\%Y\%m\%d).sql.gz
0 3 * * * tar czf /backups/ir-uploads-$(date +\%Y\%m\%d).tar.gz /path/to/data/uploads
```

### Restore

```bash
# Database
psql -U interview_replay interview_replay < backup.sql

# Files
cp -r uploads-backup/* data/uploads/
```

## Updating to new versions

```bash
cd interview-replay
git pull

# Docker
docker compose down
docker compose build app
docker compose up -d
docker exec ir-app npx drizzle-kit migrate

# Manual
pnpm install
pnpm build
pnpm db:migrate
pnpm start
```

Always run migrations after updating — new versions may include schema changes.

## Troubleshooting

### "Ollama connection refused"

The app can't reach Ollama. Check:

```bash
# Is Ollama running?
curl http://localhost:11434/api/tags

# Docker networking: the app container reaches Ollama at ir-ollama:11434,
# not localhost. Ensure OLLAMA_BASE_URL is set correctly in docker-compose.yml.
```

### "Whisper not configured"

faster-whisper isn't installed or `WHISPER_MODEL_SIZE` isn't set.

```bash
# Check Python has faster-whisper
python3 -c "import faster_whisper; print('ok')"

# Set in .env.local
WHISPER_MODEL_SIZE="medium"
```

### Transcription is slow

CPU transcription is 5-20x slower than GPU. Options:

- Use a smaller whisper model (`tiny` or `base`) — less accurate but much faster
- Set `WHISPER_DEVICE=cuda` if you have an NVIDIA GPU
- Pre-record and paste transcripts manually via the edit screen

### Out of memory during LLM analysis

The 70b model needs ~40 GB. If you're running out of memory:

```bash
# Switch to the 8b model
# In .env.local:
LLM_MODEL_LARGE="llama3.3:8b"
```

### Database connection errors

```bash
# Check Postgres is running
docker compose ps db

# Check connection string format
# Must be: postgres://user:password@host:port/database
```

### Port conflicts

If port 3000, 5432, or 11434 is already in use, change the port mappings in `docker-compose.yml`:

```yaml
ports:
  - "3001:3000"  # app on port 3001
```

Then update `NEXTAUTH_URL` to match.
