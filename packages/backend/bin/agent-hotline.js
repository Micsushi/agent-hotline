#!/usr/bin/env node

const { main: hookMain } = require("../src/hook-command");
const { installHooks, installSkills, parseArgs } = require("../src/installer");

function printHelp() {
  console.log(`Agent Hotline

Usage:
  agent-hotline hook
  agent-hotline install-hooks --harness all
  agent-hotline install-skill --target all
  agent-hotline install --harness all --skill all

Options:
  --harness antigravity|claude-code|codex|all
  --target antigravity|claude-code|codex|all
  --scope global|repo
  --repo <path>
  --home <path>
  --hook-command <command>
`);
}

function printResults(title, results) {
  console.log(title);
  for (const result of results) {
    console.log(
      `  ${result.target || result.harness} (${result.scope}): ${result.path || result.configPath}`
    );
  }
}

async function main(argv = process.argv.slice(2)) {
  const [command, subcommand, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "hook") {
    return hookMain();
  }

  if (command === "install-hooks") {
    const args = parseArgs([subcommand, ...rest].filter(Boolean));
    const results = installHooks({
      harness: args.harness || "all",
      scope: args.scope || "global",
      repo: args.repo,
      home: args.home,
      hookCommand: args["hook-command"]
    });
    printResults("Installed Agent Hotline hooks:", results);
    return 0;
  }

  if (command === "install-skill") {
    const args = parseArgs([subcommand, ...rest].filter(Boolean));
    const results = installSkills({
      target: args.target || args.harness || "all",
      scope: args.scope || "global",
      repo: args.repo,
      home: args.home
    });
    printResults("Installed Agent Hotline spoken skill/instructions:", results);
    return 0;
  }

  if (command === "install") {
    const args = parseArgs([subcommand, ...rest].filter(Boolean));
    const hookResults = installHooks({
      harness: args.harness || "all",
      scope: args.scope || "global",
      repo: args.repo,
      home: args.home,
      hookCommand: args["hook-command"]
    });
    const skillResults = installSkills({
      target: args.skill || args.target || args.harness || "all",
      scope: args.scope || "global",
      repo: args.repo,
      home: args.home
    });
    printResults("Installed Agent Hotline hooks:", hookResults);
    printResults("Installed Agent Hotline spoken skill/instructions:", skillResults);
    return 0;
  }

  console.error(`Unknown command "${command}".`);
  printHelp();
  return 1;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { main };
