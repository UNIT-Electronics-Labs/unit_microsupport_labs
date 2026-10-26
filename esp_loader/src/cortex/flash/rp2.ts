import type { CortexM } from "dapjs";
import type { FirmwareImage, FlashCallbacks, Rp2TargetConfig } from "../types";
import { alignUp, formatBytes, formatHex32, getHalfwordFromRead, getUint32LE, padBytes, sleep } from "../utils";

const RP2_BOOTROM_MAGIC_ADDRESS = 0x10;
const RP2_BOOTROM_MAGIC = 0x754d;
const RP2_ROM_FUNC_TABLE_OFFSET = 0x14;
const RP2_ROM_ARM_SECURE = 0x0004;
const RP2_RAM_BUFFER = 0x2003d000;
const RP2_RAM_BREAKPOINT = 0x2003df00;
const RP2_RAM_STACK = 0x20041ff0;
const RP2_PAGE_SIZE = 256;
const RP2_BLOCK_ERASE_SIZE = 64 * 1024;
const RP2_BLOCK_ERASE_COMMAND = 0xd8;

type Rp2RomFunctions = {
  connectInternalFlash: number;
  exitXip: number;
  erase: number;
  program: number;
  flushCache: number;
  enterCommandXip: number;
};

function romTag(first: string, second: string): number {
  return first.charCodeAt(0) | (second.charCodeAt(0) << 8);
}

async function readHalfword(target: CortexM, address: number): Promise<number> {
  return getHalfwordFromRead(address, await target.readMem16(address));
}

async function waitForBreakpoint(target: CortexM, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await target.isHalted()) return;
    await sleep(5);
  }
  await target.halt(false);
  throw new Error("Timed out waiting for RP2 Boot ROM call");
}

async function callRomFunction(
  target: CortexM,
  functionAddress: number,
  args: readonly number[] = [],
  timeoutMs = 10_000
): Promise<number> {
  await target.writeMem16(RP2_RAM_BREAKPOINT, 0xbe00);
  await target.writeCoreRegister(13, RP2_RAM_STACK);
  await target.writeCoreRegister(14, RP2_RAM_BREAKPOINT | 1);
  await Promise.all(
    args.slice(0, 4).map((value, index) => target.writeCoreRegister(index, value))
  );
  await target.writeCoreRegister(15, functionAddress | 1);
  await target.resume(false);
  await waitForBreakpoint(target, timeoutMs);
  return target.readCoreRegister(0);
}

async function lookupRp2350RomFunction(target: CortexM, tag: number): Promise<number> {
  // RP2350 A1+ uses a flagged table. Reading it directly is intentional: calling
  // the ROM lookup helper requires the RCP to have been initialised first.
  let entry = await readHalfword(target, RP2_ROM_FUNC_TABLE_OFFSET);

  // A0 uses the legacy format (tag, address, flags) in the low ROM table.
  if (entry < 0x7c00) {
    for (let index = 0; index < 256; index += 1) {
      const entryTag = await readHalfword(target, entry);
      if (entryTag === 0) break;
      if (entryTag === tag) return (await readHalfword(target, entry + 2)) | 1;
      entry += 6;
    }
  } else {
    for (let index = 0; index < 512; index += 1) {
      const entryTag = await readHalfword(target, entry);
      if (entryTag === 0) break;
      const flags = await readHalfword(target, entry + 2);
      const values = entry + 4;
      if (entryTag === tag && (flags & RP2_ROM_ARM_SECURE)) {
        let precedingValues = 0;
        for (let bit = 1; bit < RP2_ROM_ARM_SECURE; bit <<= 1) {
          if (flags & bit) precedingValues += 1;
        }
        return (await readHalfword(target, values + precedingValues * 2)) | 1;
      }

      let valueCount = 0;
      for (let bits = flags; bits !== 0; bits >>>= 1) {
        if (bits & 1) valueCount += 1;
      }
      entry = values + valueCount * 2;
    }
  }
  throw new Error(`RP2350 Boot ROM secure function ${formatHex32(tag)} was not found`);
}

async function resolveRomFunctions(
  target: CortexM,
  addLog: (text: string) => void
): Promise<Rp2RomFunctions> {
  const resolve = async (name: string, first: string, second: string) => {
    addLog(`Boot ROM: resolviendo ${name}...\n`);
    return lookupRp2350RomFunction(target, romTag(first, second));
  };
  const connectInternalFlash = await resolve("IF", "I", "F");
  const exitXip = await resolve("EX", "E", "X");
  const erase = await resolve("RE", "R", "E");
  const program = await resolve("RP", "R", "P");
  const flushCache = await resolve("FC", "F", "C");
  const enterCommandXip = await resolve("CX", "C", "X");
  return { connectInternalFlash, exitXip, erase, program, flushCache, enterCommandXip };
}

