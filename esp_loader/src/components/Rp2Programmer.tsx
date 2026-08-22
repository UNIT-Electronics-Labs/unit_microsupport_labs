import { useEffect, useRef, useState } from "react";
import {
  CmsisDAP,
  CortexM,
  type Transport as DapTransport,
  type DAPOperation,
  type DAPPort,
  type DAPTransferMode,
  WebUSB as DapWebUSB,
} from "dapjs";
import { parseFirmwareImage } from "../cortex/firmware";
import { detectRp2Chip, flashRp2 } from "../cortex/flash/rp2";
import type { Rp2TargetConfig } from "../cortex/types";
import { formatBytes, formatHex32, getErrorMessage, sleep } from "../cortex/utils";

const CPUID_ADDRESS = 0xe000ed00;
const DEFAULT_SWD_CLOCK_HZ = 1_000_000;
const RP2_FLASH_BASE = 0x10000000;
const RP2_DAP_WAIT_RETRY = 0xffff;
const DP_ABORT = 0x00;
const DP_DPIDR = 0x00;
const DP_CTRL_STAT = 0x04;
const DP_SELECT = 0x08;
const DP_CLEAR_STICKY_ERRORS = 0x1c;
const DP_POWER_UP_REQUEST = 0x50000000;
const DP_POWER_UP_ACK = 0xa0000000;
const DHCSR_ADDRESS = 0xe000edf0;
const DHCSR_DBGKEY = 0xa05f0000;
const DHCSR_C_DEBUGEN = 1 << 0;
const DHCSR_C_HALT = 1 << 1;
const DHCSR_S_HALT = 1 << 17;
// RP2350 uses ADIv6 debug-space addressing. Core 0's AHB-AP is at 0x02000
// and its Mem-AP registers (CSW/TAR/DRW) are in the ADIv6 0xD00 register bank.
// Both fields form the value written to DP SELECT.
const RP2350_CORE0_DEBUG_ADDRESS = 0x00002000;
const RP2350_MEM_AP_REGISTER_BANK = 0x00000d00;
const AP_CSW = 0x00;
const AP_TAR = 0x04;
const AP_DRW = 0x0c;
// AHB5 Mem-AP accesses must be privileged and Secure for the Arm Boot ROM
// and its scratch RAM. HNONSEC (bit 30) must remain clear.
const MEM_AP_CSW_16 = 0x03000011;
const MEM_AP_CSW_32 = 0x03000012;
const MAX_BATCH_PROBES = 10;

type TransportKind = "webhid" | "webusb";
type WebHidInputReportEvent = Event & { data: DataView };
type WebHidDevice = EventTarget & {
  opened: boolean;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
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
type UsbDevice = {
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  vendorId?: number;
  productId?: number;
};
type AuthorizedRp2Probe = {
  id: string;
  label: string;
  transport: TransportKind;
  device: WebHidDevice | UsbDevice;
};
type BatchProbeStatus = {
  state: "waiting" | "programming" | "success" | "error";
  progress: number;
  message?: string;
};
const probeInstanceIds = new WeakMap<object, number>();
let nextProbeInstanceId = 1;

class Rp2CmsisDap extends CmsisDAP {
  public async transfer(
    port: DAPPort,
    mode: DAPTransferMode,
    register: number,
    value?: number
  ): Promise<number>;
  public async transfer(operations: DAPOperation[]): Promise<Uint32Array>;
  public async transfer(
    portOrOperations: DAPPort | DAPOperation[],
    mode: DAPTransferMode = 2 as DAPTransferMode,
    register = 0,
    value = 0
  ): Promise<number | Uint32Array> {
    const operations = typeof portOrOperations === "number"
      ? [{ port: portOrOperations, mode, register, value }]
      : portOrOperations;
    const data = new Uint8Array(2 + operations.length * 5);
    const view = new DataView(data.buffer);
    view.setUint8(0, 0);
    view.setUint8(1, operations.length);
    operations.forEach((operation, index) => {
      const offset = 2 + index * 5;
      view.setUint8(offset, operation.port | operation.mode | operation.register);
      view.setUint32(offset + 1, operation.value ?? 0, true);
    });

    let lastCount = 0;
    let lastResponse = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await this.send(5, data);
      if (response.byteLength < 3) {
        throw new Error(`CMSIS-DAP returned a short DAP_Transfer response (${response.byteLength} bytes)`);
      }
      lastCount = response.getUint8(1);
      lastResponse = response.getUint8(2);
      // Some CMSIS-DAP v1 firmware returns count 0 with WAIT instead of using
      // its configured internal retry loop. Retrying the untouched request is safe.
      if (lastCount !== operations.length || lastResponse === 2) {
        await sleep(4);
        continue;
      }
      if (lastResponse !== 1) {
        throw new Error(`CMSIS-DAP DAP_Transfer response 0x${lastResponse.toString(16).padStart(2, "0")}`);
      }
      // DAP_Transfer appends a 32-bit value only for READ requests. In
      // particular, do not turn the padding after write responses into fake
      // zero values: CortexM uses the returned array to inspect DHCSR.
      const readCount = operations.filter((operation) => (operation.mode & 2) !== 0).length;
      if (typeof portOrOperations === "number") {
        return readCount === 0 ? 0 : response.getUint32(3, true);
      }
      return new Uint32Array(response.buffer.slice(3, 3 + readCount * 4));
    }

    throw new Error(
      `CMSIS-DAP DAP_Transfer did not complete (${lastCount}/${operations.length}, response 0x${lastResponse.toString(16).padStart(2, "0")})`
    );
  }
}

