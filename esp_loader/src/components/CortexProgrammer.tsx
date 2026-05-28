import { useEffect, useRef, useState } from "react";
import {
  CmsisDAP,
  CortexM,
  type Transport as DapTransport,
  WebUSB as DapWebUSB,
} from "dapjs";

const DAP_INFO_REQUESTS = {
  VENDOR_ID: 0x01,
  PRODUCT_ID: 0x02,
  SERIAL_NUMBER: 0x03,
  CMSIS_DAP_FW_VERSION: 0x04,
  CAPABILITIES: 0xf0,
  PACKET_COUNT: 0xfe,
  PACKET_SIZE: 0xff,
} as const;

const CMSIS_DAP_USB_FILTERS = [
  { vendorId: 0x0d28 },
  { vendorId: 0xc251 },
  { vendorId: 0x1209 },
  { vendorId: 0x1fc9 },
  { vendorId: 0x0483 },
  { vendorId: 0x2e8a },
  { vendorId: 0x303a },
] as const;

const CORTEX_CPUID_ADDRESS = 0xe000ed00;
const STM32_DBGMCU_IDCODE_ADDRESS = 0xe0042000;
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

const TARGETS = {
  stm32f103rc: {
    label: "STM32F103RC",
    description: "Cortex-M3, 256 KB flash",
    flashBase: 0x08000000,
    flashSizeBytes: 256 * 1024,
    pageSize: 2048,
    deviceId: 0x414,
  },
  gd32f150g8: {
    label: "GD32F150G8",
    description: "Cortex-M3, 64 KB flash",
    flashBase: 0x08000000,
    flashSizeBytes: 64 * 1024,
    pageSize: 1024,
  },
} as const;

type TargetKey = keyof typeof TARGETS;

type FirmwareImage = {
  address: number;
  data: Uint8Array;
  format: "bin" | "elf";
};

type WebHidInputReportEvent = Event & {
  data: DataView;
};

type WebHidDevice = EventTarget & {
  opened: boolean;
  productName?: string;
  vendorId?: number;
  productId?: number;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
};

type WebHidApi = {
  getDevices?: () => Promise<WebHidDevice[]>;
  requestDevice(options: { filters: unknown[] }): Promise<WebHidDevice[]>;
};

