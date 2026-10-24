import type { CortexM } from "dapjs";
import type { CortexTargetConfig } from "./types";
import { formatHex32, getDebugDeviceId } from "./utils";

const CORTEX_M0_PLUS_PART_NUMBER = 0xc60;
const CORTEX_M3_PART_NUMBER = 0xc23;
const CORTEX_CPUID_ADDRESS = 0xe000ed00;
const STM32_GD32_DEBUG_ID_ADDRESS = 0xe0042000;
const GD32_FMC_PRODUCT_ID_ADDRESS = 0x40022100;
const PY32_DEBUG_ID_ADDRESS = 0x40015800;

export type CortexValidationResult = {
  cpuid: number;
  core: "Cortex-M0+" | "Cortex-M3";
  flashSizeKb: number;
  identity: string;
};

function isMissingRegister(value: number): boolean {
  return value === 0 || value === 0xffffffff;
}

export async function validateCortexTarget(
  target: CortexM,
  targetConfig: CortexTargetConfig
): Promise<CortexValidationResult> {
  const cpuid = (await target.readMem32(CORTEX_CPUID_ADDRESS)) >>> 0;
  const corePartNumber = (cpuid >>> 4) & 0x0fff;
  const expectedCorePartNumber =
    targetConfig.family === "py32"
      ? CORTEX_M0_PLUS_PART_NUMBER
      : CORTEX_M3_PART_NUMBER;
  const core =
    expectedCorePartNumber === CORTEX_M0_PLUS_PART_NUMBER
      ? "Cortex-M0+"
      : "Cortex-M3";

  if (corePartNumber !== expectedCorePartNumber) {
    throw new Error(
      `Núcleo incompatible para ${targetConfig.label}: se esperaba ${core} ` +
        `(part 0x${expectedCorePartNumber.toString(16)}), se detectó part ` +
        `0x${corePartNumber.toString(16)}. No se escribió la flash.`
    );
  }

  const flashSizeRegister =
    (await target.readMem32(targetConfig.flashSizeAddress)) >>> 0;
  const flashSizeKb = flashSizeRegister & 0xffff;
  const expectedFlashSizeKb = targetConfig.flashSizeBytes / 1024;

  if (flashSizeKb !== expectedFlashSizeKb) {
    throw new Error(
      `Tamaño de flash incompatible para ${targetConfig.label}: se esperaban ` +
        `${expectedFlashSizeKb} KB y el dispositivo reportó ${flashSizeKb} KB. ` +
        "No se escribió la flash."
    );
  }

  let identity: string;

  if (targetConfig.family === "stm32") {
    const debugId =
      (await target.readMem32(STM32_GD32_DEBUG_ID_ADDRESS)) >>> 0;
    const deviceId = getDebugDeviceId(debugId);

    if (
      targetConfig.deviceId !== undefined &&
      deviceId !== targetConfig.deviceId
    ) {
      throw new Error(
        `Dispositivo incompatible: ${targetConfig.label} requiere ID ` +
          `0x${targetConfig.deviceId.toString(16)}, pero se detectó ` +
          `0x${deviceId.toString(16)}. No se escribió la flash.`
      );
    }

    identity = `DBGMCU ${formatHex32(debugId)}`;
  } else if (targetConfig.family === "gd32") {
    const debugId =
      (await target.readMem32(STM32_GD32_DEBUG_ID_ADDRESS)) >>> 0;
    const productId =
      (await target.readMem32(GD32_FMC_PRODUCT_ID_ADDRESS)) >>> 0;

    if (isMissingRegister(productId)) {
      throw new Error(
        `No se encontró el registro de producto GD32 para ${targetConfig.label}. ` +
          "No se escribió la flash."
      );
    }

    identity =
      `DBG ${formatHex32(debugId)} · FMC_PID ${formatHex32(productId)}`;
  } else {
    const debugId = (await target.readMem32(PY32_DEBUG_ID_ADDRESS)) >>> 0;

    if (isMissingRegister(debugId)) {
      throw new Error(
        `No se encontró el DBGMCU_IDCODE de PY32 para ${targetConfig.label}. ` +
          "No se escribió la flash."
      );
    }

    identity = `PY32 DBGMCU ${formatHex32(debugId)}`;
  }

  return { cpuid, core, flashSizeKb, identity };
}

export function formatCortexValidation(
  targetLabel: string,
  result: CortexValidationResult
): string {
  return (
    `${targetLabel} validado · ${result.core} · ${result.flashSizeKb} KB · ` +
    result.identity
  );
}