/**
 * dapjs implements the ADIv5 AP register layout, while RP2350 uses ADIv6
 * debug-space addressing. Keep CortexM's core-register implementation while
 * routing every memory transaction to core 0's AHB-AP and its 0xD00 bank.
 */
class Rp2350CortexM extends CortexM {
  private readonly cmsisDap: Rp2CmsisDap;

  constructor(cmsisDap: Rp2CmsisDap) {
    super(cmsisDap);
    this.cmsisDap = cmsisDap;
  }

  private selectCore0(bank = 0): DAPOperation[] {
    return [{
      port: 0 as DAPPort,
      mode: 0 as DAPTransferMode,
      register: DP_SELECT,
      value: RP2350_CORE0_DEBUG_ADDRESS | RP2350_MEM_AP_REGISTER_BANK | bank,
    }];
  }

  private writeCore0Ap(register: number, value: number): DAPOperation[] {
    return [{ port: 1 as DAPPort, mode: 0 as DAPTransferMode, register, value }];
  }

  private readCore0Ap(register: number): DAPOperation[] {
    return [{ port: 1 as DAPPort, mode: 2 as DAPTransferMode, register }];
  }

  protected readMem16Command(address: number): DAPOperation[] {
    return this.selectCore0()
      .concat(this.writeCore0Ap(AP_CSW, MEM_AP_CSW_16))
      .concat(this.writeCore0Ap(AP_TAR, address))
      .concat(this.readCore0Ap(AP_DRW));
  }

  protected writeMem16Command(address: number, value: number): DAPOperation[] {
    return this.selectCore0()
      .concat(this.writeCore0Ap(AP_CSW, MEM_AP_CSW_16))
      .concat(this.writeCore0Ap(AP_TAR, address))
      .concat(this.writeCore0Ap(AP_DRW, value));
  }

  protected readMem32Command(address: number): DAPOperation[] {
    return this.selectCore0()
      .concat(this.writeCore0Ap(AP_CSW, MEM_AP_CSW_32))
      .concat(this.writeCore0Ap(AP_TAR, address))
      .concat(this.readCore0Ap(AP_DRW));
  }

  protected writeMem32Command(address: number, value: number): DAPOperation[] {
    return this.selectCore0()
      .concat(this.writeCore0Ap(AP_CSW, MEM_AP_CSW_32))
      .concat(this.writeCore0Ap(AP_TAR, address))
      .concat(this.writeCore0Ap(AP_DRW, value));
  }

  private async prepareBlockTransfer(address: number): Promise<void> {
    await this.cmsisDap.transfer(
      this.selectCore0()
        .concat(this.writeCore0Ap(AP_CSW, MEM_AP_CSW_32))
        .concat(this.writeCore0Ap(AP_TAR, address))
    );
  }

  // dapjs bulk transfers always address APSEL 0. Select the ADIv6 AP ourselves,
  // then use CMSIS-DAP's block command for an entire page at a time.
  public async readBlock(address: number, count: number): Promise<Uint32Array> {
    const values = new Uint32Array(count);
    const chunkWords = Math.max(1, Math.floor(this.cmsisDap.blockSize / 4));
    for (let index = 0; index < count; index += chunkWords) {
      const chunkCount = Math.min(chunkWords, count - index);
      try {
        await this.prepareBlockTransfer(address + index * 4);
        const result = await this.cmsisDap.transferBlock(1 as DAPPort, AP_DRW, chunkCount);
        values.set(result as Uint32Array, index);
      } catch {
        // Some CMSIS-DAP v1 clones omit DAP_TransferBlock. Preserve a working,
        // slower path for them instead of abandoning a programming operation.
        for (let word = 0; word < chunkCount; word += 1) {
          values[index + word] = await this.readMem32(address + (index + word) * 4);
        }
      }
    }
    return values;
  }

  public async writeBlock(address: number, values: Uint32Array): Promise<void> {
    const chunkWords = Math.max(1, Math.floor(this.cmsisDap.blockSize / 4));
    for (let index = 0; index < values.length; index += chunkWords) {
      const chunk = values.slice(index, index + chunkWords);
      try {
        await this.prepareBlockTransfer(address + index * 4);
        await this.cmsisDap.transferBlock(1 as DAPPort, AP_DRW, chunk);
      } catch {
        for (let word = 0; word < chunk.length; word += 1) {
          await this.writeMem32(address + (index + word) * 4, chunk[word]);
        }
      }
    }
  }
}

class WebHidCmsisDapTransport implements DapTransport {
  public readonly packetSize = 64;
  private readonly device: WebHidDevice;

  constructor(device: WebHidDevice) {
    this.device = device;
  }

  async open() {
    if (!this.device.opened) await this.device.open();
  }

  async close() {
    if (this.device.opened) await this.device.close();
  }

