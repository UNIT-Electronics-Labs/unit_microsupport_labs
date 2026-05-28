import { useEffect, useRef, useState } from "react";
import { ESPLoader, Transport } from "esptool-js";

const FIRMWARE_FAMILIES = [
  "esp32",
  "esp32c3",
  "esp32c5",
  "esp32c6",
  "esp32h2",
  "esp32s3",
] as const;

const FAMILY_LABELS: Record<(typeof FIRMWARE_FAMILIES)[number], string> = {
  esp32: "ESP32",
  esp32c3: "ESP32-C3",
  esp32c5: "ESP32-C5",
  esp32c6: "ESP32-C6",
  esp32h2: "ESP32-H2",
  esp32s3: "ESP32-S3",
};

type FirmwareFamily = (typeof FIRMWARE_FAMILIES)[number];
type FirmwareChannel = "standard" | "micropython";

type FirmwareCatalog = Record<
  FirmwareFamily,
  {
    standard: string[];
    micropython: string[];
  }
>;

function createEmptyCatalog(): FirmwareCatalog {
  return {
    esp32: { standard: [], micropython: [] },
    esp32c3: { standard: [], micropython: [] },
    esp32c5: { standard: [], micropython: [] },
    esp32h2: { standard: [], micropython: [] },
    esp32c6: { standard: [], micropython: [] },
    esp32s3: { standard: [], micropython: [] },
  };
}

function detectFamily(fileName: string): FirmwareFamily {
  const name = fileName.toLowerCase();
  if (name.includes("esp32c3")) return "esp32c3";
  if (name.includes("esp32c5")) return "esp32c5";
  if (name.includes("esp32h2")) return "esp32h2";
  if (name.includes("esp32c6")) return "esp32c6";
  if (name.includes("esp32s3")) return "esp32s3";
  return "esp32";
}

function isMicroPythonFirmware(fileName: string): boolean {
  const name = fileName.toLowerCase();
  return name.includes("micropython") || name.includes("micro_python");
}

function buildCatalogFromFiles(files: string[]): FirmwareCatalog {
  const catalog = createEmptyCatalog();

  for (const file of files) {
    const family = detectFamily(file);
    const channel: FirmwareChannel = isMicroPythonFirmware(file)
      ? "micropython"
      : "standard";

    catalog[family][channel].push(file);
  }

  for (const family of FIRMWARE_FAMILIES) {
    catalog[family].standard.sort((a, b) => a.localeCompare(b));
    catalog[family].micropython.sort((a, b) => a.localeCompare(b));
  }

  return catalog;
}

