FROM node:20-alpine AS builder

WORKDIR /app

ARG VITE_API_BASE_URL=/api
ARG NEXT_PUBLIC_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY tsconfig.base.json ./

RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages

RUN pnpm --filter @vidlive/shared run build
RUN pnpm --filter @vidlive/web run build

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

COPY --from=builder /app/package.json ./
COPY --from=builder --chown=node:node /app/pnpm-lock.yaml ./
COPY --from=builder --chown=node:node /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps ./apps
COPY --from=builder --chown=node:node /app/packages ./packages

USER node

EXPOSE 3000

CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "-H", "0.0.0.0", "-p", "3000"]
