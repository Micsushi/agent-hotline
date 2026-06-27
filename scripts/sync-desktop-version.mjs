// Sync the Tauri bundle + crate version to the root package version, so the
// desktop installer always matches the published release. Run before building
// the installer.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const confPath = path.join(root, "packages", "desktop", "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = version;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);

const cargoPath = path.join(root, "packages", "desktop", "src-tauri", "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8").replace(/^version = ".*"/m, `version = "${version}"`);
writeFileSync(cargoPath, cargo);

console.log(`Synced desktop version -> ${version}`);
