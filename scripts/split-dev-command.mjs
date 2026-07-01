const command = process.argv[2] || "that command";

console.error(
  `${command} is intentionally disabled. Use "npm run dev" or "npm run restart" so Agent Hotline restarts the backend and desktop together.`
);
process.exitCode = 1;