  async read(): Promise<DataView> {
    return new Promise((resolve) => {
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

  async write(data: BufferSource) {
    const source =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const packet = new Uint8Array(this.packetSize);
    packet.set(source.slice(0, this.packetSize));
    await this.device.sendReport(0, packet);
  }
}

function formatSwdClock(clockHz: number) {
  return clockHz >= 1_000_000 ? `${clockHz / 1_000_000} MHz` : `${clockHz / 1_000} kHz`;
}

function describeProbe(device: UsbDevice | WebHidDevice, transport: TransportKind, index: number) {
  const name = device.productName ?? device.manufacturerName ?? "CMSIS-DAP";
  const serial = device.serialNumber?.trim();
  const instance = device as object;
  let generatedId = probeInstanceIds.get(instance);
  if (!generatedId) {
    generatedId = nextProbeInstanceId;
    nextProbeInstanceId += 1;
    probeInstanceIds.set(instance, generatedId);
  }
  const identity = serial || `${device.vendorId?.toString(16) ?? "????"}:${device.productId?.toString(16) ?? "????"}:${index + 1}-${generatedId}`;
  return {
    id: `${transport}:${identity}`,
    label: `${name} · ${serial || `canal ${index + 1}`} · ${transport === "webhid" ? "WebHID" : "WebUSB"}`,
    transport,
    device,
  } satisfies AuthorizedRp2Probe;
}

function createTarget(transport: DapTransport, clockHz: number, chip: Rp2TargetConfig["chip"]) {
  const dap = new Rp2CmsisDap(transport, undefined, clockHz);
  return { dap, target: chip === "rp2350" ? new Rp2350CortexM(dap) : new CortexM(dap) };
}

function getRp2ConnectionError(error: unknown): string {
  const message = getErrorMessage(error);
  if (message.includes("Transfer count mismatch")) {
    return (
      "CMSIS-DAP no completó una transferencia SWD. Verifica Vref/3V3, GND, " +
      "SWDIO y SWCLK; prueba 500 kHz o 100 kHz. Si el programador expone v1 y v2, " +
      "selecciona WebUSB v2."
    );
  }
  return message;
}

async function initializeRp2DebugPort(target: CortexM, addLog: (text: string) => void) {
  const dpidr = await target.readDP(DP_DPIDR);
  addLog(`DPIDR: ${formatHex32(dpidr)}\n`);
  await target.writeDP(DP_ABORT, DP_CLEAR_STICKY_ERRORS);
  await target.writeDP(DP_SELECT, 0);
  await target.writeDP(DP_CTRL_STAT, DP_POWER_UP_REQUEST);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await target.readDP(DP_CTRL_STAT);
    if (((status & DP_POWER_UP_ACK) >>> 0) === DP_POWER_UP_ACK) {
      addLog(`CTRL/STAT: ${formatHex32(status)} · Debug Port activo\n`);
      return;
    }
    await sleep(10);
  }

  throw new Error("RP2 Debug Port did not acknowledge power-up within 1 second");
}

async function haltRp2Core(target: CortexM, addLog: (text: string) => void) {
  addLog("Solicitando detención del core...\n");
  await target.writeMem32(DHCSR_ADDRESS, DHCSR_DBGKEY | DHCSR_C_DEBUGEN | DHCSR_C_HALT);
  let status = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await target.readMem32(DHCSR_ADDRESS);
    if (status & DHCSR_S_HALT) {
      addLog(`DHCSR: ${formatHex32(status)} · Core detenido\n`);
      return;
    }
    await sleep(10);
  }
  throw new Error(`RP2 core did not halt within 1 second (DHCSR ${formatHex32(status)})`);
}

async function confirmRp2350CoreAp(target: CortexM, addLog: (text: string) => void) {
  const cpuid = await target.readMem32(CPUID_ADDRESS);
  addLog(`AHB-AP core 0 seleccionado · CPUID ${formatHex32(cpuid)}\n`);
}

function configFor(chip: Rp2TargetConfig["chip"], flashSizeBytes: number): Rp2TargetConfig {
  return {
    label: chip.toUpperCase(),
    description: "Dual Cortex-M33 · QSPI externa",
    family: "rp2",
    algorithm: "rp2-rom",
    flashBase: RP2_FLASH_BASE,
    flashSizeBytes,
    pageSize: 256,
    sectorSize: 4096,
    chip,
  };
}

export default function Rp2Programmer() {
  const [selectedChip] = useState<Rp2TargetConfig["chip"]>("rp2350");
  const [flashSizeBytes, setFlashSizeBytes] = useState(4 * 1024 * 1024);
  const [swdClockHz, setSwdClockHz] = useState(DEFAULT_SWD_CLOCK_HZ);
  const [firmware, setFirmware] = useState<File | null>(null);
  const [firmwareBytes, setFirmwareBytes] = useState<Uint8Array | null>(null);
  const [transportKind, setTransportKind] = useState<TransportKind>("webhid");
  const [probeName, setProbeName] = useState("");
  const [authorizedProbes, setAuthorizedProbes] = useState<AuthorizedRp2Probe[]>([]);
  const [batchProbeIds, setBatchProbeIds] = useState<string[]>([]);
  const [batchStatuses, setBatchStatuses] = useState<Record<string, BatchProbeStatus>>({});
  const [batchConcurrency, setBatchConcurrency] = useState(4);
  const [scanningProbes, setScanningProbes] = useState(false);
  const [logs, setLogs] = useState("");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showConsole, setShowConsole] = useState(true);
  const [configurationOpen, setConfigurationOpen] = useState(true);
  const logsRef = useRef<HTMLDivElement | null>(null);

