#!/usr/bin/env node

const { main } = require("../packages/backend/bin/agent-hotline");

const args = ["install-skill", ...process.argv.slice(2)];

main(args)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
