FROM node:20-alpine AS base

RUN apk add --no-cache ffmpeg perl perl-image-exiftool

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN pnpm --filter @vidlive/shared run build && pnpm --filter @vidlive/api run build

EXPOSE 3001

CMD ["pnpm", "--filter", "@vidlive/api", "start"]
