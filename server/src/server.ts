import http from "http";

import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./utils/logger";

const server = http.createServer(app);

server.listen(env.port, () => {
  logger.info(`Server listening on port ${env.port} (${env.nodeEnv})`);
});

