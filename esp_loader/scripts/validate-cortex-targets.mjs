import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadTargets() {
  const source = await fs.readFile(
    path.join(rootDir, "src/cortex/targets.ts"),
    "utf8"
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
  return (await import(moduleUrl)).TARGETS;
}

async function main() {
  const targets = await loadTargets();
  const entries = Object.entries(targets);
  const requiredFamilies = ["stm32", "gd32", "py32"];
  const expectedAlgorithm = {
    stm32: "stm32f1",
    gd32: "stm32f1",
    py32: "py32f0",
  };

  assert(entries.length > 0, "No hay targets Cortex configurados");

  for (const [key, target] of entries) {
    assert(target.label, `${key}: falta label`);
    assert(
      requiredFamilies.includes(target.family),
      `${key}: familia ${target.family} no reconocida`
    );
    assert(
      target.algorithm === expectedAlgorithm[target.family],
      `${key}: algoritmo ${target.algorithm} incompatible con ${target.family}`
    );
    assert(
      target.flashBase === 0x08000000,
      `${key}: flashBase inesperada`
    );
    assert(
      Number.isInteger(target.flashSizeBytes) && target.flashSizeBytes > 0,
      `${key}: tamaño de flash inválido`
    );
    if (key === "py32f002ax5") {
      assert(target.flashSizeBytes === 20 * 1024, `${key}: flash esperada de 20 KB`);
    }
    assert(
      Number.isInteger(target.pageSize) && target.pageSize > 0,
      `${key}: tamaño de página inválido`
    );
    if (target.family === "py32") {
      assert(
        Number.isInteger(target.programPageSize) && target.programPageSize > 0,
        `${key}: tamaño de programación PY32 inválido`
      );
      assert(
        ["py32f0", "py32f071"].includes(target.timingProfile),
        `${key}: perfil de temporización PY32 inválido`
      );
    }
  }

  for (const family of requiredFamilies) {
    assert(
      entries.some(([, target]) => target.family === family),
      `No hay targets para la familia ${family.toUpperCase()}`
    );
  }

  const [stm32Flash, py32Flash, runtimeValidation] = await Promise.all([
    fs.readFile(path.join(rootDir, "src/cortex/flash/stm32f1.ts"), "utf8"),
    fs.readFile(path.join(rootDir, "src/cortex/flash/py32f0.ts"), "utf8"),
    fs.readFile(path.join(rootDir, "src/cortex/validation.ts"), "utf8"),
    fs.stat(path.join(rootDir, "public/pack/GD32_FIXED.pack")),
    fs.stat(
      path.join(rootDir, "public/pack/Misc/Puya.PY32F0xx_DFP.1.1.7.pack")
    ),
  ]);

  assert(
    stm32Flash.includes("export async function flashStm32F1"),
    "Falta el algoritmo de programación STM32/GD32"
  );
  assert(
    py32Flash.includes("export async function flashPy32F0"),
    "Falta el algoritmo de programación PY32"
  );
  for (const requiredCheck of [
    "CORTEX_M0_PLUS_PART_NUMBER",
    "CORTEX_M3_PART_NUMBER",
    "CORTEX_CPUID_ADDRESS",
    "configuredFlashSizeKb",
  ]) {
    assert(
      runtimeValidation.includes(requiredCheck),
      `Falta la validación Cortex: ${requiredCheck}`
    );
  }

  const results = requiredFamilies.map((family) => ({
    familia: family.toUpperCase(),
    targets: entries.filter(([, target]) => target.family === family).length,
    algoritmo: expectedAlgorithm[family],
    validacion: "núcleo + capacidad configurada",
  }));

  console.table(results);
  console.log(
    `\nConfiguración Cortex: ${entries.length}/${entries.length} targets OK.`
  );
}

main().catch((error) => {
  console.error("Validación Cortex fallida:", error.message);
  process.exitCode = 1;
});
