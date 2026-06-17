import type { CortexM } from "dapjs";
import type { FirmwareImage, FlashCallbacks, Py32F0TargetConfig } from "../types";
import {
  alignUp,
  formatBytes,
  formatHex32,
  getUint32LE,
  isTransferWaitError,
  padBytes,
  sleep,
} from "../utils";

export const PY32_DBGMCU_IDCODE_ADDRESS = 0x40015800;
export const PY32_DAP_WAIT_RETRY = 0xffff;

const PY32_RCC_CR = 0x40021000;
const PY32_RCC_ICSCR = 0x40021004;
const PY32_RCC_CR_HSIRDY = 1 << 10;
const PY32_RCC_ICSCR_HSI_TRIM = 0x1fff;
const PY32_RCC_ICSCR_HSI_FS = 0xe000;
const PY32_RCC_ICSCR_HSI_FS_2 = 1 << 15;
const PY32_FLASH_ACR = 0x40022000;
const PY32_FLASH_KEYR = 0x40022008;
const PY32_FLASH_SR = 0x40022010;
const PY32_FLASH_CR = 0x40022014;
const PY32_FLASH_TS0 = 0x40022100;
const PY32_FLASH_TS1 = 0x40022104;
const PY32_FLASH_TS2P = 0x40022108;
const PY32_FLASH_TPS3 = 0x4002210c;
const PY32_FLASH_TS3 = 0x40022110;
const PY32_FLASH_PERTPE = 0x40022114;
const PY32_FLASH_SMERTPE = 0x40022118;
const PY32_FLASH_PRGTPE = 0x4002211c;
const PY32_FLASH_PRETPE = 0x40022120;
const PY32_FLASH_KEY1 = 0x45670123;
const PY32_FLASH_KEY2 = 0xcdef89ab;
const PY32_FLASH_SR_EOP = 1 << 0;
const PY32_FLASH_SR_WRPERR = 1 << 4;
const PY32_FLASH_SR_BSY = 1 << 16;
const PY32_FLASH_CR_PG = 1 << 0;
const PY32_FLASH_CR_SER = 1 << 11;
const PY32_FLASH_CR_PGSTRT = 1 << 19;
const PY32_FLASH_CR_EOPIE = 1 << 24;
const PY32_FLASH_CR_LOCK = 1 << 31;
const PY32_FLASH_CLEAR_FLAGS = PY32_FLASH_SR_EOP | PY32_FLASH_SR_WRPERR;

async function waitForPy32FlashReady(target: CortexM) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let status: number;

    try {
      status = await target.readMem32(PY32_FLASH_SR);
    } catch (err: unknown) {
      if (isTransferWaitError(err)) {
        await sleep(2);
        continue;
      }

      throw err;
    }

    if ((status & PY32_FLASH_SR_BSY) === 0) {
      if (status & PY32_FLASH_SR_WRPERR) {
        throw new Error(`PY32 flash write-protect error ${formatHex32(status)}`);
      }

      return;
    }

    await sleep(2);
  }

  throw new Error("Timed out waiting for PY32 flash");
}

async function writePy32Mem32AllowWait(
  target: CortexM,
  address: number,
  value: number
) {
  try {
    await target.writeMem32(address, value);
  } catch (err: unknown) {
    if (!isTransferWaitError(err)) throw err;
  }
}

async function clearPy32FlashStatus(target: CortexM) {
  await target.writeMem32(PY32_FLASH_SR, PY32_FLASH_CLEAR_FLAGS);
}

async function unlockPy32Flash(target: CortexM) {
  const control = await target.readMem32(PY32_FLASH_CR);
  if ((control & PY32_FLASH_CR_LOCK) === 0) return;

  await target.writeMem32(PY32_FLASH_KEYR, PY32_FLASH_KEY1);
  await target.writeMem32(PY32_FLASH_KEYR, PY32_FLASH_KEY2);

  const unlockedControl = await target.readMem32(PY32_FLASH_CR);
  if (unlockedControl & PY32_FLASH_CR_LOCK) {
    throw new Error("PY32 flash is still locked");
  }
}

async function waitForPy32HsiReady(target: CortexM) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const control = await target.readMem32(PY32_RCC_CR);
    if (control & PY32_RCC_CR_HSIRDY) return;
    await sleep(2);
  }

  throw new Error("Timed out waiting for PY32 HSI clock");
}

