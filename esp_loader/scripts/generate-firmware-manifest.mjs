import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const firmwareDir = path.resolve(__dirname, "../public/firmware");
const manifestPath = path.join(firmwareDir, "manifest.json");

const families = ["esp32", "esp32c3", "esp32c5", "esp32c6", "esp32h2", "esp32s3"];

function detectFamily(fileName) {
  const name = fileName.toLowerCase();
  if (name.includes("esp32c3")) return "esp32c3";
  if (name.includes("esp32c5")) return "esp32c5";
  if (name.includes("esp32h2")) return "esp32h2";
  if (name.includes("esp32c6")) return "esp32c6";
  if (name.includes("esp32s3")) return "esp32s3";
  return "esp32";
}

function isMicroPython(fileName) {
  const name = fileName.toLowerCase();
  return name.includes("micropython") || name.includes("micro_python");
}

async function main() {
  const entries = await fs.readdir(firmwareDir, { withFileTypes: true });

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith(".bin"))
    .sort((a, b) => a.localeCompare(b));

  const grouped = Object.fromEntries(
    families.map((family) => [family, { standard: [], micropython: [] }])
  );

  for (const file of files) {
    const family = detectFamily(file);
    const channel = isMicroPython(file) ? "micropython" : "standard";
    grouped[family][channel].push(file);
  }

  const payload = {
    files,
    families: grouped,
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Firmware manifest updated: ${manifestPath}`);
}

main().catch((error) => {
  console.error("Failed to generate firmware manifest:", error);
  process.exitCode = 1;
});
