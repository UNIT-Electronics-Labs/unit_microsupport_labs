import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const esptoolDir = path.join(rootDir, "node_modules/esptool-js/lib");

const architectures = [
  {
    id: "esp32",
    chipName: "ESP32",
    module: "esp32",
    exportedClass: "ESP32ROM",
    imageChipId: 0,
    stub: "stub_flasher_32.json",
  },
  {
    id: "esp32c3",
    chipName: "ESP32-C3",
    module: "esp32c3",
    exportedClass: "ESP32C3ROM",
    imageChipId: 5,
    stub: "stub_flasher_32c3.json",
  },
  {
    id: "esp32c5",
    chipName: "ESP32-C5",
    module: "esp32c5",
    exportedClass: "ESP32C5ROM",
    imageChipId: 23,
    stub: "stub_flasher_32c5.json",
  },
  {
    id: "esp32c6",
    chipName: "ESP32-C6",
    module: "esp32c6",
    exportedClass: "ESP32C6ROM",
    imageChipId: 13,
    stub: "stub_flasher_32c6.json",
  },
  {
    id: "esp32h2",
    chipName: "ESP32-H2",
    module: "esp32h2",
    exportedClass: "ESP32H2ROM",
    imageChipId: 16,
    stub: "stub_flasher_32h2.json",
  },
  {
    id: "esp32s3",
    chipName: "ESP32-S3",
    module: "esp32s3",
    exportedClass: "ESP32S3ROM",
    imageChipId: 9,
    stub: "stub_flasher_32s3.json",
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasAssignment(source, property, value) {
  const expression = new RegExp(
    `this\\.${property}\\s*=\\s*${typeof value === "string" ? `['\"]${value}['\"]` : value}`
  );
  return expression.test(source);
}

async function validateArchitecture(architecture, manifest, loaderSource, stubSource) {
  const targetPath = path.join(
    esptoolDir,
    "targets",
    `${architecture.module}.js`
  );
  const stubPath = path.join(
    esptoolDir,
    "targets/stub_flasher",
    architecture.stub
  );
  const [targetSource, rawStub] = await Promise.all([
    fs.readFile(targetPath, "utf8"),
    fs.readFile(stubPath, "utf8"),
  ]);

  assert(
    loaderSource.includes(`./targets/${architecture.module}.js`),
    `${architecture.chipName}: falta el módulo de detección en esploader.js`
  );
  assert(
    targetSource.includes(`export class ${architecture.exportedClass}`),
    `${architecture.chipName}: no exporta ${architecture.exportedClass}`
  );
  assert(
    hasAssignment(targetSource, "CHIP_NAME", architecture.chipName),
    `${architecture.chipName}: CHIP_NAME no coincide`
  );
  assert(
    hasAssignment(targetSource, "IMAGE_CHIP_ID", architecture.imageChipId),
    `${architecture.chipName}: IMAGE_CHIP_ID no coincide`
  );
  assert(
    stubSource.includes(`case "${architecture.chipName}"`),
    `${architecture.chipName}: falta el caso del stub`
  );
  assert(
    stubSource.includes(`./targets/stub_flasher/${architecture.stub}`),
    `${architecture.chipName}: el stub configurado no coincide`
  );

  const stub = JSON.parse(rawStub);
  for (const numericField of ["entry", "text_start", "data_start"]) {
    assert(
      Number.isFinite(stub[numericField]),
      `${architecture.chipName}: ${numericField} inválido en el stub`
    );
  }
  assert(
    Buffer.from(stub.text, "base64").byteLength > 0,
    `${architecture.chipName}: segmento text del stub vacío`
  );
  assert(
    Buffer.from(stub.data, "base64").byteLength > 0,
    `${architecture.chipName}: segmento data del stub vacío`
  );

  const family = manifest.families?.[architecture.id];
  assert(family, `${architecture.chipName}: falta en el manifiesto de firmware`);
  const firmwareCount = [
    ...(Array.isArray(family.standard) ? family.standard : []),
    ...(Array.isArray(family.micropython) ? family.micropython : []),
  ].length;

  return {
    arquitectura: architecture.chipName,
    cargador: "OK",
    stub: "OK",
    firmwares: firmwareCount,
  };
}

async function main() {
  const [rawManifest, loaderSource, stubSource] = await Promise.all([
    fs.readFile(path.join(rootDir, "public/firmware/manifest.json"), "utf8"),
    fs.readFile(path.join(esptoolDir, "esploader.js"), "utf8"),
    fs.readFile(path.join(esptoolDir, "stubFlasher.js"), "utf8"),
  ]);
  const manifest = JSON.parse(rawManifest);
  const results = [];

  for (const architecture of architectures) {
    results.push(
      await validateArchitecture(
        architecture,
        manifest,
        loaderSource,
        stubSource
      )
    );
  }

  console.table(results);

  const missingFirmware = results
    .filter((result) => result.firmwares === 0)
    .map((result) => result.arquitectura);

  console.log("\nCompatibilidad del cargador: 6/6 arquitecturas OK.");
  if (missingFirmware.length > 0) {
    console.warn(
      `Sin firmware en el catálogo: ${missingFirmware.join(", ")}. ` +
        "El soporte del cargador está validado, pero aún falta agregar y probar sus binarios."
    );
  }
}

main().catch((error) => {
  console.error("Validación ESP fallida:", error.message);
  process.exitCode = 1;
});
