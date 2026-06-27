// Entry point for the self-contained backend executable (Node SEA). esbuild
// bundles this plus the backend source into one file; the SEA runtime runs it
// with require.main undefined, so we start the server explicitly here.
const { listen } = require("./src/server");

listen();
