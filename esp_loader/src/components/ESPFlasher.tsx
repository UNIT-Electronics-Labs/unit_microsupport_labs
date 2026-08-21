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

const UPLOAD_BAUD_RATES = [115200, 230400, 460800, 921600] as const;
// A blank ESP has to be reached through its ROM bootloader. Start with the
// most reliable speed; production can raise it after the fixture is proven.
const DEFAULT_UPLOAD_BAUD_RATE = 115200;
const MAX_ESP_SLOTS = 10;
const espPortInstanceIds = new WeakMap<object, number>();
let nextEspPortInstanceId = 1;

type FirmwareFamily = (typeof FIRMWARE_FAMILIES)[number];
type FirmwareChannel = "standard" | "micropython";
type EspPortSlot = {
  id: string;
  label: string;
  port: any;
};
type EspSlotFlashStatus = {
  state: "waiting" | "programming" | "success" | "no_flash" | "error";
  progress: number;
  message?: string;
};

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

function getEspFlashErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.toLowerCase().includes("failed to connect with the device")) {
    return "Sin respuesta del bootloader. Mantén BOOT, pulsa RESET y programa a 115200 baud.";
  }

  return message;
}

async function isFlashDetected(esploader: ESPLoader): Promise<boolean> {
  try {
    const flashId = await esploader.readFlashId();
    return flashId !== 0x000000 && flashId !== 0xffffff;
  } catch {
    return false;
  }
}

