import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const packageJsonPath = path.join(rootDir, "package.json");
const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");
const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;

if (typeof version !== "string" || !version.trim()) {
  throw new Error("package.json version is missing or invalid");
}

const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
if (!/^version = "[^"]+"$/m.test(cargoToml)) {
  throw new Error('Could not find version field in src-tauri/Cargo.toml');
}

const nextCargoToml = cargoToml.replace(/^version = "[^"]+"$/m, `version = "${version}"`);

const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, "utf8"));
tauriConfig.version = version;

fs.writeFileSync(cargoTomlPath, nextCargoToml);
fs.writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

console.log(`Synced app version to ${version}`);
