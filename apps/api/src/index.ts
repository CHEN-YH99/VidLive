import { createServer } from './server.js';
import { loadConfig } from './config/env.js';

const config = loadConfig();
const server = await createServer(config);

try {
  await server.listen({
    host: config.host,
    port: config.port,
  });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
