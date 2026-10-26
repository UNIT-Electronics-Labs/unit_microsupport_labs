import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

async function compile(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
  }).outputText;
}

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const utilsUrl = moduleUrl(await compile("../src/cortex/utils.ts"));
const validationSource = (await compile("../src/cortex/validation.ts"))
  .replace('from "./utils"', `from "${utilsUrl}"`);
const { validateCortexTarget, formatCortexValidation } = await import(moduleUrl(validationSource));
const { TARGETS } = await import(moduleUrl(await compile("../src/cortex/targets.ts")));

for (const [key, cpuid, expectedKb] of [
  ["py32f002ax5", 0xc600, 20],
  ["stm32f103rc", 0xc230, 256],
  ["gd32f150g8", 0xc230, 64],
]) {
  test(`${key} solo lee CPUID y usa la capacidad configurada`, async () => {
    const reads = [];
    const target = {
      async readMem32(address) {
        reads.push(address);
        if (address === 0xe000ed00) return cpuid;
        throw new Error(`Lectura inesperada: ${address.toString(16)}`);
      },
    };

    const result = await validateCortexTarget(target, TARGETS[key]);
    assert.deepEqual(reads, [0xe000ed00]);
    assert.equal(result.configuredFlashSizeKb, expectedKb);
    assert.match(
      formatCortexValidation(TARGETS[key].label, result),
      new RegExp(`flash configurada ${expectedKb} KB`)
    );
  });
}

test("rechaza un núcleo Cortex incompatible", async () => {
  const target = {
    async readMem32(address) {
      assert.equal(address, 0xe000ed00);
      return 0xc230;
    },
  };

  await assert.rejects(
    validateCortexTarget(target, TARGETS.py32f002ax5),
    /Núcleo incompatible/
  );
});
