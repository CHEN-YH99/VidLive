# VidLive

VidLive is a web-first tool for turning short videos and GIFs into Live Photo related assets.

The current scaffold follows the MVP direction from the product and delivery docs:

- local-first, no-login flow for small files
- standard Live Photo and iOS lock screen presets
- explicit privacy and cloud-processing boundaries
- Fastify API skeleton for the later cloud fallback path

## Project Layout

```text
apps/
  web/      Next.js App Router tool UI
  api/      Fastify API skeleton
packages/
  shared/   shared product constants and TypeScript contracts
```

## Scripts

```bash
npm install
npm run dev:web
npm run dev:api
npm run types
npm run build
```

## MVP Boundary

The first implementation focuses on local file import, metadata inspection, preset selection, trim/keyframe parameters, and export guidance. Cloud processing, users, R2 storage, and AI keyframe recommendation are intentionally staged for later phases.