function bytesToWords(data: Uint8Array): Uint32Array {
  const words = new Uint32Array(data.length / 4);
  for (let index = 0; index < words.length; index += 1) {
    words[index] = getUint32LE(data, index * 4);
  }
  return words;
}

async function verifyRp2Flash(
  target: CortexM,
  image: FirmwareImage,
  callbacks: FlashCallbacks
) {
  callbacks.addLog("Verifying QSPI flash...\n");
  const padded = padBytes(image.data, RP2_PAGE_SIZE);
  const words = bytesToWords(padded);
  const verifyChunkWords = 256;
  for (let offset = 0; offset < words.length; offset += verifyChunkWords) {
    const count = Math.min(verifyChunkWords, words.length - offset);
    const actual = await target.readBlock(image.address + offset * 4, count);
    for (let word = 0; word < count; word += 1) {
      if (actual[word] !== words[offset + word]) {
        throw new Error(
          `Verify failed at ${formatHex32(image.address + (offset + word) * 4)}: ` +
            `expected ${formatHex32(words[offset + word])}, got ${formatHex32(actual[word])}`
        );
      }
    }
    callbacks.setProgress(80 + Number((((offset + count) / words.length) * 20).toFixed(1)));
  }
}

export async function detectRp2Chip(target: CortexM): Promise<"rp2040" | "rp2350"> {
  const magic = (await target.readMem32(RP2_BOOTROM_MAGIC_ADDRESS)) & 0x00ffffff;
  if ((magic & 0xffff) !== RP2_BOOTROM_MAGIC) {
    throw new Error(`RP2 Boot ROM was not found (magic ${formatHex32(magic)})`);
  }
  if ((magic >>> 16) === 1) return "rp2040";
  if ((magic >>> 16) === 2) return "rp2350";
  throw new Error(`Unsupported RP2 Boot ROM version ${magic >>> 16}`);
}

export async function flashRp2(
  target: CortexM,
  image: FirmwareImage,
  targetConfig: Rp2TargetConfig,
  callbacks: FlashCallbacks
) {
  if (image.address % RP2_PAGE_SIZE !== 0) {
    throw new Error(`RP2 firmware must start on a ${RP2_PAGE_SIZE}-byte boundary`);
  }
  const detectedChip = await detectRp2Chip(target);
  if (detectedChip !== targetConfig.chip) {
    throw new Error(`Selected ${targetConfig.label}, but the connected chip is ${detectedChip.toUpperCase()}`);
  }

  const rom = await resolveRomFunctions(target, callbacks.addLog);
  const padded = padBytes(image.data, RP2_PAGE_SIZE);
  const eraseStart = Math.floor((image.address - targetConfig.flashBase) / targetConfig.sectorSize) * targetConfig.sectorSize;
  const eraseLength = alignUp(image.address - targetConfig.flashBase + padded.length, targetConfig.sectorSize) - eraseStart;
  callbacks.addLog(`RP2 Boot ROM detected: ${detectedChip.toUpperCase()}\n`);
  callbacks.addLog(`Erasing ${formatBytes(eraseLength)} of QSPI flash\n`);

  let xipNeedsRecovery = false;
  try {
    await callRomFunction(target, rom.connectInternalFlash);
    await callRomFunction(target, rom.exitXip);
    xipNeedsRecovery = true;
    await callRomFunction(
      target,
      rom.erase,
      [eraseStart, eraseLength, RP2_BLOCK_ERASE_SIZE, RP2_BLOCK_ERASE_COMMAND],
      Math.max(15_000, (eraseLength / targetConfig.sectorSize) * 2_500)
    );
    callbacks.setProgress(35);

    callbacks.addLog(`Programming ${formatBytes(padded.length)} in ${RP2_PAGE_SIZE}-byte pages\n`);
    for (let offset = 0; offset < padded.length; offset += RP2_PAGE_SIZE) {
      await target.writeBlock(RP2_RAM_BUFFER, bytesToWords(padded.slice(offset, offset + RP2_PAGE_SIZE)));
      await callRomFunction(target, rom.program, [image.address - targetConfig.flashBase + offset, RP2_RAM_BUFFER, RP2_PAGE_SIZE]);
      callbacks.setProgress(35 + Number((((offset + RP2_PAGE_SIZE) / padded.length) * 45).toFixed(1)));
    }

    await callRomFunction(target, rom.flushCache);
    await callRomFunction(target, rom.enterCommandXip);
    xipNeedsRecovery = false;
    await verifyRp2Flash(target, image, callbacks);
  } finally {
    if (xipNeedsRecovery) {
      try {
        await callRomFunction(target, rom.flushCache);
        await callRomFunction(target, rom.enterCommandXip);
      } catch {
        callbacks.addLog("Warning: could not restore QSPI XIP mode after the failed operation.\n");
      }
    }
  }
}