async function writePy32FlashTiming(
  target: CortexM,
  addresses: {
    ts0: number;
    ts2p: number;
    pertpe: number;
    smertpe: number;
    prgtpe: number;
  }
) {
  const timing0 = await target.readMem32(addresses.ts0);
  const timing1 = await target.readMem32(addresses.ts2p);
  const timing2 = await target.readMem32(addresses.pertpe);
  const timing3 = await target.readMem32(addresses.smertpe);
  const timing4 = await target.readMem32(addresses.prgtpe);

  await target.writeMem32(PY32_FLASH_TS0, timing0 & 0xff);
  await target.writeMem32(PY32_FLASH_TS3, (timing0 >>> 8) & 0xff);
  await target.writeMem32(PY32_FLASH_TS1, (timing0 >>> 16) & 0x1ff);
  await target.writeMem32(PY32_FLASH_TS2P, timing1 & 0xff);
  await target.writeMem32(PY32_FLASH_TPS3, (timing1 >>> 16) & 0x7ff);
  await target.writeMem32(PY32_FLASH_PERTPE, timing2 & 0x1ffff);
  await target.writeMem32(PY32_FLASH_SMERTPE, timing3 & 0x1ffff);
  await target.writeMem32(PY32_FLASH_PRGTPE, timing4 & 0xffff);
  await target.writeMem32(PY32_FLASH_PRETPE, (timing4 >>> 16) & 0xffff);
}

async function initPy32Flash(
  target: CortexM,
  timingProfile: Py32F0TargetConfig["timingProfile"]
): Promise<number> {
  const originalIcscr = await target.readMem32(PY32_RCC_ICSCR);

  if (timingProfile === "py32f071") {
    const calibration = await target.readMem32(0x1fff3220);
    await target.writeMem32(
      PY32_RCC_ICSCR,
      (originalIcscr & ~(PY32_RCC_ICSCR_HSI_FS | PY32_RCC_ICSCR_HSI_TRIM)) |
        (calibration & (PY32_RCC_ICSCR_HSI_FS | PY32_RCC_ICSCR_HSI_TRIM))
    );
    await waitForPy32HsiReady(target);
    await writePy32FlashTiming(target, {
      ts0: 0x1fff3238 + 4 * 0x28,
      ts2p: 0x1fff3240 + 4 * 0x28,
      pertpe: 0x1fff3248 + 4 * 0x28,
      smertpe: 0x1fff3250 + 4 * 0x28,
      prgtpe: 0x1fff3258 + 4 * 0x28,
    });
  } else {
    const trim = (await target.readMem32(0x1fff0f10)) & PY32_RCC_ICSCR_HSI_TRIM;
    const nextIcscr =
      (originalIcscr & ~(PY32_RCC_ICSCR_HSI_FS | PY32_RCC_ICSCR_HSI_TRIM)) |
      PY32_RCC_ICSCR_HSI_FS_2 |
      trim;

    await target.writeMem32(PY32_RCC_ICSCR, nextIcscr);
    await waitForPy32HsiReady(target);
    await writePy32FlashTiming(target, {
      ts0: 0x1fff0f1c + 4 * 0x14,
      ts2p: 0x1fff0f20 + 4 * 0x14,
      pertpe: 0x1fff0f24 + 4 * 0x14,
      smertpe: 0x1fff0f28 + 4 * 0x14,
      prgtpe: 0x1fff0f2c + 4 * 0x14,
    });
    await target.writeMem32(PY32_FLASH_ACR, 0);
  }

  await clearPy32FlashStatus(target);
  return originalIcscr;
}

async function restorePy32Clock(target: CortexM, originalIcscr: number) {
  await target.writeMem32(PY32_RCC_ICSCR, originalIcscr);
  await waitForPy32HsiReady(target);
}

async function erasePy32Sectors(
  target: CortexM,
  startAddress: number,
  byteLength: number,
  sectorSize: number,
  callbacks: FlashCallbacks
) {
  const eraseStart = Math.floor(startAddress / sectorSize) * sectorSize;
  const eraseEnd = alignUp(startAddress + byteLength, sectorSize);
  const sectorCount = (eraseEnd - eraseStart) / sectorSize;

  callbacks.addLog(`Erasing ${sectorCount} PY32 sector(s) of ${formatBytes(sectorSize)}\n`);

  for (let sector = 0; sector < sectorCount; sector += 1) {
    const sectorAddress = eraseStart + sector * sectorSize;

    await waitForPy32FlashReady(target);
    await clearPy32FlashStatus(target);
    await target.writeMem32(PY32_FLASH_CR, PY32_FLASH_CR_SER | PY32_FLASH_CR_EOPIE);
    await writePy32Mem32AllowWait(target, sectorAddress, 0xff);
    await waitForPy32FlashReady(target);
    await target.writeMem32(PY32_FLASH_CR, 0);

    const percent = Number((((sector + 1) / sectorCount) * 35).toFixed(1));
    callbacks.setProgress(percent);
    callbacks.addLog(
      `Erased PY32 sector ${sector + 1}/${sectorCount} at ${formatHex32(sectorAddress)}\n`
    );
  }
}

