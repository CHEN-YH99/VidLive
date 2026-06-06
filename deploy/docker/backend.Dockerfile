FROM node:20-alpine AS builder

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json ./

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @vidlive/shared run build
RUN if [ -f apps/api/prisma/schema.prisma ] && pnpm exec prisma --version >/dev/null 2>&1; then \
      pnpm exec prisma generate --schema apps/api/prisma/schema.prisma; \
    elif [ -f prisma/schema.prisma ] && pnpm exec prisma --version >/dev/null 2>&1; then \
      pnpm exec prisma generate --schema prisma/schema.prisma; \
    elif [ -f apps/api/prisma/schema.prisma ] || [ -f prisma/schema.prisma ]; then \
      echo "Prisma schema found, but prisma CLI is not installed. Skip prisma generate."; \
    else \
      echo "No Prisma schema found, skip prisma generate"; \
    fi
RUN pnpm --filter @vidlive/api run build

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apk add --no-cache ffmpeg exiftool
RUN corepack enable

COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages

EXPOSE 3001

CMD ["sh", "-c", "pnpm --filter @vidlive/api run start || node apps/api/dist/index.js"]
