#!/usr/bin/env node
import("../src/mcp-server.mjs").then(({ runStdioServer }) => runStdioServer());
