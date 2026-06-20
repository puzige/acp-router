#!/usr/bin/env node

import { startMcpServer } from "../mcp/server.mjs";

startMcpServer().catch((error) => {
  process.stderr.write(`agent-router: ${error.message}\n`);
  process.exit(1);
});
