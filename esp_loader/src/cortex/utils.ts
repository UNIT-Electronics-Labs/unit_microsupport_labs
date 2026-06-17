export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransferWaitError(error: unknown): boolean {
  return getErrorMessage(error).includes("Transfer response WAIT");
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

export function getDebugDeviceId(idcode: number): number {
  return idcode & 0x0fff;
}

export function getDebugRevisionId(idcode: number): number {
  return (idcode >>> 16) & 0xffff;
}

export function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} bytes`;
  return `${(value / 1024).toFixed(1)} KB`;
}

export function getHalfwordFromRead(address: number, value: number): number {
  return (value >>> ((address & 0x02) << 3)) & 0xffff;
}

export function getWordFromRead(address: number, value: number): number {
  return value >>> ((address & 0x03) << 3);
}

export function getUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

export function padBytes(data: Uint8Array, alignment: number): Uint8Array {
  const paddedLength = alignUp(data.length, alignment);
  if (paddedLength === data.length) return data;

  const padded = new Uint8Array(paddedLength);
  padded.fill(0xff);
  padded.set(data);
  return padded;
}
