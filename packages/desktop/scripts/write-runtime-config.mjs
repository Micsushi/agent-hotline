import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const outputFile = resolve("public/config.json");
const backendUrl = process.env.AGENT_HOTLINE_URL || "http://127.0.0.1:4777";

await mkdir(dirname(outputFile), { recursive: true });
await writeFile(`${outputFile}`, `${JSON.stringify({ backendUrl }, null, 2)}\n`, "utf8");
