FROM node:20-alpine AS base

RUN apk add --no-cache ffmpeg perl perl-image-exiftool

WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev

COPY . .

RUN npm run build --workspace @vidlive/shared && npm run build --workspace @vidlive/api

EXPOSE 3001

CMD ["node", "apps/api/dist/index.js"]