function getEspPortSlot(port: any): EspPortSlot {
  const info = port.getInfo?.() ?? {};
  const vendorId = info.usbVendorId?.toString(16).padStart(4, "0") ?? "????";
  const productId = info.usbProductId?.toString(16).padStart(4, "0") ?? "????";
  let instanceId = 0;

  if (typeof port === "object" && port !== null) {
    instanceId = espPortInstanceIds.get(port) ?? nextEspPortInstanceId++;
    espPortInstanceIds.set(port, instanceId);
  }

  return {
    id: `serial:${vendorId}:${productId}:${instanceId}`,
    label: `Web Serial · ${vendorId}:${productId}`,
    port,
  };
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

  // Keep the current handles outside React state so that the cleanup on
  // unmount/page reload never uses a stale `port` value.
  const portRef = useRef<any>(null);

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

  const [uploadBaudRate, setUploadBaudRate] = useState(
    DEFAULT_UPLOAD_BAUD_RATE
  );

  const [configurationOpen, setConfigurationOpen] = useState(true);

  const [showConsole, setShowConsole] = useState(true);

  const [productionOrder, setProductionOrder] = useState("");

  const [espPortSlots, setEspPortSlots] = useState<Array<EspPortSlot | null>>(
    () => Array.from({ length: MAX_ESP_SLOTS }, () => null)
  );

  const espPortSlotsRef = useRef<Array<EspPortSlot | null>>([]);

  const [activeEspSlotIndex, setActiveEspSlotIndex] = useState<number | null>(
    null
  );

  const [selectedEspPortIds, setSelectedEspPortIds] = useState<string[]>([]);

  const [espFlashStatuses, setEspFlashStatuses] = useState<
    Record<string, EspSlotFlashStatus>
  >({});

  const readerRef = useRef<any>(null);

  const logsContainerRef = useRef<HTMLDivElement | null>(null);

  function getSerialApi() {
    return (navigator as Navigator & { serial?: any }).serial;
  }

  function setActivePort(nextPort: any) {
    portRef.current = nextPort;
    setPort(nextPort);
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

  async function releaseEspPorts() {
    await stopReading();

    const ports = [
      portRef.current,
      ...espPortSlotsRef.current.map((slot) => slot?.port),
    ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

    await Promise.all(
      ports.map(async (serialPort) => {
        try {
          await serialPort.close();
        } catch {
          // A port may already have been closed by esptool or the browser.
        }
      })
    );

    portRef.current = null;
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

  function isDeviceLostError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.toLowerCase().includes("device has been lost") ||
      message.toLowerCase().includes("failed to open serial port") ||
      message.toLowerCase().includes("already closed") ||
      message.toLowerCase().includes("serial data stream stopped")
    );
  }

  function forgetLostPort(lostPort: any, reason?: string) {
    const lostPortIds = espPortSlots
      .filter((slot): slot is EspPortSlot => slot?.port === lostPort)
      .map((slot) => slot.id);

    setEspPortSlots((current) =>
      current.map((slot) => (slot?.port === lostPort ? null : slot))
    );
    setSelectedEspPortIds((current) =>
      current.filter((portId) => !lostPortIds.includes(portId))
    );
    setEspFlashStatuses((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([portId]) => !lostPortIds.includes(portId))
      )
    );

    if (port === lostPort) {
      setConnected(false);
      setActivePort(null);
      setActiveEspSlotIndex(null);
    }

    addLog(
      `${reason ?? "El puerto USB se desconectó"}. Selección eliminada; vuelve a conectar el ESP desde su tarjeta.\n`
    );
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

  async function connectESP(slotIndex?: number) {

    try {

      const serial = getSerialApi();

      if (!serial) {

        alert("Web Serial API is not supported");

        return;
      }

      const selectedPort = await serial.requestPort();

      if (port && port !== selectedPort) {
        await stopReading();
      }

      await openPortSafely(selectedPort, 115200);

      setActivePort(selectedPort);

      setConnected(true);

      const nextSlot = getEspPortSlot(selectedPort);
      setSelectedEspPortIds((current) =>
        current.includes(nextSlot.id) ? current : [...current, nextSlot.id]
      );
      setEspPortSlots((current) => {
        const existingIndex = current.findIndex(
          (slot) => slot?.port === selectedPort
        );
        const targetIndex =
          slotIndex ??
          (existingIndex >= 0 ? existingIndex : current.indexOf(null));
        const resolvedIndex = targetIndex === -1 ? 0 : targetIndex;

        return current.map((slot, index) => {
          if (index === resolvedIndex) return nextSlot;
          return slot?.port === selectedPort ? null : slot;
        });
      });
      const existingIndex = espPortSlots.findIndex(
        (slot) => slot?.port === selectedPort
      );
      const nextActiveSlotIndex =
        slotIndex ??
        (existingIndex >= 0 ? existingIndex : espPortSlots.indexOf(null));
      setActiveEspSlotIndex(
        nextActiveSlotIndex === -1 ? 0 : nextActiveSlotIndex
      );

      addLog("ESP connected\n");

      void startReading(selectedPort);

    } catch (err: any) {

      console.error(err);
      if (err?.name === "NotFoundError") {
        addLog("Selección de puerto cancelada.\n");
      } else {
        addLog(`Connect Error: ${err.message}\n`);
      }
    }
  }

  async function selectEspPortSlot(slotIndex: number) {
    const slot = espPortSlots[slotIndex];
    if (!slot || flashing) return;

    try {
      if (port !== slot.port) {
        await stopReading();
        await openPortSafely(slot.port, 115200);
        setActivePort(slot.port);
        void startReading(slot.port);
      }

      setActiveEspSlotIndex(slotIndex);
      setConnected(true);
      addLog(`ESP seleccionado: ${slot.label}\n`);
    } catch (err: any) {
      console.error(err);
      if (isDeviceLostError(err)) {
        forgetLostPort(slot.port, "No se pudo volver a abrir el dispositivo USB");
      }
      addLog(`Connect Error: ${err.message}\n`);
    }
  }

  async function removeEspPortSlot(slotIndex: number) {
    const slot = espPortSlots[slotIndex];
    if (!slot || flashing) return;

    if (activeEspSlotIndex === slotIndex) {
      await disconnectESP();
      setActiveEspSlotIndex(null);
    }

    setEspPortSlots((current) =>
      current.map((currentSlot, index) =>
        index === slotIndex ? null : currentSlot
      )
    );
    setSelectedEspPortIds((current) =>
      current.filter((portId) => portId !== slot.id)
    );
    setEspFlashStatuses((current) => {
      const { [slot.id]: _removedStatus, ...remainingStatuses } = current;
      return remainingStatuses;
    });
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
      if (isDeviceLostError(err)) {
        forgetLostPort(selectedPort, "El dispositivo USB se perdió");
      } else {
        addLog(`Read Error: ${err.message}\n`);
      }

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

        try {
          await port.close();
        } catch (err: unknown) {
          if (!isDeviceLostError(err)) {
            throw err;
          }
        }
      }

      setConnected(false);

      setActivePort(null);

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

        baudrate: uploadBaudRate,

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
      setActivePort(null);

      addLog("ESP released\n");

      setFlashing(false);

    } catch (err: any) {

      console.error(err);

      if (isDeviceLostError(err) && port) {
        forgetLostPort(port, "El puerto se perdió durante la programación");
      }

      addLog(`\nFlash Error: ${err.message}\n`);

      setFlashing(false);
    }
  }

  async function flashSelectedESPs() {
    const selectedSlots = espPortSlots.filter(
      (slot): slot is EspPortSlot =>
        slot !== null && selectedEspPortIds.includes(slot.id)
    );

    if (selectedSlots.length === 0) {
      addLog("Selecciona al menos una estación ESP para programar.\n");
      return;
    }

    try {
      let firmwareToFlash = firmware;

      if (
        firmwareSource === "web" &&
        (!firmwareToFlash || firmwareName !== selectedFirmwareFile)
      ) {
        firmwareToFlash = await loadWebFirmwareByName(selectedFirmwareFile);
      }

      if (!firmwareToFlash) {
        alert("Selecciona un firmware");
        return;
      }

      const parsedFlashAddress = Number.parseInt(flashAddress, 16);
      if (Number.isNaN(parsedFlashAddress)) {
        throw new Error("La dirección flash debe ser hexadecimal, por ejemplo 0x0000.");
      }

      const firmwareBuffer = await firmwareToFlash.arrayBuffer();
      const binary = new Uint8Array(firmwareBuffer);
      const progressByPort = new Map(
        selectedSlots.map((slot) => [slot.id, 0])
      );

      setFlashing(true);
      setProgress(0);
      setEspFlashStatuses(
        Object.fromEntries(
          selectedSlots.map((slot) => [
            slot.id,
            {
              state: "waiting",
              progress: 0,
              message: "En espera para programar...",
            },
          ])
        )
      );
      addLog(
        `\nIniciando programación paralela de ${selectedSlots.length} estación(es) ESP...\n`
      );

      if (port && selectedSlots.some((slot) => slot.port === port)) {
        await stopReading();
      }

      await Promise.all(
        selectedSlots.map(async (slot) => {
          let transport: Transport | null = null;

          try {
            setEspFlashStatuses((current) => ({
              ...current,
              [slot.id]: {
                state: "programming",
                progress: 0,
                message: "Preparando programación...",
              },
            }));
            addLog(`[${slot.label}] Inicializando esptool...\n`);

            try {
              await slot.port.close();
            } catch {
              // The port can already be closed before esptool opens it.
            }

            transport = new Transport(slot.port);
            const esploader = new ESPLoader({
              transport,
              baudrate: uploadBaudRate,
              terminal: {
                clean() {},
                writeLine(data: string) {
                  addLog(`[${slot.label}] ${data}\n`);
                },
                write(data: string) {
                  addLog(`[${slot.label}] ${data}`);
                },
              },
            });

            await esploader.main("default_reset");
            await esploader.writeFlash({
              fileArray: [{ data: binary, address: parsedFlashAddress }],
              flashSize: "keep",
              flashMode: "keep",
              flashFreq: "keep",
              eraseAll: false,
              compress: true,
              reportProgress: (_fileIndex: number, written: number, total: number) => {
                const slotProgress = Number(((written / total) * 100).toFixed(1));
                progressByPort.set(slot.id, slotProgress);
                const totalProgress = Array.from(progressByPort.values()).reduce(
                  (sum, value) => sum + value,
                  0
                );
                setProgress(
                  Number((totalProgress / selectedSlots.length).toFixed(1))
                );
                setEspFlashStatuses((current) => ({
                  ...current,
                  [slot.id]: {
                    state: "programming",
                    progress: slotProgress,
                  },
                }));
              },
            });

            await transport.disconnect();
            transport = null;
            setEspFlashStatuses((current) => ({
              ...current,
              [slot.id]: {
                state: "success",
                progress: 100,
                message: "Programado",
              },
            }));
            addLog(`[${slot.label}] Firmware programado correctamente.\n`);
          } catch (err: any) {
            const errorMessage = getEspFlashErrorMessage(err);
            if (isDeviceLostError(err)) {
              forgetLostPort(slot.port, "El puerto se perdió durante la programación");
            }
            setEspFlashStatuses((current) => ({
              ...current,
              [slot.id]: {
                state: "error",
                progress: progressByPort.get(slot.id) ?? 0,
                message: errorMessage,
              },
            }));
            addLog(`[${slot.label}] Error: ${errorMessage}\n`);
            try {
              await transport?.disconnect();
            } catch {
              // Best-effort cleanup after a failed flash operation.
            }
          }
        })
      );

      if (port && selectedSlots.some((slot) => slot.port === port)) {
        setConnected(false);
        setActivePort(null);
      }
    } catch (err: any) {
      console.error(err);
      addLog(`\nError preparando el lote: ${err.message}\n`);
    } finally {
      setFlashing(false);
    }
  }

  async function eraseSelectedESPs() {
    const selectedSlots = espPortSlots.filter(
      (slot): slot is EspPortSlot =>
        slot !== null && selectedEspPortIds.includes(slot.id)
    );

    if (selectedSlots.length === 0) {
      addLog("Selecciona al menos una estación ESP para borrar.\n");
      return;
    }

    try {
      setFlashing(true);
      setProgress(0);
      setEspFlashStatuses(
        Object.fromEntries(
          selectedSlots.map((slot) => [
            slot.id,
            {
              state: "waiting",
              progress: 0,
              message: "En espera para borrar...",
            },
          ])
        )
      );
      addLog(
        `\nIniciando borrado paralelo de ${selectedSlots.length} estación(es) ESP...\n`
      );

      if (port && selectedSlots.some((slot) => slot.port === port)) {
        await stopReading();
      }

      await Promise.all(
        selectedSlots.map(async (slot) => {
          let transport: Transport | null = null;

          try {
            setEspFlashStatuses((current) => ({
              ...current,
              [slot.id]: {
                state: "programming",
                progress: 0,
                message: "Borrando memoria... esperando respuesta.",
              },
            }));
            addLog(`[${slot.label}] Inicializando borrado...\n`);

            try {
              await slot.port.close();
            } catch {
              // The port can already be closed before esptool opens it.
            }

            transport = new Transport(slot.port);
            const esploader = new ESPLoader({
              transport,
              baudrate: uploadBaudRate,
              terminal: {
                clean() {},
                writeLine(data: string) {
                  addLog(`[${slot.label}] ${data}\n`);
                },
                write(data: string) {
                  addLog(`[${slot.label}] ${data}`);
                },
              },
            });

            await esploader.main("default_reset");
            const flashDetected = await isFlashDetected(esploader);
            await esploader.eraseFlash();
            await transport.disconnect();
            transport = null;
            setEspFlashStatuses((current) => ({
              ...current,
              [slot.id]: {
                state: flashDetected ? "success" : "no_flash",
                progress: 100,
                message: flashDetected
                  ? "Borrado"
                  : "Borrado enviado. La flash no respondió a la verificación.",
              },
            }));
            addLog(
              `[${slot.label}] ${
                flashDetected
                  ? "Flash borrada correctamente."
                  : "Comando de borrado enviado; flash no verificada."
              }\n`
            );
          } catch (err: any) {
            const errorMessage = getEspFlashErrorMessage(err);
            if (isDeviceLostError(err)) {
              forgetLostPort(slot.port, "El puerto se perdió durante el borrado");
            }
            setEspFlashStatuses((current) => ({
              ...current,
              [slot.id]: {
                state: "error",
                progress: 0,
                message: errorMessage,
              },
            }));
            addLog(`[${slot.label}] Error: ${errorMessage}\n`);
            try {
              await transport?.disconnect();
            } catch {
              // Best-effort cleanup after a failed erase operation.
            }
          }
        })
      );

      if (port && selectedSlots.some((slot) => slot.port === port)) {
        setConnected(false);
        setActivePort(null);
      }
    } catch (err: any) {
      console.error(err);
      addLog(`\nError preparando el borrado de lote: ${err.message}\n`);
    } finally {
      setFlashing(false);
    }
  }

  async function resetSelectedESPs() {
    const selectedSlots = espPortSlots.filter(
      (slot): slot is EspPortSlot =>
        slot !== null && selectedEspPortIds.includes(slot.id)
    );

    if (selectedSlots.length === 0) {
      addLog("Selecciona al menos una estación ESP para resetear.\n");
      return;
    }

    setFlashing(true);
    setEspFlashStatuses(
      Object.fromEntries(
        selectedSlots.map((slot) => [
          slot.id,
          { state: "programming", progress: 0 },
        ])
      )
    );
    addLog(`\nEnviando reset a ${selectedSlots.length} estación(es) ESP...\n`);

    if (port && selectedSlots.some((slot) => slot.port === port)) {
      await stopReading();
    }

    await Promise.all(
      selectedSlots.map(async (slot) => {
        try {
          await openPortSafely(slot.port, 115200);
          await slot.port.setSignals({
            dataTerminalReady: false,
            requestToSend: true,
          });
          await delay(120);
          await slot.port.setSignals({
            dataTerminalReady: false,
            requestToSend: false,
          });
          await delay(120);
          setEspFlashStatuses((current) => ({
            ...current,
            [slot.id]: {
              state: "success",
              progress: 100,
              message: "Reset enviado",
            },
          }));
          addLog(`[${slot.label}] Reset enviado.\n`);
        } catch (err: any) {
          const isControlSignalError =
            err?.message?.includes("setSignals") ||
            err?.message?.toLowerCase().includes("control signals");
          setEspFlashStatuses((current) => ({
            ...current,
            [slot.id]: {
              state: isControlSignalError ? "success" : "error",
              progress: isControlSignalError ? 100 : 0,
              message: isControlSignalError
                ? "Sin DTR/RTS"
                : err.message,
            },
          }));
          addLog(
            isControlSignalError
              ? `[${slot.label}] Sin DTR/RTS; reset manual requerido.\n`
              : `[${slot.label}] Error de reset: ${err.message}\n`
          );
        }
      })
    );

    if (port && selectedSlots.some((slot) => slot.port === port)) {
      await openPortSafely(port, 115200);
      void startReading(port);
    }

    setFlashing(false);
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

        baudrate: uploadBaudRate,

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
      const flashDetected = await isFlashDetected(esploader);

      addLog("ESP detected successfully\n");
      addLog("Starting full erase...\n");

      await esploader.eraseFlash();

      addLog(
        flashDetected
          ? "\nFlash erased successfully\n"
          : "\nErase command sent; flash could not be verified.\n"
      );

      setProgress(100);

      await esploader.transport.disconnect();

      setConnected(false);
      setActivePort(null);

      addLog("ESP released\n");

      setFlashing(false);

    } catch (err: any) {

      console.error(err);

      if (isDeviceLostError(err) && port) {
        forgetLostPort(port, "El puerto se perdió durante el borrado");
      }

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
        addLog(
          "Este adaptador USB no expone DTR/RTS; no se envió un reset automático. Usa BOOT + RESET en la placa si necesitas entrar al bootloader.\n"
        );
        await openPortSafely(port, 115200);
        void startReading(port);
        return;
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
      void releaseEspPorts();
    };

  }, []);

  useEffect(() => {
    portRef.current = port;
  }, [port]);

  useEffect(() => {
    espPortSlotsRef.current = espPortSlots;
  }, [espPortSlots]);

  useEffect(() => {
    const releaseOnPageExit = () => {
      void releaseEspPorts();
    };

    window.addEventListener("pagehide", releaseOnPageExit);
    return () => window.removeEventListener("pagehide", releaseOnPageExit);
  }, []);

  useEffect(() => {
    const serial = getSerialApi();
    if (!serial?.addEventListener) return;

    const handleDisconnect = (event: Event & { port?: any }) => {
      if (event.port) {
        forgetLostPort(event.port, "El navegador notificó una desconexión USB");
      }
    };

    serial.addEventListener("disconnect", handleDisconnect);
    return () => serial.removeEventListener?.("disconnect", handleDisconnect);
  }, [port, espPortSlots]);

  useEffect(() => {
    const logsElement = logsContainerRef.current;
    if (!logsElement) return;

    logsElement.scrollTop = logsElement.scrollHeight;
  }, [logs]);

  const busy = flashing;
  const buttonBase =
    "rounded border px-2 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
  const inputClass =
    "w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-950 outline-none transition focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-50";

  const availableFilesForSelection =
    firmwareCatalog[selectedFamily][selectedChannel];

  const assignedEspSlots = espPortSlots.filter(
    (slot): slot is EspPortSlot => slot !== null
  );
  const selectedEspSlotCount = assignedEspSlots.filter((slot) =>
    selectedEspPortIds.includes(slot.id)
  ).length;
  const successfulEspCount = Object.values(espFlashStatuses).filter(
    (status) => status.state === "success"
  ).length;
  const failedEspCount = Object.values(espFlashStatuses).filter(
    (status) => status.state === "error"
  ).length;
  const noFlashEspCount = Object.values(espFlashStatuses).filter(
    (status) => status.state === "no_flash"
  ).length;

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
    <main className="min-h-[calc(100vh-65px)] w-full">
      <section className="min-h-[calc(100vh-65px)] overflow-hidden border-y border-slate-800 bg-slate-100">
        <div className={`grid min-w-0 ${configurationOpen ? "xl:grid-cols-[330px_minmax(0,1fr)]" : "grid-cols-1"}`}>
          {configurationOpen ? (
            <div className="grid min-w-0 content-start gap-2 border-b border-r border-slate-300 bg-white p-3 xl:border-b-0">
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold text-slate-950">Configuración ESP</div>
                <div className="font-mono text-[10px] font-bold text-cyan-700">{uploadBaudRate.toLocaleString()} baud</div>
              </div>
              <label className="block min-w-0">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Lote / orden de producción</div>
                <input className={inputClass} disabled={busy} onChange={(event) => setProductionOrder(event.target.value)} placeholder="Ej. OP-2026-0042" type="text" value={productionOrder} />
              </label>
              <div className="grid grid-cols-2 rounded border border-slate-300 bg-slate-50 p-1">
                <button className={`rounded px-2 py-1.5 text-xs font-bold transition ${firmwareSource === "local" ? "bg-cyan-400 text-slate-950 shadow-sm" : "text-slate-600 hover:bg-white"}`} disabled={busy} onClick={() => setFirmwareSource("local")} type="button">Archivo local</button>
                <button className={`rounded px-2 py-1.5 text-xs font-bold transition ${firmwareSource === "web" ? "bg-cyan-400 text-slate-950 shadow-sm" : "text-slate-600 hover:bg-white"}`} disabled={busy} onClick={() => { setFirmwareSource("web"); if (selectedFirmwareFile) void loadWebFirmwareByName(selectedFirmwareFile); }} type="button">Catálogo web</button>
              </div>
              {firmwareSource === "local" ? (
                <div className="rounded border border-slate-300 bg-white p-2">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Firmware</div>
                  <label className={`block w-full rounded border border-slate-900 bg-slate-950 px-2 py-1.5 text-center text-xs font-semibold text-white transition ${busy ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-slate-800"}`}>
                    Seleccionar firmware
                    <input accept=".bin,application/octet-stream" className="sr-only" disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) { setFirmwareSource("local"); setFirmware(file); setFirmwareName(file.name); addLog(`Firmware seleccionado: ${file.name}\n`); } event.currentTarget.value = ""; }} type="file" />
                  </label>
                  <div className="mt-1 truncate rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-semibold text-slate-800">{firmwareName || "Ningún archivo seleccionado"}</div>
                </div>
              ) : (
                <div className="grid gap-2 rounded border border-slate-300 bg-white p-2">
                  <label className="grid gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Microcontrolador
                    <select className={inputClass} disabled={busy} onChange={(event) => selectFamily(event.target.value as FirmwareFamily)} value={selectedFamily}>{FIRMWARE_FAMILIES.map((family) => <option key={family} value={family}>{FAMILY_LABELS[family]}</option>)}</select>
                  </label>
                  <label className="grid gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Canal
                    <select className={inputClass} disabled={busy} onChange={(event) => { const channel = event.target.value as FirmwareChannel; setFirmwareSource("web"); setSelectedChannel(channel); const file = firmwareCatalog[selectedFamily][channel][0] ?? ""; setSelectedFirmwareFile(file); if (file) void loadWebFirmwareByName(file); }} value={selectedChannel}><option value="standard">Estándar</option><option value="micropython">MicroPython</option></select>
                  </label>
                  <label className="grid gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Imagen · {availableFilesForSelection.length} disponible(s)
                    <select className={inputClass} disabled={busy || availableFilesForSelection.length === 0} onChange={(event) => { setFirmwareSource("web"); setSelectedFirmwareFile(event.target.value); if (event.target.value) void loadWebFirmwareByName(event.target.value); }} value={selectedFirmwareFile}>{availableFilesForSelection.length === 0 ? <option value="">Sin firmware</option> : null}{availableFilesForSelection.map((file) => <option key={file} value={file}>{file}</option>)}</select>
                  </label>
                </div>
              )}
              <label className="grid gap-1 rounded border border-slate-300 bg-white p-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Dirección flash
                <input className={inputClass} disabled={busy} onChange={(event) => setFlashAddress(event.target.value)} placeholder="0x0000" type="text" value={flashAddress} />
              </label>
              <label className="grid gap-1 rounded border border-slate-300 bg-white p-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Velocidad de carga
                <select className={inputClass} disabled={busy} onChange={(event) => setUploadBaudRate(Number(event.target.value))} value={uploadBaudRate}>{UPLOAD_BAUD_RATES.map((baudRate) => <option key={baudRate} value={baudRate}>{baudRate.toLocaleString()} baud</option>)}</select>
              </label>
              <div className="rounded border border-slate-300 bg-white p-2"><div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-slate-800"><span>Progreso</span><span className="font-mono text-slate-600">{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-cyan-500 transition-all duration-300" style={{ width: `${progress}%` }} /></div></div>
              <button className="rounded border border-cyan-600 bg-cyan-50 px-2 py-1.5 text-xs font-bold text-cyan-900 hover:bg-cyan-100 disabled:opacity-50" disabled={busy} onClick={() => setConfigurationOpen(false)} type="button">Listo · ocultar configuración</button>
            </div>
          ) : null}
          <aside className="min-w-0 bg-slate-100 p-2 lg:p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2"><button className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-slate-700 hover:border-cyan-500 hover:text-cyan-800 disabled:opacity-50" disabled={busy} onClick={() => setConfigurationOpen((current) => !current)} type="button">{configurationOpen ? "Ocultar configuración" : "Configurar"}</button><div className="min-w-0 truncate text-[11px] text-slate-600"><strong className="text-slate-900">{FAMILY_LABELS[selectedFamily]}</strong>{" · "}{productionOrder || "sin orden"}{" · "}{firmwareName || "sin firmware"}{" · "}<span className="font-mono font-bold">{progress}%</span></div></div>
              <div className={`rounded-full border px-2 py-1 font-mono text-[10px] font-bold ${connected ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-600"}`}>{connected ? "ESP conectado" : "ESP desconectado"}</div>
            </div>
            <div className="grid gap-2">
              <div className="rounded border border-slate-200 bg-white p-3"><div className="mb-1 text-xs font-semibold text-slate-800">Estación de programación ESP</div><div className="text-[11px] text-slate-500">Selecciona el firmware, conecta el puerto serie y ejecuta la programación de la unidad.</div><div className="mt-3 flex flex-wrap gap-1.5"><button className={`${buttonBase} border-slate-300 bg-white text-slate-700 hover:border-cyan-400 hover:text-cyan-800`} disabled={busy} onClick={connected ? disconnectESP : () => void connectESP()} type="button">{connected ? "Desconectar" : "Conectar ESP"}</button><button className={`${buttonBase} border-slate-300 bg-white text-slate-700 hover:border-slate-500 hover:text-slate-900`} disabled={!connected || busy} onClick={resetESP32} type="button">Reset</button><button className={`${buttonBase} border-amber-500 bg-amber-50 text-amber-900 hover:bg-amber-100`} disabled={!connected || busy} onClick={eraseFlash} type="button">Borrar flash</button><button className={`${buttonBase} border-cyan-500 bg-cyan-400 px-3 text-sm font-bold text-slate-950 shadow-sm hover:bg-cyan-300`} disabled={!connected || !firmware || busy} onClick={flashFirmware} type="button">{flashing ? "Programando..." : "Programar firmware"}</button></div></div>
              <div className="grid grid-cols-3 overflow-hidden rounded border border-slate-200 bg-white"><div className="border-r border-slate-200 px-2 py-2 text-center"><div className={`font-mono text-sm font-bold ${connected ? "text-emerald-600" : "text-slate-400"}`}>{connected ? "1" : "0"}</div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Conectado</div></div><div className="border-r border-slate-200 px-2 py-2 text-center"><div className="font-mono text-sm font-bold text-cyan-700">{uploadBaudRate >= 1_000_000 ? `${uploadBaudRate / 1_000_000}M` : `${uploadBaudRate / 1_000}k`}</div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Baud</div></div><div className="px-2 py-2 text-center"><div className="font-mono text-sm font-bold text-slate-700">{progress}%</div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Avance</div></div></div>
              <fieldset className="min-w-0 rounded border border-slate-200 bg-slate-50/70 p-2">
                <legend className="px-1 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Estaciones ESP disponibles</legend>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1.5"><button className="rounded border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 hover:border-cyan-400 hover:text-cyan-800 disabled:opacity-50" disabled={busy || assignedEspSlots.length === 0} onClick={() => setSelectedEspPortIds(assignedEspSlots.map((slot) => slot.id))} type="button">Seleccionar conectados</button><button className="rounded border border-transparent px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-200/70 hover:text-slate-800 disabled:opacity-50" disabled={busy || selectedEspSlotCount === 0} onClick={() => setSelectedEspPortIds([])} type="button">Limpiar selección</button></div>
                  <div className="text-[10px] font-bold text-slate-600">{assignedEspSlots.length}/{MAX_ESP_SLOTS} asignados · {selectedEspSlotCount} seleccionados</div>
                </div>
                <div className={`grid min-w-0 gap-2 sm:grid-cols-2 ${configurationOpen ? "lg:grid-cols-3 2xl:grid-cols-5" : "md:grid-cols-3 xl:grid-cols-5"}`}>
                  {espPortSlots.map((slot, slotIndex) => {
                    const isActive = connected && activeEspSlotIndex === slotIndex;
                    const status = slot ? espFlashStatuses[slot.id] : undefined;

                    if (!slot) {
                      return (
                        <div className="grid min-h-24 content-between gap-2 rounded-md border border-dashed border-slate-300 bg-slate-100/60 p-2.5" key={`empty-esp-slot-${slotIndex}`}>
                          <div className="flex items-center gap-2"><div className="grid size-6 shrink-0 place-items-center rounded-full border border-slate-300 bg-white font-mono text-[10px] font-bold text-slate-400">{slotIndex + 1}</div><div className="text-xs font-semibold text-slate-500">Estación vacía</div></div>
                          <button className="rounded border border-cyan-500 bg-white px-2 py-1.5 text-xs font-bold text-cyan-900 hover:bg-cyan-50 disabled:opacity-50" disabled={busy} onClick={() => void connectESP(slotIndex)} type="button">Conectar ESP</button>
                        </div>
                      );
                    }

                    return (
                      <div className={`relative grid min-h-28 min-w-0 content-between gap-2 rounded-md border p-2.5 text-xs shadow-sm ${status?.state === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : status?.state === "no_flash" ? "border-sky-200 bg-sky-50 text-sky-800" : status?.state === "programming" || status?.state === "waiting" ? "border-cyan-200 bg-cyan-50 text-cyan-800" : status?.state === "error" ? "border-red-200 bg-red-50 text-red-800" : isActive ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-700"}`} key={slot.id}>
                        <span className="absolute right-2 top-2 grid size-6 place-items-center rounded-full border border-current/15 bg-white/70 font-mono text-[10px] font-bold opacity-70">{slotIndex + 1}</span>
                        <label className="flex min-w-0 cursor-pointer items-start gap-2 pr-7"><input checked={selectedEspPortIds.includes(slot.id)} className="mt-0.5 shrink-0" disabled={busy} onChange={(event) => setSelectedEspPortIds((current) => event.target.checked ? [...current, slot.id] : current.filter((portId) => portId !== slot.id))} type="checkbox" /><span className="min-w-0"><span className="block truncate text-sm font-bold">ESP asignado</span><span className="mt-1 block truncate font-mono text-[10px] opacity-75">{slot.label}</span><span className={`mt-1 block text-[10px] font-bold ${status?.state === "programming" || status?.state === "waiting" ? "animate-pulse" : ""}`}>{status?.state === "success" ? "PROGRAMADO" : status?.state === "no_flash" ? "FLASH NO VERIFICADA" : status?.state === "error" ? "ERROR" : status?.state === "programming" ? "EN PROCESO..." : status?.state === "waiting" ? "EN ESPERA..." : isActive ? "ACTIVO" : "Disponible"}</span>{(status?.state === "error" || status?.state === "no_flash" || status?.state === "programming" || status?.state === "waiting") && status.message ? <span className="mt-1 block text-[10px] leading-tight" title={status.message}>{status.message}</span> : null}</span></label>
                        {status ? <div className="h-1.5 overflow-hidden rounded-full bg-white/80"><div className={`h-full rounded-full ${status.state === "error" ? "bg-red-500" : status.state === "success" ? "bg-emerald-500" : status.state === "no_flash" ? "bg-sky-500" : "bg-cyan-500"}`} style={{ width: `${status.progress}%` }} /></div> : null}
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5"><button className="rounded border border-current/20 bg-white/70 px-1.5 py-1 text-[10px] font-bold hover:bg-white disabled:opacity-50" disabled={busy || isActive} onClick={() => void selectEspPortSlot(slotIndex)} type="button">{isActive ? "Estación activa" : "Seleccionar"}</button><button className="rounded border border-current/20 bg-white/70 px-2 py-1 text-[10px] font-bold hover:bg-white disabled:opacity-50" disabled={busy} onClick={() => void removeEspPortSlot(slotIndex)} type="button">Quitar</button></div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white p-2">
                  <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-wide text-slate-500"><span><strong className="font-mono text-emerald-600">{successfulEspCount}</strong> OK</span><span><strong className="font-mono text-sky-600">{noFlashEspCount}</strong> Sin flash</span><span><strong className="font-mono text-red-600">{failedEspCount}</strong> Error</span></div>
                  <div className="flex flex-wrap gap-1.5"><button className={`${buttonBase} border-slate-300 bg-white px-3 text-slate-700 hover:border-slate-500 hover:text-slate-900`} disabled={busy || selectedEspSlotCount === 0} onClick={() => void resetSelectedESPs()} type="button">{flashing ? "Procesando lote..." : `Reset seleccionados · ${selectedEspSlotCount}`}</button><button className={`${buttonBase} border-amber-500 bg-amber-50 px-3 text-amber-900 hover:bg-amber-100`} disabled={busy || selectedEspSlotCount === 0} onClick={() => void eraseSelectedESPs()} type="button">{flashing ? "Procesando lote..." : `Borrar seleccionados · ${selectedEspSlotCount}`}</button><button className={`${buttonBase} border-cyan-500 bg-cyan-400 px-4 text-sm font-bold text-slate-950 shadow-sm hover:bg-cyan-300`} disabled={busy || !firmware || selectedEspSlotCount === 0} onClick={() => void flashSelectedESPs()} type="button">{flashing ? "Programando lote..." : `Programar seleccionados · ${selectedEspSlotCount}`}</button></div>
                </div>
              </fieldset>
            </div>
          </aside>
        </div>
        <div className="border-t border-slate-200 bg-slate-950 p-2"><div className="flex flex-wrap items-center justify-between gap-2"><div className="text-xs font-semibold text-slate-200">Consola esptool / ESP</div><div className="flex items-center gap-2"><button className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-100 transition hover:bg-slate-800 disabled:opacity-50" disabled={logs.length === 0} onClick={() => setLogs("")} type="button">Limpiar</button><button className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-100 transition hover:bg-slate-800" onClick={() => setShowConsole((current) => !current)} type="button">{showConsole ? "Ocultar consola" : "Mostrar consola"}</button></div></div>{showConsole ? <div className="mt-2 h-[36vh] min-h-[220px] overflow-y-auto rounded border border-slate-800 bg-slate-900 p-2 font-mono text-xs whitespace-pre-wrap text-slate-100" ref={logsContainerRef}>{logs || "Listo.\n"}</div> : null}</div>
      </section>
    </main>
  );
}
