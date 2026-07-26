# InterviewReplay — Self-Hosted Operations Runbook

Living document covering common operational procedures for a
self-hosted InterviewReplay deployment.

## Contents

- [Health check](#health-check)
- [Database backup and restore](#database-backup-and-restore)
- [Re-running a failed analysis](#re-running-a-failed-analysis)
- [Restoring a soft-deleted account](#restoring-a-soft-deleted-account)
- [Privacy SLA: audio deletion](#privacy-sla-audio-deletion)
- [Diagnosing a stuck session](#diagnosing-a-stuck-session)

---

## Health check

```bash
curl http://localhost:3000/api/healthz | jq
```

Returns `{ "status": "ok", "checks": { "db": { "ok": true } } }` when
the app and database are healthy.

---

## Database backup and restore

### Manual backup

```bash
pg_dump $DATABASE_URL | gzip > backup-$(date +%F).sql.gz
```

### Restore

```bash
gunzip -c backup-2026-01-01.sql.gz | psql $DATABASE_URL
```

The included GitHub Actions workflow (`.github/workflows/ir-db-backup.yml`)
runs nightly backups automatically when `DATABASE_URL` is set as a secret.

---

## Re-running a failed analysis

If a session is stuck in `analyzing` state:

```bash
DATABASE_URL="..." tsx --conditions=react-server src/scripts/retrigger-analysis.ts <session-id>
```

Or via the admin panel: Admin → Sessions → click the session → "Retry Analysis".

Common causes:
- LLM (Ollama) service is down or overloaded
- Transcript was empty (no speech detected)
- JSON schema validation failed (model produced invalid output)

Check application logs for the specific error.

---

## Restoring a soft-deleted account

When a user requests account restoration within the retention window:

```sql
UPDATE users
SET deleted_at = NULL, deletion_requested_at = NULL
WHERE email = 'user@example.com';
```

Then ask the user to sign in again.

---

## Privacy SLA: audio deletion

Audio files are automatically deleted after analysis completes.
If a file lingers past the SLA window, manually delete:

```bash
rm data/uploads/audio/<session-id>/*
```

And update the database:

```sql
UPDATE audio_files SET deleted_at = NOW()
WHERE session_id = '<session-id>' AND deleted_at IS NULL;
```

---

## Diagnosing a stuck session

```bash
DATABASE_URL="..." tsx --conditions=react-server src/scripts/diagnose-session.ts <session-id>
```

This prints the session state, transcript status, report status, and any
error messages. Common stuck states:

| State | Likely cause |
|-------|-------------|
| `recording` | Client never called `/audio/uploaded` |
| `transcribing` | Whisper process crashed or timed out |
| `analyzing` | LLM service down, retry with script above |
| `transcription_error` | Audio was silent or corrupted |