export default function ESPFlasher() {

  const [connected, setConnected] = useState(false);

  const [logs, setLogs] = useState("");

  const [port, setPort] = useState<any>(null);

  const [firmware, setFirmware] = useState<File | null>(null);

  const [firmwareName, setFirmwareName] = useState("");

  const [firmwareCatalog, setFirmwareCatalog] = useState<FirmwareCatalog>(
    createEmptyCatalog()
  );

  const [selectedFamily, setSelectedFamily] = useState<FirmwareFamily>("esp32");

  const [selectedChannel, setSelectedChannel] = useState<FirmwareChannel>("standard");

  const [selectedFirmwareFile, setSelectedFirmwareFile] = useState("");

  const [firmwareSource, setFirmwareSource] = useState<"local" | "web">("local");

  const [flashAddress, setFlashAddress] = useState("0x0000");

  const [flashing, setFlashing] = useState(false);

  const [progress, setProgress] = useState(0);

  const readerRef = useRef<any>(null);

  const logsContainerRef = useRef<HTMLDivElement | null>(null);

  function getSerialApi() {
    return (navigator as Navigator & { serial?: any }).serial;
  }

  async function stopReading() {
    if (!readerRef.current) return;

    try {
      await readerRef.current.cancel();
    } catch {
      // Reader may already be closed.
    }

    try {
      readerRef.current.releaseLock();
    } catch {
      // Lock may already be released.
    }

    readerRef.current = null;
  }

  async function openPortSafely(selectedPort: any, baudRate = 115200) {
    if (!selectedPort) return;

    try {
      await selectedPort.open({ baudRate });
    } catch (err: any) {
      if (err?.name !== "InvalidStateError") {
        throw err;
      }
    }
  }

  function addLog(text: string) {
    setLogs((prev) => prev + text);
  }

  function getPublicUrls(filePath: string) {
    const normalizedPath = filePath.startsWith("/")
      ? filePath.slice(1)
      : filePath;

    const baseUrl = import.meta.env.BASE_URL ?? "/";
    const primary = `${baseUrl}${normalizedPath}`;
    const fallback = `/${normalizedPath}`;

    return primary === fallback ? [primary] : [primary, fallback];
  }

  async function delay(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function loadFirmwareManifest() {
    try {
      const manifestUrls = getPublicUrls("firmware/manifest.json");
      let response: Response | null = null;

      for (const manifestUrl of manifestUrls) {
        const currentResponse = await fetch(manifestUrl, { cache: "no-store" });
        if (currentResponse.ok) {
          response = currentResponse;
          break;
        }
      }

      if (!response) {
        addLog("Could not read manifest.json (404)\n");
        return;
      }

      const payload = await response.json();

      const files = Array.isArray(payload)
        ? payload
        : Array.isArray(payload.files)
          ? payload.files
          : [];

      const normalizedFiles = files.filter(
        (file: unknown) =>
          typeof file === "string" && file.toLowerCase().endsWith(".bin")
      );

      let catalog: FirmwareCatalog | null = null;

      if (payload && typeof payload === "object" && "families" in payload) {
        const families = (payload as { families?: Record<string, unknown> }).families;
        if (families && typeof families === "object") {
          const nextCatalog = createEmptyCatalog();

          for (const family of FIRMWARE_FAMILIES) {
            const familyEntry = families[family] as
              | { standard?: unknown; micropython?: unknown; firmware?: unknown }
              | undefined;

            const standard = Array.isArray(familyEntry?.standard)
              ? familyEntry?.standard
              : Array.isArray(familyEntry?.firmware)
                ? familyEntry?.firmware
                : [];

            const micropython = Array.isArray(familyEntry?.micropython)
              ? familyEntry?.micropython
              : [];

            nextCatalog[family].standard = standard.filter(
              (file): file is string =>
                typeof file === "string" && file.toLowerCase().endsWith(".bin")
            );

            nextCatalog[family].micropython = micropython.filter(
              (file): file is string =>
                typeof file === "string" && file.toLowerCase().endsWith(".bin")
            );
          }

          catalog = nextCatalog;
        }
      }

      if (!catalog) {
        catalog = buildCatalogFromFiles(normalizedFiles);
      }

      const hasAnyFirmware = FIRMWARE_FAMILIES.some(
        (family) =>
          catalog[family].standard.length > 0 ||
          catalog[family].micropython.length > 0
      );

      if (!hasAnyFirmware) {
        addLog("No firmwares found in manifest.json\n");
        return;
      }

      setFirmwareCatalog(catalog);

      const firstFamilyWithFirmware =
        FIRMWARE_FAMILIES.find(
          (family) =>
            catalog[family].standard.length > 0 ||
            catalog[family].micropython.length > 0
        ) ?? "esp32";

      setSelectedFamily(firstFamilyWithFirmware);

      const defaultChannel: FirmwareChannel =
        catalog[firstFamilyWithFirmware].standard.length > 0
          ? "standard"
          : "micropython";

      setSelectedChannel(defaultChannel);

      const firstFirmware = catalog[firstFamilyWithFirmware][defaultChannel][0] ?? "";
      setSelectedFirmwareFile(firstFirmware);
    } catch (err: any) {
      console.error("Error loading manifest:", err);
      addLog(`Error loading firmware list: ${err.message}\n`);
    }
  }

  async function loadWebFirmwareByName(fileName: string) {
    try {
      if (!fileName) {
        addLog("Select a firmware from the menu\n");
        return null;
      }

      addLog(`Loading firmware: ${fileName}...\n`);
      const firmwareUrls = getPublicUrls(`firmware/${fileName}`);
      let response: Response | null = null;

      for (const firmwareUrl of firmwareUrls) {
        const currentResponse = await fetch(firmwareUrl);
        if (currentResponse.ok) {
          response = currentResponse;
          break;
        }
      }

      if (!response) {
        addLog("Error HTTP: 404 Not Found\n");
        return null;
      }

      addLog(`Respuesta HTTP: ${response.status} ${response.statusText}\n`);
      
      const blob = await response.blob();
      addLog(`Blob loaded: ${blob.size} bytes\n`);
      
      const file = new File([blob], fileName, { type: "application/octet-stream" });
      setFirmware(file);
      setFirmwareName(fileName);
      addLog(`✓ Firmware loaded: ${fileName} (${file.size} bytes)\n`);
      return file;
    } catch (err: any) {
      console.error("Error in loadDefaultFirmware:", err);
      addLog(`✗ Error loading firmware: ${err.message}\n`);
      return null;
    }
  }

  async function connectESP() {

    try {

      const serial = getSerialApi();

      if (!serial) {

        alert("Web Serial API is not supported");

        return;
      }

      const selectedPort = await serial.requestPort();

      await openPortSafely(selectedPort, 115200);

      setPort(selectedPort);

      setConnected(true);

      addLog("ESP connected\n");

      void startReading(selectedPort);

    } catch (err: any) {

      console.error(err);

      addLog(`Connect Error: ${err.message}\n`);
    }
  }

  async function startReading(selectedPort: any) {

    try {

      if (!selectedPort.readable) return;

      const reader = selectedPort.readable.getReader();

      readerRef.current = reader;

      while (true) {

        const { value, done } = await reader.read();

        if (done) break;

        if (value) {

          const text = new TextDecoder().decode(value);

          addLog(text);
        }
      }

      try {
        readerRef.current?.releaseLock();
      } catch {
        // No-op.
      }
      readerRef.current = null;

    } catch (err: any) {

      console.error(err);

      addLog(`Read Error: ${err.message}\n`);

    } finally {
      try {
        readerRef.current?.releaseLock();
      } catch {
        // No-op.
      }
      readerRef.current = null;
    }
  }

  async function disconnectESP() {

    try {

      await stopReading();

      if (port) {

        await port.close();
      }

      setConnected(false);

      setPort(null);

      addLog("\nESP disconnected\n");

    } catch (err: any) {

      console.error(err);

      addLog(`Disconnect Error: ${err.message}\n`);
    }
  }

  async function flashFirmware() {

    try {

      if (!port) {

        alert("Connect the ESP32");

        return;
      }

      let firmwareToFlash = firmware;

      if (
        firmwareSource === "web" &&
        (!firmwareToFlash || firmwareName !== selectedFirmwareFile)
      ) {
        firmwareToFlash = await loadWebFirmwareByName(selectedFirmwareFile);
      }

      if (!firmwareToFlash) {

        alert("Select a firmware");

        return;
      }

      setFlashing(true);

      setProgress(0);

      addLog("\nInicializando esptool...\n");

      await stopReading();
      await delay(50);

      try {
        await port.close();
      } catch {
        // Already closed or closing.
      }

      await delay(100);

      const transport = new Transport(port);

      const esploader = new ESPLoader({

        transport,

        baudrate: 115200,

        terminal: {

          clean() {},

          writeLine(data: string) {
            addLog(data + "\n");
          },

          write(data: string) {
            addLog(data);
          },
        },
      });

      await esploader.main("default_reset");

      addLog("ESP detected successfully\n");

      const firmwareBuffer = await firmwareToFlash.arrayBuffer();

      const binary = new Uint8Array(firmwareBuffer);

      const parsedFlashAddress = Number.parseInt(flashAddress, 16);

      addLog("Starting flash...\n");

      await esploader.writeFlash({

        fileArray: [

          {
            data: binary,
            address: parsedFlashAddress,
          },
        ],

        flashSize: "keep",

        flashMode: "keep",

        flashFreq: "keep",

        eraseAll: false,

        compress: true,

        reportProgress: (
          _fileIndex: number,
          written: number,
          total: number
        ) => {

          const percent =
            Number(((written / total) * 100).toFixed(1));

          setProgress(percent);
        },
      });

      addLog("\nFirmware flashed successfully\n");

      setProgress(100);

      await esploader.transport.disconnect();

      setConnected(false);
      setPort(null);

      addLog("ESP released\n");

      setFlashing(false);

    } catch (err: any) {

      console.error(err);

      addLog(`\nFlash Error: ${err.message}\n`);

      setFlashing(false);
    }
  }

  async function eraseFlash() {

    try {

      if (!port) {

        alert("Connect the ESP32");

        return;
      }

      setFlashing(true);

      setProgress(0);

      addLog("\nInitializing erase...\n");

      await stopReading();
      await delay(50);

      try {
        await port.close();
      } catch {
        // Already closed or closing.
      }

      await delay(100);

      const transport = new Transport(port);

      const esploader = new ESPLoader({

        transport,

        baudrate: 115200,

        terminal: {

          clean() {},

          writeLine(data: string) {
            addLog(data + "\n");
          },

          write(data: string) {
            addLog(data);
          },
        },
      });

      await esploader.main("default_reset");

      addLog("ESP detected successfully\n");
      addLog("Starting full erase...\n");

      await esploader.eraseFlash();

      addLog("\nFlash erased successfully\n");

      setProgress(100);

      await esploader.transport.disconnect();

      setConnected(false);
      setPort(null);

      addLog("ESP released\n");

      setFlashing(false);

    } catch (err: any) {

      console.error(err);

      addLog(`\nErase Error: ${err.message}\n`);

      setFlashing(false);
    }
  }

  async function resetESP32() {

    try {

      if (!port) {

        alert("Connect the ESP32");

        return;
      }

      addLog("\nResetting ESP32...\n");

      await stopReading();
      await delay(80);

      try {
        await port.setSignals({
          dataTerminalReady: false,
          requestToSend: true,
        });
        await delay(120);

        await port.setSignals({
          dataTerminalReady: false,
          requestToSend: false,
        });
        await delay(120);
      } catch {
        addLog("Reset control signals are not available on this adapter\n");
      }

      await openPortSafely(port, 115200);
      void startReading(port);

      addLog("ESP32 reset sequence sent\n");

    } catch (err: any) {

      console.error(err);

      addLog(`Reset Error: ${err.message}\n`);
    }
  }

  useEffect(() => {
    void loadFirmwareManifest();

    return () => {
      disconnectESP();
    };

  }, []);

  useEffect(() => {
    const logsElement = logsContainerRef.current;
    if (!logsElement) return;

    logsElement.scrollTop = logsElement.scrollHeight;
  }, [logs]);

  const connectButtonClass =
    "rounded-md border border-blue-300 bg-blue-100 px-3 py-2 text-sm font-semibold text-blue-800 transition hover:bg-blue-200 disabled:cursor-not-allowed disabled:opacity-50";

  const flashButtonClass =
    "rounded-md border border-emerald-300 bg-emerald-100 px-3 py-2 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50";

  const eraseButtonClass =
    "rounded-md border border-amber-300 bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50";

  const resetButtonClass =
    "rounded-md border border-violet-300 bg-violet-100 px-3 py-2 text-sm font-semibold text-violet-800 transition hover:bg-violet-200 disabled:cursor-not-allowed disabled:opacity-50";

  const inputClass =
    "rounded-md border border-slate-300 bg-white/85 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400";

  const availableFilesForSelection =
    firmwareCatalog[selectedFamily][selectedChannel];

  function selectFamily(family: FirmwareFamily) {
    setFirmwareSource("web");
    setSelectedFamily(family);

    const nextChannel: FirmwareChannel =
      firmwareCatalog[family].standard.length > 0
        ? "standard"
        : "micropython";

    setSelectedChannel(nextChannel);
    const nextFile = firmwareCatalog[family][nextChannel][0] ?? "";
    setSelectedFirmwareFile(nextFile);
    if (nextFile) {
      void loadWebFirmwareByName(nextFile);
    }
  }

  return (

    <div className="mx-auto min-h-screen w-[min(98vw,1800px)] px-2 py-3 md:px-4">

      <div className="rounded-xl border border-slate-200 bg-white/85 p-3 shadow-lg shadow-sky-100/70 backdrop-blur md:p-4">

        <div className="mb-3 flex flex-wrap items-center gap-1.5 md:gap-2">

        <div className="w-full">
          <div className="mb-2 grid w-full grid-cols-2 rounded-lg border border-slate-300 bg-white p-1">
            <button
              className={`rounded-md px-3 py-2 text-sm font-semibold transition ${firmwareSource === "local" ? "bg-sky-200 text-slate-800" : "text-slate-600 hover:bg-slate-100"}`}
              onClick={() => setFirmwareSource("local")}
              type="button"
            >
              Local Firmware
            </button>
            <button
              className={`rounded-md px-3 py-2 text-sm font-semibold transition ${firmwareSource === "web" ? "bg-sky-200 text-slate-800" : "text-slate-600 hover:bg-slate-100"}`}
              onClick={() => {
                setFirmwareSource("web");
                if (selectedFirmwareFile) {
                  void loadWebFirmwareByName(selectedFirmwareFile);
                }
              }}
              type="button"
            >
              Web Firmware
            </button>
          </div>

          {firmwareSource === "local" && (
            <div className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Recommended for compatibility: use Local Firmware.
            </div>
          )}

          {firmwareSource === "local" ? (
            <div className="rounded-lg border border-sky-300 bg-sky-50 p-2.5">
              <input
                className={`${inputClass} w-full file:mr-3 file:rounded-md file:border-0 file:bg-teal-300 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-800 hover:file:bg-teal-200`}
                type="file"
                accept=".bin"
                onChange={(e) => {

                  if (e.target.files?.length) {

                    setFirmwareSource("local");
                    setFirmware(e.target.files[0]);
                    setFirmwareName(e.target.files[0].name);

                    addLog(
                      `Firmware selected: ${e.target.files[0].name}\n`
                    );
                  }
                }}
              />
            </div>
          ) : (
            <div className="rounded-lg border border-sky-300 bg-sky-50 p-2.5">
              <div className="grid gap-1.5 md:grid-cols-[170px_170px_minmax(0,1fr)_auto] md:items-end">
                <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Board
                  <select
                    className={inputClass}
                    value={selectedFamily}
                    onChange={(e) => selectFamily(e.target.value as FirmwareFamily)}
                  >
                    {FIRMWARE_FAMILIES.map((family) => (
                      <option key={family} value={family}>
                        {FAMILY_LABELS[family]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Channel
                  <select
                    className={inputClass}
                    value={selectedChannel}
                    onChange={(e) => {
                      const nextChannel = e.target.value as FirmwareChannel;
                      setFirmwareSource("web");
                      setSelectedChannel(nextChannel);
                      const nextFile = firmwareCatalog[selectedFamily][nextChannel][0] ?? "";
                      setSelectedFirmwareFile(nextFile);
                      if (nextFile) {
                        void loadWebFirmwareByName(nextFile);
                      }
                    }}
                  >
                    <option value="standard">Standard</option>
                    <option value="micropython">MicroPython</option>
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Firmware
                  <select
                    className={`${inputClass} w-full`}
                    value={selectedFirmwareFile}
                    onChange={(e) => {
                      setFirmwareSource("web");
                      setSelectedFirmwareFile(e.target.value);
                      if (e.target.value) {
                        void loadWebFirmwareByName(e.target.value);
                      }
                    }}
                    disabled={availableFilesForSelection.length === 0}
                  >
                    {availableFilesForSelection.length === 0 && (
                      <option value="">No firmware found</option>
                    )}
                    {availableFilesForSelection.map((firmwareFile) => (
                      <option key={firmwareFile} value={firmwareFile}>
                        {firmwareFile}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs text-slate-600">
                  {availableFilesForSelection.length} image(s)
                </div>
              </div>
            </div>
          )}
        </div>

        <input
          className={inputClass}
          type="text"
          placeholder="Flash Address (e.g., 0x0000)"
          value={flashAddress}
          onChange={(e) => setFlashAddress(e.target.value)}
        />

        <div className="w-full rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Merged firmware: use origin address <span className="font-semibold">0x0000</span>
        </div>

        {firmwareName && (
          <div className="rounded-md border border-emerald-300 bg-emerald-100 px-3 py-1.5 text-sm text-emerald-700">
            ✓ {firmwareName}
          </div>
        )}

        <div className="w-full rounded-md border border-slate-200 bg-white/70 p-2">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Actions
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={connectButtonClass}
              onClick={connected ? disconnectESP : connectESP}
            >
              {connected ? "Disconnect" : "Connect ESP32"}
            </button>

            <button
              className={flashButtonClass}
              onClick={flashFirmware}
              disabled={!connected || !firmware || flashing}
            >
              {flashing ? "Flashing..." : "Flash Firmware"}
            </button>

            <button
              className={eraseButtonClass}
              onClick={eraseFlash}
              disabled={!connected || flashing}
            >
              Erase Flash
            </button>

            <button
              className={resetButtonClass}
              onClick={resetESP32}
              disabled={!connected || flashing}
            >
              Reset ESP32
            </button>

          </div>
        </div>

        </div>

        <div className="mb-1.5 h-3 w-full overflow-hidden rounded-full border border-slate-300 bg-slate-100">

          <div
            className="h-full rounded-full bg-gradient-to-r from-sky-300 via-teal-300 to-emerald-300 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />

        </div>

        <div className="mb-2 text-sm text-slate-600">
          Progress: {progress}%
        </div>

      <div
        ref={logsContainerRef}
        className={`${firmwareSource === "web" ? "h-[44vh] min-h-[230px]" : "h-[52vh] min-h-[300px]"} overflow-y-auto rounded-lg border border-slate-300 bg-slate-50 p-3 font-mono text-sm text-slate-700 whitespace-pre-wrap`}
      >
        {logs}
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-sm text-slate-600">

        Status:

        <span className={connected ? "font-semibold text-emerald-700" : "font-semibold text-rose-700"}>
          {connected ? "CONNECTED" : "DISCONNECTED"}
        </span>

      </div>

      <footer className="mt-3 border-t border-slate-200 pt-2 text-center text-[11px] text-slate-500">
        Internal Programmer
      </footer>

      </div>

    </div>
  );
}
