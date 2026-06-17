import type { CortexM } from "dapjs";
import type { FirmwareImage, FlashCallbacks, Stm32F1TargetConfig } from "../types";
import {
  alignUp,
  formatBytes,
  formatHex32,
  getDebugDeviceId,
  getHalfwordFromRead,
  sleep,
} from "../utils";

export const STM32_DBGMCU_IDCODE_ADDRESS = 0xe0042000;

const STM32_FLASH_KEYR = 0x40022004;
const STM32_FLASH_SR = 0x4002200c;
const STM32_FLASH_CR = 0x40022010;
const STM32_FLASH_AR = 0x40022014;
const STM32_FLASH_KEY1 = 0x45670123;
const STM32_FLASH_KEY2 = 0xcdef89ab;
const STM32_FLASH_SR_BSY = 1 << 0;
const STM32_FLASH_SR_PGERR = 1 << 2;
const STM32_FLASH_SR_WRPRTERR = 1 << 4;
const STM32_FLASH_SR_EOP = 1 << 5;
const STM32_FLASH_CR_PG = 1 << 0;
const STM32_FLASH_CR_PER = 1 << 1;
const STM32_FLASH_CR_STRT = 1 << 6;
const STM32_FLASH_CR_LOCK = 1 << 7;
const STM32_FLASH_CLEAR_FLAGS =
  STM32_FLASH_SR_PGERR | STM32_FLASH_SR_WRPRTERR | STM32_FLASH_SR_EOP;

async function waitForFlashReady(target: CortexM) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = await target.readMem32(STM32_FLASH_SR);
    if ((status & STM32_FLASH_SR_BSY) === 0) {
      if (status & (STM32_FLASH_SR_PGERR | STM32_FLASH_SR_WRPRTERR)) {
        throw new Error(`STM32 flash error status ${formatHex32(status)}`);
      }

      return;
    }

    await sleep(2);
  }

  throw new Error("Timed out waiting for STM32 flash");
}

async function clearFlashStatus(target: CortexM) {
  await target.writeMem32(STM32_FLASH_SR, STM32_FLASH_CLEAR_FLAGS);
}

async function unlockStm32Flash(target: CortexM) {
  const control = await target.readMem32(STM32_FLASH_CR);
  if ((control & STM32_FLASH_CR_LOCK) === 0) return;

  await target.writeMem32(STM32_FLASH_KEYR, STM32_FLASH_KEY1);
  await target.writeMem32(STM32_FLASH_KEYR, STM32_FLASH_KEY2);

  const unlockedControl = await target.readMem32(STM32_FLASH_CR);
  if (unlockedControl & STM32_FLASH_CR_LOCK) {
    throw new Error("STM32 flash is still locked");
  }
}

async function eraseStm32Pages(
  target: CortexM,
  startAddress: number,
  byteLength: number,
  pageSize: number,
  callbacks: FlashCallbacks
) {
  const eraseLength = alignUp(byteLength, pageSize);
  const pageCount = eraseLength / pageSize;

  callbacks.addLog(`Erasing ${pageCount} page(s) of ${pageSize} bytes\n`);

  for (let page = 0; page < pageCount; page += 1) {
    const pageAddress = startAddress + page * pageSize;

    await waitForFlashReady(target);
    await clearFlashStatus(target);
    await target.writeMem32(STM32_FLASH_CR, STM32_FLASH_CR_PER);
    await target.writeMem32(STM32_FLASH_AR, pageAddress);
    await target.writeMem32(STM32_FLASH_CR, STM32_FLASH_CR_PER | STM32_FLASH_CR_STRT);
    await waitForFlashReady(target);
    await target.writeMem32(STM32_FLASH_CR, 0);

    const percent = Number((((page + 1) / pageCount) * 35).toFixed(1));
    callbacks.setProgress(percent);
    callbacks.addLog(`Erased page ${page + 1}/${pageCount} at ${formatHex32(pageAddress)}\n`);
  }
}

async function programStm32Flash(
  target: CortexM,
  startAddress: number,
  data: Uint8Array,
  callbacks: FlashCallbacks
) {
  const padded = data.length % 2 === 0
    ? data
    : new Uint8Array([...data, 0xff]);
  const halfwordCount = padded.length / 2;

  callbacks.addLog(`Programming ${formatBytes(padded.length)} at ${formatHex32(startAddress)}\n`);

  await waitForFlashReady(target);
  await clearFlashStatus(target);
  await target.writeMem32(STM32_FLASH_CR, STM32_FLASH_CR_PG);

  for (let index = 0; index < halfwordCount; index += 1) {
    const address = startAddress + index * 2;
    const value = padded[index * 2] | (padded[index * 2 + 1] << 8);

    await target.writeMem16(address, value);
    await waitForFlashReady(target);

    if (index % 128 === 0 || index === halfwordCount - 1) {
      const percent = 35 + Number((((index + 1) / halfwordCount) * 45).toFixed(1));
      callbacks.setProgress(percent);
    }
  }

  await target.writeMem32(STM32_FLASH_CR, 0);
}

async function verifyStm32Flash(
  target: CortexM,
  startAddress: number,
  data: Uint8Array,
  callbacks: FlashCallbacks
) {
  const padded = data.length % 2 === 0
    ? data
    : new Uint8Array([...data, 0xff]);
  const halfwordCount = padded.length / 2;

  callbacks.addLog("Verifying flash...\n");

  for (let index = 0; index < halfwordCount; index += 1) {
    const address = startAddress + index * 2;
    const expected = padded[index * 2] | (padded[index * 2 + 1] << 8);
    const actual = getHalfwordFromRead(address, await target.readMem16(address));

    if (actual !== expected) {
      throw new Error(
        `Verify failed at ${formatHex32(address)}: expected 0x${expected
          .toString(16)
          .padStart(4, "0")}, got 0x${actual.toString(16).padStart(4, "0")}`
      );
    }

    if (index % 256 === 0 || index === halfwordCount - 1) {
      const percent = 80 + Number((((index + 1) / halfwordCount) * 20).toFixed(1));
      callbacks.setProgress(percent);
    }
  }
}

export async function assertStm32DeviceId(
  target: CortexM,
  targetConfig: Stm32F1TargetConfig
) {
  if (targetConfig.deviceId === undefined) return;

  const debugId = await target.readMem32(STM32_DBGMCU_IDCODE_ADDRESS);
  const deviceId = getDebugDeviceId(debugId);
  if (deviceId !== targetConfig.deviceId) {
    throw new Error(
      `Expected ${targetConfig.label} device id 0x${targetConfig.deviceId.toString(16)}, got 0x${deviceId.toString(16)}`
    );
  }
}

export async function flashStm32F1(
  target: CortexM,
  firmwareImage: FirmwareImage,
  targetConfig: Stm32F1TargetConfig,
  callbacks: FlashCallbacks
) {
  await assertStm32DeviceId(target, targetConfig);
  await unlockStm32Flash(target);
  callbacks.addLog("Flash unlocked\n");

  await eraseStm32Pages(
    target,
    firmwareImage.address,
    firmwareImage.data.length,
    targetConfig.pageSize,
    callbacks
  );

  await programStm32Flash(
    target,
    firmwareImage.address,
    firmwareImage.data,
    callbacks
  );

  await verifyStm32Flash(
    target,
    firmwareImage.address,
    firmwareImage.data,
    callbacks
  );
}