  const targetConfig = configFor(selectedChip, flashSizeBytes);
  const addLog = (text: string) => setLogs((previous) => previous + text);

  useEffect(() => {
    logsRef.current?.scrollTo({ top: logsRef.current.scrollHeight });
  }, [logs]);

  useEffect(() => {
    // getDevices() never opens the browser selector. It restores probes that
    // the user already authorized for this exact origin.
    void scanAuthorizedProbes().catch(() => undefined);
    // It intentionally runs only when this screen is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scanAuthorizedProbes() {
    const hid = (navigator as Navigator & { hid?: WebHidApi }).hid;
    const usb = (navigator as Navigator & {
      usb?: { getDevices?: () => Promise<UsbDevice[]> };
    }).usb;
    if (!hid?.getDevices && !usb?.getDevices) {
      throw new Error("WebHID or WebUSB is not available. Use Chrome or Edge on desktop.");
    }

    setScanningProbes(true);
    try {
      const [hidDevices, usbDevices] = await Promise.all([
        hid?.getDevices?.() ?? Promise.resolve([]),
        usb?.getDevices?.() ?? Promise.resolve([]),
      ]);
      // Prefer WebUSB for probes that expose both transports, because it has
      // better packet handling when several probes share a USB hub.
      const webUsbProbes = usbDevices.map((device, index) => describeProbe(device as UsbDevice, "webusb", index));
      const webHidProbes = hidDevices
        .filter((device) => !webUsbProbes.some((probe) => {
          const usbDevice = probe.device as UsbDevice;
          return device.serialNumber !== undefined && device.serialNumber === usbDevice.serialNumber;
        }))
        .map((device, index) => describeProbe(device, "webhid", index));
      const probes = [...webUsbProbes, ...webHidProbes].slice(0, MAX_BATCH_PROBES);
      setAuthorizedProbes(probes);
      setBatchProbeIds((current) => current.filter((id) => probes.some((probe) => probe.id === id)));
      setBatchStatuses((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => probes.some((probe) => probe.id === id))
      ));
      addLog(`Panel RP2: ${probes.length} CMSIS-DAP autorizado(s).\n`);
      return probes;
    } finally {
      setScanningProbes(false);
    }
  }

  async function authorizeBatchProbe() {
    if (!window.isSecureContext) throw new Error("CMSIS-DAP requires HTTPS or localhost");
    if (transportKind === "webhid") {
      const hid = (navigator as Navigator & { hid?: WebHidApi }).hid;
      if (!hid) throw new Error("WebHID is not available. Use Chrome or Edge on desktop.");
      addLog("Autoriza un CMSIS-DAP adicional en el selector WebHID. Repite para cada probe.\n");
      await hid.requestDevice({ filters: [] });
    } else {
      const usb = (navigator as Navigator & {
        usb?: { requestDevice(options: { filters: unknown[] }): Promise<UsbDevice> };
      }).usb;
      if (!usb) throw new Error("WebUSB is not available. Use Chrome or Edge on desktop.");
      addLog("Autoriza un CMSIS-DAP v2 adicional en el selector WebUSB.\n");
      await usb.requestDevice({ filters: [] });
    }
    await scanAuthorizedProbes();
  }

  function transportForProbe(probe: AuthorizedRp2Probe): DapTransport {
    return probe.transport === "webhid"
      ? new WebHidCmsisDapTransport(probe.device as WebHidDevice)
      : new DapWebUSB(probe.device as ConstructorParameters<typeof DapWebUSB>[0]);
  }

  async function requestTransport(): Promise<DapTransport | null> {
    if (!window.isSecureContext) {
      throw new Error("CMSIS-DAP requires HTTPS or localhost");
    }

    if (transportKind === "webhid") {
      const hid = (navigator as Navigator & { hid?: WebHidApi }).hid;
      if (!hid) throw new Error("WebHID is not available. Use Chrome or Edge on desktop.");
      addLog("Opening WebHID selector. Select the CMSIS-DAP probe.\n");
      const [device] = await hid.requestDevice({ filters: [] });
      if (!device) return null;
      setProbeName(device.productName ?? device.manufacturerName ?? "CMSIS-DAP via WebHID");
      return new WebHidCmsisDapTransport(device);
    }

    const usb = (navigator as Navigator & {
      usb?: { requestDevice(options: { filters: unknown[] }): Promise<UsbDevice> };
    }).usb;
    if (!usb) throw new Error("WebUSB is not available. Use Chrome or Edge on desktop.");
    addLog("Opening WebUSB selector. Select the CMSIS-DAP v2 probe.\n");
    const device = await usb.requestDevice({ filters: [] });
    setProbeName(device.productName ?? device.manufacturerName ?? "CMSIS-DAP via WebUSB");
    return new DapWebUSB(device as ConstructorParameters<typeof DapWebUSB>[0]);
  }

