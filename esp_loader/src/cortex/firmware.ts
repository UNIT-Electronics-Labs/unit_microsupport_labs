import type { CortexTargetConfig, FirmwareImage } from "./types";
import { formatHex32 } from "./utils";

function isElf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  );
}

const UF2_MAGIC_START0 = 0x0a324655;
const UF2_MAGIC_START1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
const UF2_BLOCK_SIZE = 512;
const UF2_DATA_OFFSET = 32;

function isUf2(bytes: Uint8Array): boolean {
  if (bytes.length < UF2_BLOCK_SIZE || bytes.length % UF2_BLOCK_SIZE !== 0) {
    return false;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(0, true) === UF2_MAGIC_START0 &&
    view.getUint32(4, true) === UF2_MAGIC_START1 &&
    view.getUint32(UF2_BLOCK_SIZE - 4, true) === UF2_MAGIC_END
  );
}

function parseUf2Image(bytes: Uint8Array, target: CortexTargetConfig): FirmwareImage {
  const flashStart = target.flashBase;
  const flashEnd = target.flashBase + target.flashSizeBytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks: Array<{ address: number; data: Uint8Array }> = [];

  for (let offset = 0; offset < bytes.length; offset += UF2_BLOCK_SIZE) {
    if (
      view.getUint32(offset, true) !== UF2_MAGIC_START0 ||
      view.getUint32(offset + 4, true) !== UF2_MAGIC_START1 ||
      view.getUint32(offset + UF2_BLOCK_SIZE - 4, true) !== UF2_MAGIC_END
    ) {
      throw new Error("Invalid UF2 block");
    }

    const address = view.getUint32(offset + 12, true);
    const payloadSize = view.getUint32(offset + 16, true);
    if (payloadSize === 0 || payloadSize > UF2_BLOCK_SIZE - UF2_DATA_OFFSET - 4) {
      throw new Error("Invalid UF2 payload size");
    }
    if (address < flashStart || address + payloadSize > flashEnd) {
      throw new Error(`UF2 block is outside target flash at ${formatHex32(address)}`);
    }

    blocks.push({
      address,
      data: bytes.slice(offset + UF2_DATA_OFFSET, offset + UF2_DATA_OFFSET + payloadSize),
    });
  }

  if (blocks.length === 0) throw new Error("UF2 has no flash blocks");
  blocks.sort((left, right) => left.address - right.address);
  const startAddress = blocks[0].address;
  const endAddress = Math.max(...blocks.map((block) => block.address + block.data.length));
  const image = new Uint8Array(endAddress - startAddress);
  image.fill(0xff);

  for (const block of blocks) image.set(block.data, block.address - startAddress);
  return { address: startAddress, data: image, format: "uf2" };
}

export function parseFirmwareImage(
  bytes: Uint8Array,
  fileName: string,
  target: CortexTargetConfig
): FirmwareImage {
  if (isUf2(bytes)) return parseUf2Image(bytes, target);

  if (!isElf(bytes)) {
    if (!fileName.toLowerCase().endsWith(".bin")) {
      throw new Error("Only raw .bin, .uf2, or 32-bit little-endian ARM .elf is supported");
    }

    return {
      address: target.flashBase,
      data: bytes,
      format: "bin",
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint8(4) !== 1 || view.getUint8(5) !== 1) {
    throw new Error("Only 32-bit little-endian ELF files are supported");
  }

  if (view.getUint16(18, true) !== 40) {
    throw new Error("ELF is not for ARM");
  }

  const programHeaderOffset = view.getUint32(28, true);
  const programHeaderEntrySize = view.getUint16(42, true);
  const programHeaderCount = view.getUint16(44, true);
  const flashStart = target.flashBase;
  const flashEnd = target.flashBase + target.flashSizeBytes;
  const segments: Array<{ address: number; data: Uint8Array }> = [];

  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderEntrySize;
    const type = view.getUint32(offset, true);
    if (type !== 1) continue;

    const fileOffset = view.getUint32(offset + 4, true);
    const virtualAddress = view.getUint32(offset + 8, true);
    const physicalAddress = view.getUint32(offset + 12, true);
    const fileSize = view.getUint32(offset + 16, true);
    const address = physicalAddress || virtualAddress;

    if (fileSize === 0 || address < flashStart || address >= flashEnd) continue;

    if (address + fileSize > flashEnd) {
      throw new Error(`ELF segment exceeds target flash at ${formatHex32(address)}`);
    }

    segments.push({
      address,
      data: bytes.slice(fileOffset, fileOffset + fileSize),
    });
  }

  if (segments.length === 0) {
    throw new Error("ELF has no loadable flash segments");
  }

  segments.sort((left, right) => left.address - right.address);

  const startAddress = segments[0].address;
  const endAddress = Math.max(
    ...segments.map((segment) => segment.address + segment.data.length)
  );
  const image = new Uint8Array(endAddress - startAddress);
  image.fill(0xff);

  for (const segment of segments) {
    image.set(segment.data, segment.address - startAddress);
  }

  return {
    address: startAddress,
    data: image,
    format: "elf",
  };
}