type FileSystemFileHandleLike = {
  getFile(): Promise<File>;
  queryPermission?: (descriptor?: { mode?: "read" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" }) => Promise<PermissionState>;
};

type WindowWithFilePicker = Window & {
  showOpenFilePicker?: (options?: {
    excludeAcceptAllOption?: boolean;
    multiple?: boolean;
  }) => Promise<FileSystemFileHandleLike[]>;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUsbId(value?: number): string {
  return value === undefined ? "????" : value.toString(16).padStart(4, "0");
}

function formatHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function getStm32DeviceId(idcode: number): number {
  return idcode & 0x0fff;
}

function getStm32RevisionId(idcode: number): number {
  return (idcode >>> 16) & 0xffff;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} bytes`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function getHalfwordFromRead(address: number, value: number): number {
  return (value >>> ((address & 0x02) << 3)) & 0xffff;
}

function isElf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  );
}

function parseFirmwareImage(
  bytes: Uint8Array,
  fileName: string,
  target: (typeof TARGETS)[TargetKey]
): FirmwareImage {
  if (!isElf(bytes)) {
    if (!fileName.toLowerCase().endsWith(".bin")) {
      throw new Error("Only raw .bin or 32-bit little-endian ARM .elf is supported");
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

function looksLikeCmsisDapDevice(device: {
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
}): boolean {
  const text = [
    device.productName,
    device.manufacturerName,
    device.serialNumber,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    text.includes("cmsis") ||
    text.includes("dap") ||
    text.includes("daplink") ||
    text.includes("unit") ||
    text.includes("ch552")
  );
}

class WebHidCmsisDapTransport implements DapTransport {
  public readonly packetSize = 64;

  private device: WebHidDevice;

  constructor(device: WebHidDevice) {
    this.device = device;
  }

  async open(): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }
  }

  async close(): Promise<void> {
    if (this.device.opened) {
      await this.device.close();
    }
  }

  async read(): Promise<DataView> {
    return await new Promise((resolve) => {
      const onInputReport = (event: Event) => {
        this.device.removeEventListener("inputreport", onInputReport);
        const data = (event as WebHidInputReportEvent).data;
        resolve(
          new DataView(
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          )
        );
      };

      this.device.addEventListener("inputreport", onInputReport);
    });
  }

  async write(data: BufferSource): Promise<void> {
    const source =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const packet = new Uint8Array(this.packetSize);
    packet.set(source.slice(0, this.packetSize));
    await this.device.sendReport(0, packet);
  }
}

export default function CortexProgrammer() {
  const [selectedTarget, setSelectedTarget] = useState<TargetKey>("stm32f103rc");
  const [logs, setLogs] = useState("");
  const [testing, setTesting] = useState(false);
  const [connectingTarget, setConnectingTarget] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [firmware, setFirmware] = useState<File | null>(null);
  const [firmwareBytes, setFirmwareBytes] = useState<Uint8Array | null>(null);
  const [firmwareHandle, setFirmwareHandle] =
    useState<FileSystemFileHandleLike | null>(null);
  const [firmwareName, setFirmwareName] = useState("");
  const [progress, setProgress] = useState(0);
  const logsContainerRef = useRef<HTMLDivElement | null>(null);

  function addLog(text: string) {
    setLogs((prev) => prev + text);
  }

  async function setSelectedFirmware(
    file: File | null,
    handle: FileSystemFileHandleLike | null
  ) {
    setFirmware(file);
    setFirmwareHandle(handle);
    setFirmwareName(file?.name ?? "");
    setFirmwareBytes(null);

    if (file) {
      if (!handle) {
        setFirmwareBytes(new Uint8Array(await file.arrayBuffer()));
      }

      addLog(
        `Cortex firmware selected: ${file.name} (${formatBytes(file.size)})\n`
      );
    }
  }

  async function pickFirmwareFile() {
    const picker = (window as WindowWithFilePicker).showOpenFilePicker;

    if (!picker) {
      addLog("File picker handle API is not available; use the file input.\n");
      return;
    }

    const [handle] = await picker({
      excludeAcceptAllOption: false,
      multiple: false,
    });

    if (!handle) return;

    const file = await handle.getFile();
    await setSelectedFirmware(file, handle);
  }

  async function askFirmwareForFlash(): Promise<{
    bytes: Uint8Array;
    name: string;
    size: number;
  } | null> {
    return getReadableFirmwareData();
  }

  async function getReadableFirmwareData(): Promise<{
    bytes: Uint8Array;
    name: string;
    size: number;
  }> {
    if (firmwareHandle) {
      const permission = await firmwareHandle.queryPermission?.({ mode: "read" });
      if (permission === "denied") {
        const nextPermission = await firmwareHandle.requestPermission?.({
          mode: "read",
        });
        if (nextPermission === "denied") {
          throw new Error("Permission to read the firmware file was denied");
        }
      }

      const freshFile = await firmwareHandle.getFile();
      setFirmware(freshFile);
      setFirmwareName(freshFile.name);
      return {
        bytes: new Uint8Array(await freshFile.arrayBuffer()),
        name: freshFile.name,
        size: freshFile.size,
      };
    }

    if (!firmware || !firmwareBytes) {
      throw new Error("Select a Cortex firmware .bin");
    }

    return {
      bytes: firmwareBytes,
      name: firmware.name,
      size: firmware.size,
    };
  }

  function getUsbApi() {
    return (
      navigator as Navigator & {
        usb?: {
          requestDevice(options?: unknown): Promise<unknown>;
        };
      }
    ).usb;
  }

  function getHidApi() {
    return (navigator as Navigator & { hid?: WebHidApi }).hid;
  }

  async function readCmsisDapInfo(transport: DapTransport) {
    await transport.open();

    const dap = new CmsisDAP(transport);
    const infoRequests = [
      ["Vendor", DAP_INFO_REQUESTS.VENDOR_ID],
      ["Product", DAP_INFO_REQUESTS.PRODUCT_ID],
      ["Serial", DAP_INFO_REQUESTS.SERIAL_NUMBER],
      ["CMSIS-DAP FW", DAP_INFO_REQUESTS.CMSIS_DAP_FW_VERSION],
      ["Packet count", DAP_INFO_REQUESTS.PACKET_COUNT],
      ["Packet size", DAP_INFO_REQUESTS.PACKET_SIZE],
      ["Capabilities", DAP_INFO_REQUESTS.CAPABILITIES],
    ] as const;

    for (const [label, request] of infoRequests) {
      try {
        const value = await dap.dapInfo(request);
        addLog(`${label}: ${value}\n`);
      } catch (err: unknown) {
        addLog(`${label}: unavailable (${getErrorMessage(err)})\n`);
      }
    }
  }

  async function waitForFlashReady(target: CortexM) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const status = await target.readMem32(STM32_FLASH_SR);
      if ((status & STM32_FLASH_SR_BSY) === 0) {
        if (status & (STM32_FLASH_SR_PGERR | STM32_FLASH_SR_WRPRTERR)) {
          throw new Error(`STM32 flash error status ${formatHex32(status)}`);
        }

        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2));
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
    pageSize: number
  ) {
    const eraseLength = alignUp(byteLength, pageSize);
    const pageCount = eraseLength / pageSize;

    addLog(`Erasing ${pageCount} page(s) of ${pageSize} bytes\n`);

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
      setProgress(percent);
      addLog(`Erased page ${page + 1}/${pageCount} at ${formatHex32(pageAddress)}\n`);
    }
  }

  async function programStm32Flash(
    target: CortexM,
    startAddress: number,
    data: Uint8Array
  ) {
    const padded = data.length % 2 === 0
      ? data
      : new Uint8Array([...data, 0xff]);
    const halfwordCount = padded.length / 2;

    addLog(`Programming ${formatBytes(padded.length)} at ${formatHex32(startAddress)}\n`);

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
        setProgress(percent);
      }
    }

    await target.writeMem32(STM32_FLASH_CR, 0);
  }

  async function verifyStm32Flash(
    target: CortexM,
    startAddress: number,
    data: Uint8Array
  ) {
    const padded = data.length % 2 === 0
      ? data
      : new Uint8Array([...data, 0xff]);
    const halfwordCount = padded.length / 2;

    addLog("Verifying flash...\n");

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
        setProgress(percent);
      }
    }
  }

  async function requestCmsisDapTransport(): Promise<DapTransport | null> {
    const hid = getHidApi();
    const usb = getUsbApi();

    if (!hid && !usb) {
      alert("WebHID/WebUSB APIs are not supported");
      return null;
    }

    if (hid) {
      const rememberedDevices = (await hid.getDevices?.()) ?? [];
      let device =
        rememberedDevices.find((currentDevice) =>
          looksLikeCmsisDapDevice(currentDevice)
        ) ?? null;

      if (device) {
        addLog("Using remembered WebHID CMSIS-DAP probe.\n");
      } else {
        addLog("Using WebHID. Select the UnitElectronics CMSIS-DAP probe.\n");
        const devices = await hid.requestDevice({ filters: [] });
        device = devices[0] ?? null;
      }

      if (!device) {
        addLog("No HID device selected\n");
        return null;
      }

      addLog(
        `HID device selected: ${device.productName ?? "unknown product"} ` +
          `(${formatUsbId(device.vendorId)}:${formatUsbId(device.productId)})\n`
      );

      if (!looksLikeCmsisDapDevice(device)) {
        addLog("Selected device does not look like a CMSIS-DAP probe.\n");
        return null;
      }

      return new WebHidCmsisDapTransport(device);
    }

    if (!usb) return null;

    addLog("Using WebUSB fallback.\n");
    const device = await usb.requestDevice({
      filters: [
        ...CMSIS_DAP_USB_FILTERS,
        { classCode: 0xff },
      ],
    });

    const usbDevice = device as {
      vendorId?: number;
      productId?: number;
      productName?: string;
      manufacturerName?: string;
      serialNumber?: string;
    };

    addLog(
      `USB device selected: ${usbDevice.productName ?? "unknown product"} ` +
        `(${formatUsbId(usbDevice.vendorId)}:${formatUsbId(usbDevice.productId)})\n`
    );

    if (!looksLikeCmsisDapDevice(usbDevice)) {
      addLog("Selected device does not look like a CMSIS-DAP probe.\n");
      return null;
    }

    return new DapWebUSB(device as ConstructorParameters<typeof DapWebUSB>[0]);
  }

  async function testCmsisDap() {
    setTesting(true);
    addLog("\nSearching Cortex CMSIS-DAP probe...\n");

    let transport: DapTransport | null = null;

    try {
      transport = await requestCmsisDapTransport();
      if (transport) {
        await readCmsisDapInfo(transport);
      }

      addLog("CMSIS-DAP probe test finished\n");
    } catch (err: unknown) {
      console.error(err);
      addLog(`CMSIS-DAP Error: ${getErrorMessage(err)}\n`);
    } finally {
      try {
        await transport?.close();
      } catch {
        // Already closed or unavailable.
      }

      setTesting(false);
    }
  }

  async function connectCortexTarget() {
    setConnectingTarget(true);
    addLog("\nConnecting to Cortex target over SWD...\n");

    let transport: DapTransport | null = null;
    let target: CortexM | null = null;

    try {
      transport = await requestCmsisDapTransport();
      if (!transport) return;

      target = new CortexM(transport);
      await target.connect();
      addLog("SWD connected\n");

      await target.halt();
      addLog("Core halted\n");

      const targetConfig = TARGETS[selectedTarget];
      const cpuid = await target.readMem32(CORTEX_CPUID_ADDRESS);
      addLog(`CPUID: ${formatHex32(cpuid)}\n`);

      try {
        const debugId = await target.readMem32(STM32_DBGMCU_IDCODE_ADDRESS);
        addLog(
          `DBGMCU_IDCODE: ${formatHex32(debugId)} ` +
            `(dev ${formatHex32(getStm32DeviceId(debugId))}, ` +
            `rev 0x${getStm32RevisionId(debugId).toString(16).padStart(4, "0")})\n`
        );
      } catch {
        addLog("DBGMCU_IDCODE: unavailable\n");
      }

      addLog(
        `Configured target flash: ${formatBytes(targetConfig.flashSizeBytes)} ` +
          `at ${formatHex32(targetConfig.flashBase)}\n`
      );

      await target.resume(false);
      addLog("Core resumed\n");
      addLog("Cortex target probe finished\n");
    } catch (err: unknown) {
      console.error(err);
      addLog(`Cortex target error: ${getErrorMessage(err)}\n`);
    } finally {
      try {
        await target?.disconnect();
      } catch {
        try {
          await transport?.close();
        } catch {
          // Already closed or unavailable.
        }
      }

      setConnectingTarget(false);
    }
  }

  async function flashCortexFirmware() {
    let selectedFirmware: {
      bytes: Uint8Array;
      name: string;
      size: number;
    };

    try {
      const pickedFirmware = await askFirmwareForFlash();
      if (!pickedFirmware) return;
      selectedFirmware = pickedFirmware;
    } catch (err: unknown) {
      alert(getErrorMessage(err));
      return;
    }

    setFlashing(true);
    setProgress(0);
    addLog(`\nFlashing Cortex firmware: ${selectedFirmware.name}\n`);

    let transport: DapTransport | null = null;
    let target: CortexM | null = null;

    try {
      const targetConfig = TARGETS[selectedTarget];
      const firmwareImage = parseFirmwareImage(
        selectedFirmware.bytes,
        selectedFirmware.name,
        targetConfig
      );
      const firmwareBytes = firmwareImage.data;
      const flashOffset = firmwareImage.address - targetConfig.flashBase;

      if (
        flashOffset < 0 ||
        flashOffset + firmwareBytes.length > targetConfig.flashSizeBytes
      ) {
        throw new Error(
          `Firmware image at ${formatHex32(firmwareImage.address)} exceeds ${targetConfig.label} flash`
        );
      }

      transport = await requestCmsisDapTransport();
      if (!transport) return;

      target = new CortexM(transport);
      await target.connect();
      addLog("SWD connected\n");

      await target.halt();
      addLog("Core halted\n");

      if ("deviceId" in targetConfig) {
        const debugId = await target.readMem32(STM32_DBGMCU_IDCODE_ADDRESS);
        const deviceId = getStm32DeviceId(debugId);
        if (deviceId !== targetConfig.deviceId) {
          throw new Error(
            `Expected ${targetConfig.label} device id 0x${targetConfig.deviceId.toString(16)}, got 0x${deviceId.toString(16)}`
          );
        }
      }

      addLog(
        `Target: ${targetConfig.label}, image ${firmwareImage.format.toUpperCase()} ` +
          `${formatBytes(firmwareBytes.length)} at ${formatHex32(firmwareImage.address)}\n`
      );

      await unlockStm32Flash(target);
      addLog("Flash unlocked\n");

      await eraseStm32Pages(
        target,
        firmwareImage.address,
        firmwareBytes.length,
        targetConfig.pageSize
      );

      await programStm32Flash(
        target,
        firmwareImage.address,
        firmwareBytes
      );

      await verifyStm32Flash(
        target,
        firmwareImage.address,
        firmwareBytes
      );

      setProgress(100);
      addLog("Cortex firmware flashed and verified\n");

      await target.softReset();
      addLog("Target reset\n");
    } catch (err: unknown) {
      console.error(err);
      addLog(`Flash Cortex error: ${getErrorMessage(err)}\n`);
    } finally {
      try {
        await target?.disconnect();
      } catch {
        try {
          await transport?.close();
        } catch {
          // Already closed or unavailable.
        }
      }

      setFlashing(false);
    }
  }

  useEffect(() => {
    const logsElement = logsContainerRef.current;
    if (!logsElement) return;

    logsElement.scrollTop = logsElement.scrollHeight;
  }, [logs]);

  const busy = testing || connectingTarget || flashing;
  const selectedTargetConfig = TARGETS[selectedTarget];
  const firmwareSize = firmware ? formatBytes(firmware.size) : "No file";
  const statusLabel = flashing
    ? "Programming"
    : connectingTarget
      ? "Connecting"
      : testing
        ? "Testing"
        : "Ready";
  const statusClass = busy
    ? "border-amber-300 bg-amber-50 text-amber-800"
    : "border-emerald-300 bg-emerald-50 text-emerald-800";
  const buttonBase =
    "rounded-md border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <main className="mx-auto min-h-screen w-[min(98vw,1800px)] px-3 py-4 md:px-5">
      <section className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-950">
              Programador Cortex
            </h1>
            <p className="text-sm text-slate-500">
              ARM Cortex por CMSIS-DAP sobre WebHID.
            </p>
          </div>

          <div className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${statusClass}`}>
            {statusLabel}
          </div>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Target
                </div>
                <select
                  className="mt-2 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm font-semibold text-slate-950"
                  disabled={busy}
                  onChange={(event) => setSelectedTarget(event.target.value as TargetKey)}
                  value={selectedTarget}
                >
                  {Object.entries(TARGETS).map(([key, target]) => (
                    <option key={key} value={key}>
                      {target.label}
                    </option>
                  ))}
                </select>
                <div className="mt-1 text-sm text-slate-500">
                  {selectedTargetConfig.description}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Flash
                </div>
                <div className="mt-2 font-mono text-sm font-semibold text-slate-950">
                  {formatHex32(selectedTargetConfig.flashBase)}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  Page size: {formatBytes(selectedTargetConfig.pageSize)}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Firmware
                </div>
                <div className="mt-2 truncate text-sm font-semibold text-slate-950">
                  {firmwareName || "No firmware selected"}
                </div>
                <div className="mt-1 text-sm text-slate-500">{firmwareSize}</div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Firmware binary / ELF
              </div>
              <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
                <button
                  className="rounded-md border border-slate-900 bg-slate-950 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    void pickFirmwareFile();
                  }}
                  type="button"
                >
                  Select tracked firmware
                </button>

                <label className="min-w-0">
                  <input
                    accept=".bin,.elf"
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-200 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-800 hover:file:bg-slate-300"
                    disabled={busy}
                    onClick={(event) => {
                      event.currentTarget.value = "";
                    }}
                    onChange={(event) => {
                      const selectedFirmware = event.target.files?.[0] ?? null;
                      void setSelectedFirmware(selectedFirmware, null).catch(
                        (err: unknown) => {
                          addLog(
                            `Firmware read error: ${getErrorMessage(err)}\n`
                          );
                        }
                      );
                    }}
                    type="file"
                  />
                </label>
              </div>
              <div className="mt-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                Selected:{" "}
                <span className="font-semibold text-slate-950">
                  {firmwareName || "none"}
                </span>
              </div>
              <div className="mt-2 text-xs text-slate-500">
                Select tracked mantiene el archivo para leerlo fresco en cada flash.
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-800">
                  Progress
                </div>
                <div className="font-mono text-sm text-slate-600">
                  {progress}%
                </div>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-cyan-500 transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          </div>

          <aside className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="mb-3 text-sm font-semibold text-slate-900">
              Actions
            </div>
            <div className="grid gap-2">
              <button
                className={`${buttonBase} border-slate-300 bg-white text-slate-800 hover:bg-slate-100`}
                disabled={busy}
                onClick={testCmsisDap}
                type="button"
              >
                {testing ? "Testing CMSIS-DAP..." : "Test CMSIS-DAP"}
              </button>

              <button
                className={`${buttonBase} border-cyan-300 bg-cyan-50 text-cyan-900 hover:bg-cyan-100`}
                disabled={busy}
                onClick={connectCortexTarget}
                type="button"
              >
                {connectingTarget ? "Connecting target..." : "Connect Cortex"}
              </button>

              <button
                className={`${buttonBase} border-slate-900 bg-slate-950 text-white hover:bg-slate-800`}
                disabled={busy || !firmware}
                onClick={flashCortexFirmware}
                type="button"
              >
                {flashing ? "Flashing Cortex..." : "Flash Cortex"}
              </button>

              <button
                className={`${buttonBase} border-slate-300 bg-white text-slate-700 hover:bg-slate-100`}
                disabled={busy || logs.length === 0}
                onClick={() => setLogs("")}
                type="button"
              >
                Clear log
              </button>
            </div>

            <div className="mt-4 rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-600">
              Raw `.bin` se escribe en <span className="font-mono">0x08000000</span>.
              El flujo borra paginas, programa halfwords y verifica la flash.
            </div>
          </aside>
        </div>

        <div className="border-t border-slate-200 bg-slate-950 p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-200">
              Console
            </div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              CMSIS-DAP / SWD
            </div>
          </div>
          <div
            className="h-[44vh] min-h-[300px] overflow-y-auto rounded-md border border-slate-800 bg-slate-900 p-3 font-mono text-sm whitespace-pre-wrap text-slate-100"
            ref={logsContainerRef}
          >
            {logs || "Ready.\n"}
          </div>
        </div>
      </section>
    </main>
  );
}