function getUint32ArrayLE(
  bytes: Uint8Array,
  byteOffset: number,
  wordCount: number
): Uint32Array {
  const words = new Uint32Array(wordCount);

  for (let word = 0; word < wordCount; word += 1) {
    words[word] = getUint32LE(bytes, byteOffset + word * 4);
  }

  return words;
}

async function programPy32Flash(
  target: CortexM,
  startAddress: number,
  data: Uint8Array,
  programPageSize: number,
  callbacks: FlashCallbacks
) {
  const padded = padBytes(data, programPageSize);
  const pageCount = padded.length / programPageSize;
  const wordsPerPage = programPageSize / 4;

  callbacks.addLog(
    `Programming ${formatBytes(padded.length)} at ${formatHex32(startAddress)} ` +
      `in ${formatBytes(programPageSize)} PY32 pages\n`
  );

  for (let page = 0; page < pageCount; page += 1) {
    const pageAddress = startAddress + page * programPageSize;
    const pageOffset = page * programPageSize;

    await waitForPy32FlashReady(target);
    await clearPy32FlashStatus(target);
    await target.writeMem32(PY32_FLASH_CR, PY32_FLASH_CR_PG | PY32_FLASH_CR_EOPIE);

    const pageWords = getUint32ArrayLE(padded, pageOffset, wordsPerPage);
    await target.writeBlock(pageAddress, pageWords.subarray(0, wordsPerPage - 1));
    await writePy32Mem32AllowWait(
      target,
      PY32_FLASH_CR,
      PY32_FLASH_CR_PG | PY32_FLASH_CR_EOPIE | PY32_FLASH_CR_PGSTRT
    );
    await writePy32Mem32AllowWait(
      target,
      pageAddress + (wordsPerPage - 1) * 4,
      pageWords[wordsPerPage - 1]
    );

    await waitForPy32FlashReady(target);
    await target.writeMem32(PY32_FLASH_CR, 0);

    const percent = 35 + Number((((page + 1) / pageCount) * 45).toFixed(1));
    callbacks.setProgress(percent);
  }
}

async function verifyPy32Flash(
  target: CortexM,
  startAddress: number,
  data: Uint8Array,
  programPageSize: number,
  callbacks: FlashCallbacks
) {
  const padded = padBytes(data, programPageSize);
  const wordCount = padded.length / 4;

  callbacks.addLog("Verifying PY32 flash...\n");

  const chunkWords = 256;
  for (let chunkStart = 0; chunkStart < wordCount; chunkStart += chunkWords) {
    const currentWordCount = Math.min(chunkWords, wordCount - chunkStart);
    const address = startAddress + chunkStart * 4;
    const actualWords = await target.readBlock(address, currentWordCount);

    for (let word = 0; word < currentWordCount; word += 1) {
      const absoluteWord = chunkStart + word;
      const expected = getUint32LE(padded, absoluteWord * 4);
      const actual = actualWords[word];

      if (actual !== expected) {
        throw new Error(
          `Verify failed at ${formatHex32(startAddress + absoluteWord * 4)}: ` +
            `expected ${formatHex32(expected)}, got ${formatHex32(actual)}`
        );
      }
    }

    const verifiedWords = chunkStart + currentWordCount;
    const percent = 80 + Number(((verifiedWords / wordCount) * 20).toFixed(1));
    callbacks.setProgress(percent);
  }
}

export async function flashPy32F0(
  target: CortexM,
  firmwareImage: FirmwareImage,
  targetConfig: Py32F0TargetConfig,
  callbacks: FlashCallbacks
) {
  let originalIcscr: number | null = null;

  try {
    await unlockPy32Flash(target);
    originalIcscr = await initPy32Flash(target, targetConfig.timingProfile);
    callbacks.addLog("PY32 flash unlocked and initialized\n");

    await erasePy32Sectors(
      target,
      firmwareImage.address,
      firmwareImage.data.length,
      targetConfig.pageSize,
      callbacks
    );

    await programPy32Flash(
      target,
      firmwareImage.address,
      firmwareImage.data,
      targetConfig.programPageSize,
      callbacks
    );

    await verifyPy32Flash(
      target,
      firmwareImage.address,
      firmwareImage.data,
      targetConfig.programPageSize,
      callbacks
    );
  } finally {
    if (originalIcscr !== null) {
      await restorePy32Clock(target, originalIcscr);
    }
  }
}
