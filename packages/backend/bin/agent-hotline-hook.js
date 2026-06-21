#!/usr/bin/env node

const { main } = require("../src/hook-command");

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    process.exitCode = 0;
  });