  async function withTarget(action: (target: CortexM) => Promise<void>) {
    if (busy) return;
    setBusy(true);
    let transport: DapTransport | null = null;
    let target: CortexM | null = null;
    try {
      const savedProbe = authorizedProbes.find((probe) => batchProbeIds.includes(probe.id)) ?? authorizedProbes[0];
      if (savedProbe) {
        setProbeName(savedProbe.label);
        addLog(`Reutilizando CMSIS-DAP autorizado: ${savedProbe.label}\n`);
        transport = transportForProbe(savedProbe);
      } else {
        transport = await requestTransport();
      }
      if (!transport) return;
      const session = createTarget(transport, swdClockHz, selectedChip);
      target = session.target;
      addLog("CMSIS-DAP conectado; seleccionando SWD...\n");
      await session.dap.connect();
      // RP2 can hold SWD transfers in WAIT while the debug fabric wakes up.
      // Configure this before the first DPIDR transaction made by CortexM.connect().
      await session.dap.configureTransfer(0, RP2_DAP_WAIT_RETRY, 0);
      // Several low-cost CMSIS-DAP v1 probes handle a single transfer reliably
      // but return a short count for combined DAP_Transfer packets.
      session.dap.operationCount = 1;
      addLog("SWD seleccionado; inicializando el debug port RP2...\n");
      await initializeRp2DebugPort(target, addLog);
      if (selectedChip === "rp2350") await confirmRp2350CoreAp(target, addLog);
      await haltRp2Core(target, addLog);
      await action(target);
    } catch (error: unknown) {
      addLog(`ERROR: ${getRp2ConnectionError(error)}\n`);
    } finally {
      try {
        await target?.disconnect();
      } catch {
        await transport?.close().catch(() => undefined);
      }
      setBusy(false);
    }
  }

  function checkTarget(target: CortexM) {
    return detectRp2Chip(target).then((chip) => {
      if (chip !== selectedChip) {
        throw new Error(`Selected ${selectedChip.toUpperCase()}, connected ${chip.toUpperCase()}`);
      }
      return chip;
    });
  }

  async function testConnection() {
    setProgress(0);
    addLog(`\nConnecting to ${targetConfig.label} over SWD at ${formatSwdClock(swdClockHz)}...\n`);
    await withTarget(async (target) => {
      const cpuid = await target.readMem32(CPUID_ADDRESS);
      const chip = await checkTarget(target);
      addLog(`SWD OK · CPUID ${formatHex32(cpuid)} · Boot ROM ${chip.toUpperCase()}\n`);
      addLog(`Configured QSPI capacity: ${formatBytes(flashSizeBytes)}\n`);
      setProgress(100);
    });
  }

  async function flashFirmware() {
    if (!firmware || !firmwareBytes) return;
    setProgress(0);
    addLog(`\nFlashing ${firmware.name} to ${targetConfig.label}...\n`);
    await withTarget(async (target) => {
      await checkTarget(target);
      const image = parseFirmwareImage(firmwareBytes, firmware.name, targetConfig);
      const imageOffset = image.address - targetConfig.flashBase;
      if (imageOffset < 0 || imageOffset + image.data.length > targetConfig.flashSizeBytes) {
        throw new Error(`Firmware exceeds configured ${formatBytes(targetConfig.flashSizeBytes)} QSPI capacity`);
      }
      addLog(`${image.format.toUpperCase()} image: ${formatBytes(image.data.length)} at ${formatHex32(image.address)}\n`);
      await flashRp2(target, image, targetConfig, { addLog, setProgress });
      setProgress(100);
      addLog("Firmware programmed and verified. Resetting target...\n");
      await target.softReset();
      await sleep(50);
      addLog("Done.\n");
    });
  }

