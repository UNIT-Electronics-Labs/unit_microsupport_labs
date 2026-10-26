import type { CortexM } from "dapjs";
import type { CortexTargetConfig } from "./types";
import { formatHex32 } from "./utils";

const CORTEX_M0_PLUS_PART_NUMBER = 0xc60;
const CORTEX_M3_PART_NUMBER = 0xc23;
const CORTEX_CPUID_ADDRESS = 0xe000ed00;

export type CortexValidationResult = {
  cpuid: number;
  core: "Cortex-M0+" | "Cortex-M3";
  configuredFlashSizeKb: number;
};

export async function validateCortexTarget(
  target: CortexM,
  targetConfig: Exclude<CortexTargetConfig, { family: "rp2" }>
): Promise<CortexValidationResult> {
  const cpuid = (await target.readMem32(CORTEX_CPUID_ADDRESS)) >>> 0;
  const corePartNumber = (cpuid >>> 4) & 0x0fff;
  const expectedCorePartNumber = targetConfig.family === "py32"
    ? CORTEX_M0_PLUS_PART_NUMBER
    : CORTEX_M3_PART_NUMBER;
  const core = expectedCorePartNumber === CORTEX_M0_PLUS_PART_NUMBER
    ? "Cortex-M0+"
    : "Cortex-M3";

  if (corePartNumber !== expectedCorePartNumber) {
    throw new Error(
      `Núcleo incompatible para ${targetConfig.label}: se esperaba ${core} ` +
        `(part 0x${expectedCorePartNumber.toString(16)}), se detectó part ` +
        `0x${corePartNumber.toString(16)}. No se escribió la flash.`
    );
  }

  // The target catalog supplies the capacity used to bound firmware images.
  // The former size-register address for PY32F002A is reserved; do not read it.
  return {
    cpuid,
    core,
    configuredFlashSizeKb: targetConfig.flashSizeBytes / 1024,
  };
}

export function formatCortexValidation(
  targetLabel: string,
  result: CortexValidationResult
): string {
  return (
    `${targetLabel} · ${result.core} compatible (CPUID ${formatHex32(result.cpuid)}) · ` +
    `flash configurada ${result.configuredFlashSizeKb} KB`
  );
}
