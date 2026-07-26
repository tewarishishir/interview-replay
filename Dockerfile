FROM node:20-alpine AS base

# Install Python for faster-whisper
RUN apk add --no-cache python3 py3-pip

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable pnpm && pnpm build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install faster-whisper and whisperx
RUN pip3 install --no-cache-dir faster-whisper whisperx

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/scripts/transcribe.py ./scripts/transcribe.py
COPY --from=builder /app/drizzle ./drizzle

RUN mkdir -p /app/data/uploads && chown -R nextjs:nodejs /app/data

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