  async function flashFirmwareBatch() {
    if (!firmware || !firmwareBytes || busy) return;
    const selectedProbes = authorizedProbes.filter((probe) => batchProbeIds.includes(probe.id));
    if (selectedProbes.length === 0) {
      addLog("ERROR: selecciona al menos un CMSIS-DAP para el lote.\n");
      return;
    }

    let image: ReturnType<typeof parseFirmwareImage>;
    try {
      image = parseFirmwareImage(firmwareBytes, firmware.name, targetConfig);
      const imageOffset = image.address - targetConfig.flashBase;
      if (imageOffset < 0 || imageOffset + image.data.length > targetConfig.flashSizeBytes) {
        throw new Error(`Firmware exceeds configured ${formatBytes(targetConfig.flashSizeBytes)} QSPI capacity`);
      }
    } catch (error: unknown) {
      addLog(`ERROR: ${getErrorMessage(error)}\n`);
      return;
    }

    const statuses = Object.fromEntries(selectedProbes.map((probe) => [
      probe.id,
      { state: "waiting", progress: 0 } satisfies BatchProbeStatus,
    ]));
    const progressByProbe = new Map(selectedProbes.map((probe) => [probe.id, 0]));
    const updateStatus = (probeId: string, update: Partial<BatchProbeStatus>) => {
      setBatchStatuses((current) => ({
        ...current,
        [probeId]: { ...(current[probeId] ?? { state: "waiting", progress: 0 }), ...update },
      }));
    };
    const updateProgress = (probeId: string, nextProgress: number) => {
      progressByProbe.set(probeId, nextProgress);
      updateStatus(probeId, { progress: nextProgress });
      const total = Array.from(progressByProbe.values()).reduce((sum, value) => sum + value, 0);
      setProgress(Number((total / selectedProbes.length).toFixed(1)));
    };

    setBusy(true);
    setProgress(0);
    setBatchStatuses(statuses);
    addLog(`\n=== Lote RP2: ${selectedProbes.length} canal(es), ${firmware.name}, ${formatSwdClock(swdClockHz)} ===\n`);

    let nextProbe = 0;
    const failures: string[] = [];
    const programOne = async (probe: AuthorizedRp2Probe) => {
      const channelLog = (text: string) => addLog(`[${probe.label}] ${text}`);
      let transport: DapTransport | null = null;
      let target: CortexM | null = null;
      updateStatus(probe.id, { state: "programming", message: "Conectando", progress: 0 });
      try {
        transport = transportForProbe(probe);
        const session = createTarget(transport, swdClockHz, selectedChip);
        target = session.target;
        await session.dap.connect();
        await session.dap.configureTransfer(0, RP2_DAP_WAIT_RETRY, 0);
        session.dap.operationCount = 1;
        await initializeRp2DebugPort(target, channelLog);
        if (selectedChip === "rp2350") await confirmRp2350CoreAp(target, channelLog);
        await haltRp2Core(target, channelLog);
        const detectedChip = await detectRp2Chip(target);
        if (detectedChip !== selectedChip) {
          throw new Error(`Seleccionado ${selectedChip.toUpperCase()}, conectado ${detectedChip.toUpperCase()}`);
        }
        channelLog(`${image.format.toUpperCase()} ${formatBytes(image.data.length)} · programando\n`);
        await flashRp2(target, image, targetConfig, {
          addLog: channelLog,
          setProgress: (value) => updateProgress(probe.id, value),
        });
        await target.softReset();
        updateProgress(probe.id, 100);
        updateStatus(probe.id, { state: "success", message: "Programado y verificado" });
        channelLog("OK\n");
      } catch (error: unknown) {
        const message = getRp2ConnectionError(error);
        failures.push(`${probe.label}: ${message}`);
        updateStatus(probe.id, { state: "error", message });
        channelLog(`ERROR: ${message}\n`);
      } finally {
        try {
          await target?.disconnect();
        } catch {
          await transport?.close().catch(() => undefined);
        }
      }
    };

    const worker = async () => {
      while (nextProbe < selectedProbes.length) {
        const probe = selectedProbes[nextProbe];
        nextProbe += 1;
        await programOne(probe);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(batchConcurrency, selectedProbes.length) }, worker));
      const successful = selectedProbes.length - failures.length;
      addLog(`=== Resultado lote RP2: ${successful} correctos, ${failures.length} fallidos ===\n`);
    } finally {
      setBusy(false);
    }
  }

  const buttonBase =
    "rounded border px-2 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
  const selectedBatchProbeCount = authorizedProbes.filter((probe) => batchProbeIds.includes(probe.id)).length;
  const batchStatusValues = Object.values(batchStatuses);
  const successfulBatchCount = batchStatusValues.filter((status) => status.state === "success").length;
  const programmingBatchCount = batchStatusValues.filter((status) => status.state === "programming").length;
  const failedBatchCount = batchStatusValues.filter((status) => status.state === "error").length;

  return (
    <main className="min-h-[calc(100vh-65px)] w-full">
      <section className="min-h-[calc(100vh-65px)] overflow-hidden border-y border-slate-800 bg-slate-100">
        <div className={`grid min-w-0 gap-0 ${configurationOpen ? "xl:grid-cols-[330px_minmax(0,1fr)]" : "grid-cols-1"}`}>
          {configurationOpen ? (
            <div className="grid min-w-0 content-start gap-2 border-r border-slate-300 bg-slate-100">
              <div className="border-b border-slate-300 bg-white p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-bold text-slate-950">Configuración</div>
                  <div className="font-mono text-[10px] font-bold text-cyan-700">{formatSwdClock(swdClockHz)}</div>
                </div>
                <div className="mb-2 block min-w-0">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">Microcontrolador objetivo</span>
                  <div className="w-full rounded border border-cyan-300 bg-cyan-50 px-2 py-1.5 text-xs font-semibold text-cyan-950">RP2350 · Cortex-M33</div>
                  <span className="mt-1 block text-[10px] text-slate-500">{targetConfig.description}</span>
                  <span className="mt-1 block text-[10px] font-medium text-amber-800">Soporte para RP2040 pendiente: no intentes programarlo con esta pestaña.</span>
                </div>
                <label className="mb-2 block min-w-0">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">Capacidad QSPI externa</span>
                  <select className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-950" disabled={busy} onChange={(event) => setFlashSizeBytes(Number(event.target.value))} value={flashSizeBytes}>
                    {[2, 4, 8, 16].map((megabytes) => <option key={megabytes} value={megabytes * 1024 * 1024}>{megabytes} MB</option>)}
                  </select>
                </label>
                <label className="mb-2 block min-w-0">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">Transporte CMSIS-DAP</span>
                  <select className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-950" disabled={busy} onChange={(event) => setTransportKind(event.target.value as TransportKind)} value={transportKind}>
                    <option value="webhid">WebHID · CMSIS-DAP v1 / QinHeng</option>
                    <option value="webusb">WebUSB · CMSIS-DAP v2</option>
                  </select>
                </label>
                <label className="block min-w-0">
                  <span className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-slate-500">Velocidad SWD <span className="font-mono text-cyan-700">{formatSwdClock(swdClockHz)}</span></span>
                  <select className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-950" disabled={busy} onChange={(event) => setSwdClockHz(Number(event.target.value))} value={swdClockHz}>
                    <option value={100_000}>100 kHz · máxima estabilidad</option>
                    <option value={500_000}>500 kHz</option>
                    <option value={1_000_000}>1 MHz · recomendado</option>
                    <option value={2_000_000}>2 MHz</option>
                    <option value={4_000_000}>4 MHz</option>
                  </select>
                </label>
              </div>

              <div className="mx-2 rounded border border-slate-300 bg-white p-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Firmware RP2</div>
                <label className={`block w-full rounded border border-slate-900 bg-slate-950 px-2 py-1.5 text-center text-xs font-semibold text-white transition ${busy ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-slate-800"}`}>
                  Seleccionar firmware
                  <input accept=".bin,.elf,.uf2,application/octet-stream" className="sr-only" disabled={busy} onChange={async (event) => {
                    const input = event.currentTarget;
                    const file = input.files?.[0] ?? null;
                    setFirmware(file);
                    setFirmwareBytes(file ? new Uint8Array(await file.arrayBuffer()) : null);
                    if (file) addLog(`Selected firmware: ${file.name} (${formatBytes(file.size)})\n`);
                    input.value = "";
                  }} type="file" />
                </label>
                <div className="mt-1 min-w-0 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs">
                  <div className="truncate font-semibold text-slate-950">{firmware?.name || "Ningún archivo seleccionado"}</div>
                  <div className="text-[10px] text-slate-500">{firmware ? formatBytes(firmware.size) : ".bin, .elf o .uf2"}</div>
                </div>
              </div>

              <div className="mx-2 rounded border border-slate-300 bg-white p-2">
                <div className="mb-1 flex items-center justify-between gap-3"><span className="text-xs font-semibold text-slate-800">Progreso</span><span className="font-mono text-sm text-slate-600">{progress.toFixed(0)}%</span></div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-cyan-500 transition-all duration-300" style={{ width: `${progress}%` }} /></div>
              </div>
              <button className="mx-2 mb-2 rounded border border-cyan-600 bg-cyan-50 px-2 py-1.5 text-xs font-bold text-cyan-900 hover:bg-cyan-100" disabled={busy} onClick={() => setConfigurationOpen(false)} type="button">Listo · ocultar configuración</button>
            </div>
          ) : null}

          <aside className="min-w-0 bg-slate-100 p-2 lg:p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <button className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-slate-700 hover:border-cyan-500 hover:text-cyan-800 disabled:opacity-50" disabled={busy} onClick={() => setConfigurationOpen((current) => !current)} type="button">{configurationOpen ? "Ocultar configuración" : "Configurar"}</button>
                <div className="min-w-0 truncate text-[11px] text-slate-600"><strong className="text-slate-900">{targetConfig.label}</strong>{" · "}{formatSwdClock(swdClockHz)}{" · "}{firmware?.name || "sin firmware"}{" · "}<span className="font-mono font-bold">{progress.toFixed(0)}%</span></div>
              </div>
              <div className="rounded-full border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] font-bold text-slate-700">QSPI {formatBytes(flashSizeBytes)}</div>
            </div>

            <div className="grid gap-2">
              <div className="rounded border border-cyan-200 bg-cyan-50 p-3 text-xs text-cyan-950">
                <div className="font-semibold">RP2 por CMSIS-DAP / SWD</div>
                <div className="mt-1 text-cyan-800">Conecta Vref/3V3, GND, SWDIO y SWCLK. La Boot ROM del RP2 programa el flash QSPI y después se verifica la imagen.</div>
                <div className="mt-2 rounded border border-cyan-100 bg-white/70 px-2 py-1.5 font-mono text-[11px] text-cyan-950">{probeName ? `Programador: ${probeName}` : "Selecciona el programador al pulsar Probar o Programar."}</div>
              </div>

              <div className="grid gap-2 rounded border border-slate-200 bg-white p-3 sm:grid-cols-2">
                <div><div className="text-xs font-semibold text-slate-900">Formatos soportados</div><div className="mt-1 text-[11px] text-slate-500">.bin, .elf ARM 32-bit y .uf2</div></div>
                <div><div className="text-xs font-semibold text-slate-900">Capacidad seleccionada</div><div className="mt-1 text-[11px] text-slate-500">Debe coincidir con el QSPI de la placa.</div></div>
              </div>

              <div className="rounded border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><div className="text-xs font-semibold text-slate-900">Panel de programación por lote</div><div className="mt-0.5 text-[11px] text-slate-500">Hasta 10 CMSIS-DAP, uno por tarjeta. Autoriza cada probe una vez.</div></div>
                  <div className="flex gap-1.5">
                    <button className={`${buttonBase} border-slate-300 bg-white text-slate-700 hover:border-cyan-500`} disabled={busy || scanningProbes} onClick={() => void scanAuthorizedProbes().catch((error) => addLog(`ERROR: ${getErrorMessage(error)}\n`))} type="button">{scanningProbes ? "Buscando..." : "Buscar probes"}</button>
                    <button className={`${buttonBase} border-cyan-600 bg-cyan-50 text-cyan-900 hover:bg-cyan-100`} disabled={busy} onClick={() => void authorizeBatchProbe().catch((error) => addLog(`ERROR: ${getErrorMessage(error)}\n`))} type="button">Añadir probe</button>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                  <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-center"><div className="font-mono text-base font-bold text-emerald-700">{successfulBatchCount}</div><div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-800">OK</div></div>
                  <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-center"><div className="font-mono text-base font-bold text-amber-700">{programmingBatchCount}</div><div className="text-[10px] font-semibold uppercase tracking-wide text-amber-800">Procesando</div></div>
                  <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-center"><div className="font-mono text-base font-bold text-red-700">{failedBatchCount}</div><div className="text-[10px] font-semibold uppercase tracking-wide text-red-800">Fallas</div></div>
                </div>
                <div className="mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
                  <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-slate-700"><span>Carga total del lote · {selectedBatchProbeCount} canal(es) activo(s)</span><span className="font-mono">{progress.toFixed(0)}%</span></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-cyan-500 transition-all duration-300" style={{ width: `${progress}%` }} /></div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex gap-1.5"><button className="text-[11px] font-semibold text-cyan-800 hover:underline disabled:opacity-50" disabled={busy || authorizedProbes.length === 0} onClick={() => setBatchProbeIds(authorizedProbes.map((probe) => probe.id))} type="button">Activar todos</button><button className="text-[11px] font-semibold text-slate-500 hover:underline disabled:opacity-50" disabled={busy || batchProbeIds.length === 0} onClick={() => setBatchProbeIds([])} type="button">Limpiar</button></div>
                  <label className="flex items-center gap-1 text-[11px] font-semibold text-slate-600">Paralelo <select className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px]" disabled={busy} onChange={(event) => setBatchConcurrency(Number(event.target.value))} value={batchConcurrency}>{[1, 2, 4, 5, 10].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                </div>
                <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
                  {authorizedProbes.length === 0 ? <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-2 py-3 text-center text-[11px] text-slate-500">Pulsa “Añadir probe” para cada CMSIS-DAP conectado.</div> : authorizedProbes.map((probe) => {
                    const status = batchStatuses[probe.id];
                    const color = status?.state === "success" ? "border-emerald-200 bg-emerald-50" : status?.state === "error" ? "border-red-200 bg-red-50" : status?.state === "programming" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50";
                    return <label className={`min-w-0 rounded border p-2 text-xs ${color}`} key={probe.id}><span className="flex gap-2"><input checked={batchProbeIds.includes(probe.id)} disabled={busy} onChange={(event) => setBatchProbeIds((current) => event.target.checked ? [...current, probe.id] : current.filter((id) => id !== probe.id))} type="checkbox" /><span className="min-w-0"><span className="block truncate font-semibold text-slate-900">{probe.label}</span><span className={`mt-1 block break-words text-[10px] ${status?.state === "error" ? "font-medium text-red-800" : "text-slate-600"}`}>{status?.state === "programming" ? `${status.message ?? "Programando"} · ${status.progress.toFixed(0)}%` : status?.state === "error" ? `Falló: ${status.message ?? "Error desconocido"}` : status?.message ?? "En espera"}</span></span></span>{status ? <span className="mt-1.5 block h-1 overflow-hidden rounded bg-white"><span className={`block h-full ${status.state === "error" ? "bg-red-500" : status.state === "success" ? "bg-emerald-500" : "bg-cyan-500"}`} style={{ width: `${status.progress}%` }} /></span> : null}</label>;
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white p-2">
                <button className={`${buttonBase} border-slate-300 bg-white text-slate-600 hover:border-cyan-400 hover:text-cyan-800`} disabled={busy} onClick={() => void testConnection()} type="button">{busy ? "Procesando..." : "Probar uno"}</button>
                <div className="flex gap-1.5"><button className={`${buttonBase} border-slate-300 bg-white text-slate-700 hover:border-cyan-500`} disabled={busy || !firmware || selectedBatchProbeCount === 0} onClick={() => void flashFirmwareBatch()} type="button">{busy ? "Procesando..." : `Programar lote · ${selectedBatchProbeCount}`}</button><button className={`${buttonBase} border-cyan-500 bg-cyan-400 px-4 text-sm font-bold text-slate-950 shadow-sm hover:bg-cyan-300`} disabled={busy || !firmware} onClick={() => void flashFirmware()} type="button">{busy ? "Programando..." : "Programar uno"}</button></div>
              </div>
            </div>
          </aside>
        </div>

        <div className="border-t border-slate-200 bg-slate-950 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-200">Consola CMSIS-DAP / SWD · RP2</div>
            <div className="flex items-center gap-2">
              <button className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-100 transition hover:bg-slate-800 disabled:opacity-50" disabled={busy || logs.length === 0} onClick={() => setLogs("")} type="button">Limpiar</button>
              <button className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-100 transition hover:bg-slate-800" onClick={() => setShowConsole((current) => !current)} type="button">{showConsole ? "Ocultar consola" : "Mostrar consola"}</button>
            </div>
          </div>
          {showConsole ? <div className="mt-2 h-[36vh] min-h-[220px] overflow-y-auto rounded border border-slate-800 bg-slate-900 p-2 font-mono text-xs whitespace-pre-wrap text-slate-100" ref={logsRef}>{logs || "Esperando una operación SWD..."}</div> : null}
        </div>
      </section>
    </main>
  );
}
