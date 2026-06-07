FROM node:20-alpine AS base

RUN apk add --no-cache ffmpeg exiftool

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false

COPY . .

RUN pnpm --filter @vidlive/shared run build && pnpm --filter @vidlive/api run build

EXPOSE 8000

CMD ["pnpm", "--filter", "@vidlive/api", "start"]
