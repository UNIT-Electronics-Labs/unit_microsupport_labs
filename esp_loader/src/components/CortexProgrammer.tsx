import { useEffect, useRef, useState } from "react";
import {
  CmsisDAP,
  CortexM,
  type Transport as DapTransport,
  WebUSB as DapWebUSB,
} from "dapjs";
import { flashPy32F0, PY32_DAP_WAIT_RETRY, PY32_DBGMCU_IDCODE_ADDRESS } from "../cortex/flash/py32f0";
import { parseFirmwareImage } from "../cortex/firmware";
import { TARGETS, type TargetKey } from "../cortex/targets";
import {
  formatBytes,
  formatHex32,
  getDebugDeviceId,
  getDebugRevisionId,
  getErrorMessage,
} from "../cortex/utils";

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

function formatUsbId(value?: number): string {
  return value === undefined ? "????" : value.toString(16).padStart(4, "0");
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

function createCortexTarget(transport: DapTransport): {
  dap: CmsisDAP;
  target: CortexM;
} {
  const dap = new CmsisDAP(transport);
  return {
    dap,
    target: new CortexM(dap),
  };
}

export default function CortexProgrammer() {
  const [selectedTarget, setSelectedTarget] = useState<TargetKey>("py32f003x6");
  const [logs, setLogs] = useState("");
  const [connectingTarget, setConnectingTarget] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [firmware, setFirmware] = useState<File | null>(null);
  const [firmwareBytes, setFirmwareBytes] = useState<Uint8Array | null>(null);
  const [firmwareName, setFirmwareName] = useState("");
  const [progress, setProgress] = useState(0);
  const [showConsole, setShowConsole] = useState(false);
  const logsContainerRef = useRef<HTMLDivElement | null>(null);
  const activeTransportRef = useRef<DapTransport | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  function addLog(text: string) {
    setLogs((prev) => prev + text);
  }

  const targetEntries = Object.entries(TARGETS) as Array<
    [TargetKey, (typeof TARGETS)[TargetKey]]
  >;

  async function setSelectedFirmware(file: File | null) {
    setFirmware(file);
    setFirmwareName(file?.name ?? "");
    setFirmwareBytes(null);

    if (file) {
      setFirmwareBytes(new Uint8Array(await file.arrayBuffer()));
      addLog(
        `Firmware selected: ${file.name} (${formatBytes(file.size)})\n`
      );
    }
  }

  async function askFirmwareForFlash(): Promise<{
    bytes: Uint8Array;
    name: string;
    size: number;
  } | null> {
    if (!firmware || !firmwareBytes) {
      throw new Error("Select a firmware .bin file");
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

  async function disconnectCortexTarget() {
    if (!activeTransportRef.current) return;
    
    addLog("\nDisconnecting CMSIS-DAP probe...\n");
    try {
      await activeTransportRef.current.close();
      addLog("CMSIS-DAP disconnected\n");
    } catch (err: unknown) {
      addLog(`Disconnect error: ${getErrorMessage(err)}\n`);
    } finally {
      activeTransportRef.current = null;
      setIsConnected(false);
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

      const session = createCortexTarget(transport);
      target = session.target;
      await target.connect();
      const targetConfig = TARGETS[selectedTarget];
      await session.dap.configureTransfer(0, PY32_DAP_WAIT_RETRY, 0);
      addLog("SWD connected\n");

      await target.halt();
      addLog("Core halted\n");

      const cpuid = await target.readMem32(CORTEX_CPUID_ADDRESS);
      addLog(`CPUID: ${formatHex32(cpuid)}\n`);

      try {
        const py32DebugId = await target.readMem32(PY32_DBGMCU_IDCODE_ADDRESS);
        addLog(
          `PY32 DBGMCU_IDCODE: ${formatHex32(py32DebugId)} ` +
            `(dev ${formatHex32(getDebugDeviceId(py32DebugId))}, ` +
            `rev 0x${getDebugRevisionId(py32DebugId).toString(16).padStart(4, "0")})\n`
        );
      } catch {
        addLog("PY32 DBGMCU_IDCODE: unavailable\n");
      }

      addLog(
        `Configured target flash: ${formatBytes(targetConfig.flashSizeBytes)} ` +
          `at ${formatHex32(targetConfig.flashBase)}\n`
      );

      await target.resume(false);
      addLog("Core resumed\n");
      addLog("Cortex target probe finished\n");
      
      // Guardar el transport para reutilizarlo
      activeTransportRef.current = transport;
      setIsConnected(true);
    } catch (err: unknown) {
      console.error(err);
      addLog(`Cortex target error: ${getErrorMessage(err)}\n`);
      // Cerrar transport si hubo error
      try {
        await target?.disconnect();
      } catch {
        try {
          await transport?.close();
        } catch {
          // Already closed or unavailable.
        }
      }
      activeTransportRef.current = null;
      setIsConnected(false);
    } finally {
      setConnectingTarget(false);
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
      addLog("Using WebHID. Select the CMSIS-DAP probe.\n");
      const devices = await hid.requestDevice({ filters: [] });
      const device = devices[0] ?? null;

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

      // Usar el transport guardado si ya está conectado, si no, pedir seleccionar
      if (activeTransportRef.current) {
        transport = activeTransportRef.current;
        addLog("Using already connected CMSIS-DAP probe\n");
      } else {
        transport = await requestCmsisDapTransport();
        if (!transport) return;
        activeTransportRef.current = transport;
        setIsConnected(true);
      }

      const session = createCortexTarget(transport);
      target = session.target;
      await target.connect();
      await session.dap.configureTransfer(0, PY32_DAP_WAIT_RETRY, 0);
      addLog("DAP wait retry extended for PY32 flash\n");
      addLog("SWD connected\n");

      await target.halt();
      addLog("Core halted\n");

      addLog(
        `Target: ${targetConfig.label}, image ${firmwareImage.format.toUpperCase()} ` +
          `${formatBytes(firmwareBytes.length)} at ${formatHex32(firmwareImage.address)}\n`
      );

      const callbacks = { addLog, setProgress };

      await flashPy32F0(target, firmwareImage, targetConfig, callbacks);

      setProgress(100);
      addLog("Cortex firmware flashed and verified\n");

      await target.softReset();
      addLog("Target reset\n");
    } catch (err: unknown) {
      console.error(err);
      addLog(`Flash Cortex error: ${getErrorMessage(err)}\n`);
      // Si hay error, cerrar todo y limpiar la conexión guardada
      try {
        await target?.disconnect();
      } catch {
        // Ignorar errores al desconectar
      }
      try {
        await transport?.close();
      } catch {
        // Ignorar errores al cerrar
      }
      activeTransportRef.current = null;
      setIsConnected(false);
    } finally {
      // Solo desconectar el target pero mantener el transport abierto
      try {
        await target?.disconnect();
      } catch {
        // Ignorar errores al desconectar
      }
      setFlashing(false);
    }
  }

  useEffect(() => {
    if (!showConsole) return;

    const logsElement = logsContainerRef.current;
    if (!logsElement) return;

    logsElement.scrollTop = logsElement.scrollHeight;
  }, [logs, showConsole]);

  const busy = connectingTarget || flashing;
  const firmwareSize = firmware ? formatBytes(firmware.size) : "No file";
  const statusLabel = flashing
    ? "Programming"
    : connectingTarget
      ? "Connecting"
      : isConnected
        ? "Connected"
        : "Ready";
  const statusClass = busy
    ? "border-amber-300 bg-amber-50 text-amber-800"
    : isConnected
      ? "border-cyan-300 bg-cyan-50 text-cyan-800"
      : "border-emerald-300 bg-emerald-50 text-emerald-800";
  const buttonBase =
    "rounded-md border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <main className="mx-auto min-h-screen w-[min(98vw,1800px)] px-3 py-4 md:px-5">
      <section className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-950">
              LockNode Programmer
            </h1>
            <p className="text-sm text-slate-500">
              PY32F003 via CMSIS-DAP
            </p>
          </div>

          <div className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${statusClass}`}>
            {statusLabel}
          </div>
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid gap-4">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="mb-3 text-sm font-semibold text-slate-900">
                Target Chip
              </div>
              <select
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950"
                disabled={busy}
                onChange={(event) => setSelectedTarget(event.target.value as TargetKey)}
                value={selectedTarget}
              >
                {targetEntries.map(([key, target]) => (
                  <option key={key} value={key}>
                    {target.label} — {target.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="mb-3 text-sm font-semibold text-slate-900">
                Firmware File
              </div>
              <input
                accept=".bin,.elf"
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
                disabled={busy}
                onClick={(event) => {
                  event.currentTarget.value = "";
                }}
                onChange={(event) => {
                  const selectedFirmware = event.target.files?.[0] ?? null;
                  void setSelectedFirmware(selectedFirmware).catch(
                    (err: unknown) => {
                      addLog(
                        `Firmware read error: ${getErrorMessage(err)}\n`
                      );
                    }
                  );
                }}
                type="file"
              />
              {firmwareName && (
                <div className="mt-2 text-sm text-slate-600">
                  <span className="font-semibold">{firmwareName}</span> • {firmwareSize}
                </div>
              )}
            </div>
          </div>

          <aside className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 rounded-md border border-slate-200 bg-white p-3">
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

            <div className="grid gap-2">
              <button
                className={`${buttonBase} border-cyan-300 bg-cyan-50 text-cyan-900 hover:bg-cyan-100`}
                disabled={busy || isConnected}
                onClick={connectCortexTarget}
                type="button"
              >
                {connectingTarget ? "Connecting..." : isConnected ? "✓ Connected" : "Connect"}
              </button>

              {isConnected && (
                <button
                  className={`${buttonBase} border-red-300 bg-red-50 text-red-900 hover:bg-red-100`}
                  disabled={busy}
                  onClick={disconnectCortexTarget}
                  type="button"
                >
                  Disconnect
                </button>
              )}

              <button
                className={`${buttonBase} border-slate-900 bg-slate-950 text-white hover:bg-slate-800`}
                disabled={busy || !firmware}
                onClick={flashCortexFirmware}
                type="button"
              >
                {flashing ? "Programming..." : "Flash Firmware"}
              </button>

              <button
                className={`${buttonBase} border-slate-300 bg-white text-slate-700 hover:bg-slate-100`}
                disabled={busy || logs.length === 0}
                onClick={() => setLogs("")}
                type="button"
              >
                Clear Log
              </button>
            </div>

            <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3">
              <div className="mb-2 text-xs font-semibold text-blue-900">
                CMSIS-DAP Firmware for RP2040
              </div>
              <a
                className={`${buttonBase} block border-blue-600 bg-blue-600 text-center text-white hover:bg-blue-700`}
                download="free_dap_rp2040.uf2"
                href="./firmware/free_dap_rp2040.uf2"
              >
                Download UF2 Firmware
              </a>
              <div className="mt-2 text-xs text-blue-600">
                Flash to RP2040: Hold BOOTSEL, connect USB, drag & drop UF2
              </div>
            </div>
          </aside>
        </div>

        <div className="border-t border-slate-200 bg-slate-950 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-200">
              Console
            </div>

            <button
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-800"
              onClick={() => setShowConsole((current) => !current)}
              type="button"
            >
              {showConsole ? "Ocultar consola" : "Mostrar consola"}
            </button>
          </div>

          {showConsole ? (
            <div
              className="mt-3 h-[44vh] min-h-[300px] overflow-y-auto rounded-md border border-slate-800 bg-slate-900 p-3 font-mono text-sm whitespace-pre-wrap text-slate-100"
              ref={logsContainerRef}
            >
              {logs || "Ready.\n"}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
