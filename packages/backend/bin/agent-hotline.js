#!/usr/bin/env node

const { main: hookMain } = require("../src/hook-command");
const { installHooks, installSkills, npxHookCommand, parseArgs } = require("../src/installer");
const { launchBackend } = require("../src/run-command");

function printHelp() {
  console.log(`Agent Hotline

Usage:
  agent-hotline run
  agent-hotline hook
  agent-hotline install --harness codex --skill codex
  agent-hotline install-hooks --harness all
  agent-hotline install-skill --target all
  agent-hotline install --harness all --skill all

Options:
  --harness antigravity|claude-code|codex|all
  --target antigravity|claude-code|codex|all
  --skill antigravity|claude-code|codex|all
  --scope global|repo
  --repo <path>
  --home <path>
  --hook-command <command>
  --port <port>       Backend port for "run" (default: 4777)
  --use-npx-hook    Write hooks that call "npx --yes agent-hotline hook"
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

function isNpmExec() {
  return (
    process.env.npm_command === "exec" ||
    /\bnpm exec\b/.test(process.env.npm_config_user_agent || "")
  );
}

function hookCommandFromArgs(args) {
  if (args["hook-command"]) return args["hook-command"];
  if (args["use-npx-hook"] || isNpmExec()) return npxHookCommand();
  return undefined;
}

async function main(argv = process.argv.slice(2), options = {}) {
  const [command, subcommand, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "hook") {
    return hookMain();
  }

  if (command === "run" || command === "start") {
    const args = parseArgs([subcommand, ...rest].filter(Boolean));
    const launcher = options.launchBackend || launchBackend;
    const result = launcher({ port: args.port });
    console.log(`Agent Hotline backend started in the background on ${result.url}.`);
    if (result.pid) {
      console.log(`Process id: ${result.pid}`);
    }
    console.log("You can close this terminal; the backend will keep running.");
    return 0;
  }

  if (command === "install-hooks") {
    const args = parseArgs([subcommand, ...rest].filter(Boolean));
    const results = installHooks({
      harness: args.harness || "all",
      scope: args.scope || "global",
      repo: args.repo,
      home: args.home,
      hookCommand: hookCommandFromArgs(args)
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
      hookCommand: hookCommandFromArgs(args)
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
