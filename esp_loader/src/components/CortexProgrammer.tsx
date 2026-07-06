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

type FamilyFilter = "py32";

const FAMILY_FILTERS = [
  { id: "py32", label: "PY32F003" },
] as const satisfies ReadonlyArray<{ id: FamilyFilter; label: string }>;

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
  const [familyFilter, setFamilyFilter] = useState<FamilyFilter>("py32");
  const [targetSearch, setTargetSearch] = useState("");
  const [logs, setLogs] = useState("");
  const [flashing, setFlashing] = useState(false);
  const [firmware, setFirmware] = useState<File | null>(null);
  const [firmwareBytes, setFirmwareBytes] = useState<Uint8Array | null>(null);
  const [firmwareHandle, setFirmwareHandle] =
    useState<FileSystemFileHandleLike | null>(null);
  const [firmwareName, setFirmwareName] = useState("");
  const [progress, setProgress] = useState(0);
  const [showConsole, setShowConsole] = useState(false);
  const logsContainerRef = useRef<HTMLDivElement | null>(null);

  function addLog(text: string) {
    setLogs((prev) => prev + text);
  }

  const targetEntries = Object.entries(TARGETS) as Array<
    [TargetKey, (typeof TARGETS)[TargetKey]]
  >;
  const normalizedSearch = targetSearch.trim().toLowerCase();
  const filteredTargetEntries = targetEntries.filter(([key, target]) => {
    const searchableText = `${key} ${target.label} ${target.description} ${target.family}`.toLowerCase();
    return searchableText.includes(normalizedSearch);
  });
  const selectedTargetAvailable = filteredTargetEntries.some(
    ([key]) => key === selectedTarget
  );

  function selectFamily(nextFamily: FamilyFilter) {
    setFamilyFilter(nextFamily);

    const firstMatchingTarget = targetEntries.find(
      ([, target]) => target.family === nextFamily
    );
    if (firstMatchingTarget) {
      setSelectedTarget(firstMatchingTarget[0]);
    }
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
    if (!showConsole) return;

    const logsElement = logsContainerRef.current;
    if (!logsElement) return;

    logsElement.scrollTop = logsElement.scrollHeight;
  }, [logs, showConsole]);

  const busy = flashing;
  const selectedTargetConfig = TARGETS[selectedTarget];
  const firmwareSize = firmware ? formatBytes(firmware.size) : "No file";
  const statusLabel = flashing ? "Programming" : "Ready";
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
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Familia
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {FAMILY_FILTERS.map((family) => (
                      <button
                        className={`rounded-md border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                          familyFilter === family.id
                            ? "border-cyan-400 bg-cyan-50 text-cyan-950"
                            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                        }`}
                        disabled={busy}
                        key={family.id}
                        onClick={() => selectFamily(family.id)}
                        type="button"
                      >
                        {family.label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="min-w-0">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Buscar
                  </div>
                  <input
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950 placeholder:text-slate-400"
                    disabled={busy}
                    onChange={(event) => setTargetSearch(event.target.value)}
                    placeholder="py32f003x4, py32f003x6, py32f003x8..."
                    type="search"
                    value={targetSearch}
                  />
                </label>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Target
                </div>
                <select
                  className="mt-2 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm font-semibold text-slate-950"
                  disabled={busy || filteredTargetEntries.length === 0}
                  onChange={(event) => setSelectedTarget(event.target.value as TargetKey)}
                  value={selectedTargetAvailable ? selectedTarget : ""}
                >
                  {filteredTargetEntries.length === 0 ? (
                    <option value="">Sin targets disponibles</option>
                  ) : selectedTargetAvailable ? null : (
                    <option value="">Selecciona un target</option>
                  )}
                  {filteredTargetEntries.map(([key, target]) => (
                    <option key={key} value={key}>
                      {target.label}
                    </option>
                  ))}
                </select>
                <div className="mt-1 text-sm text-slate-500">
                  {filteredTargetEntries.length === 0
                    ? "Familia sin soporte de flash web por ahora."
                    : selectedTargetAvailable
                      ? selectedTargetConfig.description
                      : "Elige un target de la lista filtrada."}
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Flash
                </div>
                <div className="mt-2 font-mono text-sm font-semibold text-slate-950">
                  {selectedTargetAvailable
                    ? formatHex32(selectedTargetConfig.flashBase)
                    : "--"}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  {selectedTargetAvailable ? (
                    <>
                      Erase: {formatBytes(selectedTargetConfig.pageSize)}
                      {"programPageSize" in selectedTargetConfig
                        ? `, program: ${formatBytes(selectedTargetConfig.programPageSize)}`
                        : ""}
                    </>
                  ) : (
                    "Sin target seleccionado"
                  )}
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
                className={`${buttonBase} border-slate-900 bg-slate-950 text-white hover:bg-slate-800`}
                disabled={busy || !firmware || !selectedTargetAvailable}
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
              El flujo usa el algoritmo configurado para el target seleccionado y verifica la flash.
            </div>
          </aside>
        </div>

        <div className="border-t border-slate-200 bg-slate-950 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-200">
                Console
              </div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                CMSIS-DAP / SWD
              </div>
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
