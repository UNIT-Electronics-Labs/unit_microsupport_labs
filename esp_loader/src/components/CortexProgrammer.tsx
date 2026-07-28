import { useCallback, useEffect, useRef, useState } from "react";
import {
  CmsisDAP,
  CortexM,
  type Transport as DapTransport,
  WebUSB as DapWebUSB,
} from "dapjs";
import { flashPy32F0, PY32_DAP_WAIT_RETRY, PY32_DBGMCU_IDCODE_ADDRESS } from "../cortex/flash/py32f0";
import { flashStm32F1, STM32_DBGMCU_IDCODE_ADDRESS } from "../cortex/flash/stm32f1";
import { parseFirmwareImage } from "../cortex/firmware";
import { TARGETS, type TargetKey } from "../cortex/targets";
import {
  formatBytes,
  formatHex32,
  getDebugDeviceId,
  getDebugRevisionId,
  getErrorMessage,
} from "../cortex/utils";

const CORTEX_CPUID_ADDRESS = 0xe000ed00;
const DEFAULT_SWD_CLOCK_HZ = 1_000_000;
const MAX_PANEL_SLOTS = 10;
const probeInstanceIds = new WeakMap<object, number>();
let nextProbeInstanceId = 1;

type FamilyFilter = "all" | "stm32" | "py32" | "gd32";
type CmsisTransportKind = "auto" | "webhid" | "webusb";
type WebUsbDeviceInfo = {
  vendorId?: number;
  productId?: number;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  configurations?: Array<{
    interfaces: Array<{
      alternates: Array<{
        interfaceClass: number;
        interfaceName?: string;
      }>;
    }>;
  }>;
};
type AuthorizedCmsisProbe = {
  id: string;
  label: string;
  transport: Exclude<CmsisTransportKind, "auto">;
  device: unknown;
};
type BatchProbeStatus = {
  state: "waiting" | "programming" | "success" | "error";
  progress: number;
  message?: string;
};

const FAMILY_FILTERS = [
  { id: "all", label: "Todos" },
  { id: "stm32", label: "STM32" },
  { id: "py32", label: "PY32" },
  { id: "gd32", label: "GD32" },
] as const satisfies ReadonlyArray<{ id: FamilyFilter; label: string }>;

const SWD_CLOCK_OPTIONS = [
  { value: 100_000, label: "100 kHz · máxima estabilidad" },
  { value: 500_000, label: "500 kHz" },
  { value: 1_000_000, label: "1 MHz · recomendado" },
  { value: 2_000_000, label: "2 MHz" },
  { value: 4_000_000, label: "4 MHz" },
  { value: 8_000_000, label: "8 MHz" },
  { value: 10_000_000, label: "10 MHz · máxima velocidad" },
] as const;

type WebHidInputReportEvent = Event & {
  data: DataView;
};

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
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
};

type FileSystemFileHandleLike = {
  getFile(): Promise<File>;
  queryPermission?: (descriptor?: { mode?: "read" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" }) => Promise<PermissionState>;
};

function formatUsbId(value?: number): string {
  return value === undefined ? "????" : value.toString(16).padStart(4, "0");
}

function formatSwdClock(clockHz: number): string {
  return clockHz >= 1_000_000
    ? `${clockHz / 1_000_000} MHz`
    : `${clockHz / 1_000} kHz`;
}

function getCortexProbeErrorMessage(
  error: unknown,
  swdClockHz: number
): string {
  const message = getErrorMessage(error);

  if (message.includes("Transfer count mismatch")) {
    return (
      "El target no completó la transferencia SWD. Revisa Vref/3.3 V, " +
      "GND común, SWDIO, SWCLK y NRST; usa cables cortos. La prueba está " +
      `configurada a ${formatSwdClock(swdClockHz)}.`
    );
  }

  return message;
}

const KNOWN_CMSIS_DAP_IDS: Array<{ vendorId: number; productId?: number }> = [
  { vendorId: 0x2e8a, productId: 0x000c },
  { vendorId: 0x0d28, productId: 0x0204 },
  { vendorId: 0x0d28, productId: 0x0203 },
  { vendorId: 0x0d28, productId: 0x0205 },
  { vendorId: 0x1209, productId: 0x3443 },
  { vendorId: 0x1209, productId: 0x3444 },
];

const PREFER_WEBUSB_DUAL_MODE_IDS = [
  { vendorId: 0x0d28, productId: 0x0203 },
  { vendorId: 0x0d28, productId: 0x0204 },
  { vendorId: 0x0d28, productId: 0x0205 },
] as const;

function prefersWebUsbDualMode(device: WebUsbDeviceInfo): boolean {
  return PREFER_WEBUSB_DUAL_MODE_IDS.some(
    ({ vendorId, productId }) =>
      device.vendorId === vendorId && device.productId === productId
  );
}

function looksLikeCmsisDapDevice(device: {
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  vendorId?: number;
  productId?: number;
}): boolean {
  const text = [
    device.productName,
    device.manufacturerName,
    device.serialNumber,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const hasKnownCmsisDapId = KNOWN_CMSIS_DAP_IDS.some(
    ({ vendorId, productId }) =>
      device.vendorId === vendorId &&
      (productId === undefined || device.productId === productId)
  );

  const hasKnownUnitElectronicsProbe =
    device.vendorId === 0x2e8a &&
    (device.productId === 0x000c || text.includes("unit electronics") || text.includes("ue pico"));

  const looksLikeGenericHidPeripheral =
    text.includes("keyboard") ||
    text.includes("mouse") ||
    text.includes("bluetooth") ||
    text.includes("wifi") ||
    text.includes("gaming") ||
    text.includes("gamepad") ||
    text.includes("headset") ||
    text.includes("audio") ||
    text.includes("speaker") ||
    text.includes("microphone") ||
    text.includes("controller") ||
    text.includes("touchpad");

  return (
    hasKnownCmsisDapId ||
    hasKnownUnitElectronicsProbe ||
    (!looksLikeGenericHidPeripheral &&
      (text.includes("cmsis") ||
        text.includes("dap") ||
        text.includes("daplink") ||
        text.includes("mbed") ||
        text.includes("arm mbed") ||
        text.includes("qinheng") ||
        text.includes("wch") ||
        text.includes("unit") ||
        text.includes("ue pico") ||
        text.includes("pico debugger") ||
        text.includes("ch552")))
  );
}

function getCmsisDapDevices(devices: unknown[]): WebUsbDeviceInfo[] {
  return devices
    .map((device) => device as WebUsbDeviceInfo)
    .filter((device) => looksLikeCmsisDapDevice(device));
}

function hasCmsisDapV2Interface(device: WebUsbDeviceInfo): boolean {
  return (
    device.configurations?.some((configuration) =>
      configuration.interfaces.some((usbInterface) =>
        usbInterface.alternates.some((alternate) => {
          const interfaceName = alternate.interfaceName?.toLowerCase() ?? "";
          return (
            alternate.interfaceClass === 0xff &&
            (interfaceName.includes("cmsis-dap v2") ||
              interfaceName.includes("cmsis dap v2"))
          );
        })
      )
    ) ?? false
  );
}

function getWebUsbCmsisDapDevices(devices: unknown[]): WebUsbDeviceInfo[] {
  return getCmsisDapDevices(devices).filter((device) => {
    const hasKnownV2Id = KNOWN_CMSIS_DAP_IDS.some(
      ({ vendorId, productId }) =>
        device.vendorId === vendorId &&
        (productId === undefined || device.productId === productId)
    );
    return hasKnownV2Id || hasCmsisDapV2Interface(device);
  });
}

function isSamePhysicalProbe(
  first: WebUsbDeviceInfo,
  second: WebUsbDeviceInfo
): boolean {
  if (
    first.vendorId !== second.vendorId ||
    first.productId !== second.productId
  ) {
    return false;
  }

  if (first.serialNumber && second.serialNumber) {
    return first.serialNumber === second.serialNumber;
  }

  // VID/PID alone cannot distinguish multiple identical probes in a fixture.
  return first === second;
}

function createAuthorizedProbe(
  device: WebUsbDeviceInfo,
  transport: AuthorizedCmsisProbe["transport"],
  index: number
): AuthorizedCmsisProbe {
  const versionLabel =
    transport === "webusb" ? "v2 / WebUSB" : "v1 / WebHID";
  const serialLabel = device.serialNumber
    ? ` · S/N ${device.serialNumber}`
    : "";
  let instanceId = index;

  if (typeof device === "object" && device !== null) {
    const rememberedInstanceId = probeInstanceIds.get(device);
    if (rememberedInstanceId !== undefined) {
      instanceId = rememberedInstanceId;
    } else {
      instanceId = nextProbeInstanceId;
      nextProbeInstanceId += 1;
      probeInstanceIds.set(device, instanceId);
    }
  }

  return {
    id:
      `${transport}:${formatUsbId(device.vendorId)}:${formatUsbId(device.productId)}:` +
      `${device.serialNumber ?? "no-serial"}:${instanceId}`,
    label:
      `${device.productName ?? "CMSIS-DAP"} ` +
      `(${formatUsbId(device.vendorId)}:${formatUsbId(device.productId)}) · ${versionLabel}${serialLabel}`,
    transport,
    device,
  };
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

class FlexibleWebUsbTransport implements DapTransport {
  public readonly packetSize = 64;

  private device: ConstructorParameters<typeof DapWebUSB>[0];
  private activeTransport: DapTransport | null = null;
  private log: ((message: string) => void) | undefined;

  constructor(device: ConstructorParameters<typeof DapWebUSB>[0], log?: (message: string) => void) {
    this.device = device;
    this.log = log;
  }

  async open(): Promise<void> {
    if (this.activeTransport) {
      await this.activeTransport.open();
      return;
    }

    const candidates = [
      { label: "vendor-specific", interfaceClass: 0xff, configuration: 1 },
      { label: "cdc", interfaceClass: 0x03, configuration: 1 },
      { label: "cdc-data", interfaceClass: 0x0a, configuration: 1 },
      { label: "default", interfaceClass: 0x00, configuration: 1 },
    ];

    const failures: string[] = [];

    for (const candidate of candidates) {
      const transport = new DapWebUSB(
        this.device,
        candidate.interfaceClass,
        candidate.configuration
      );

      try {
        await transport.open();
        this.activeTransport = transport;
        this.log?.(
          `WebUSB interface selected: ${candidate.label} (class 0x${candidate.interfaceClass.toString(16).padStart(2, "0")})\n`
        );
        return;
      } catch (err: unknown) {
        failures.push(
          `${candidate.label}: ${getErrorMessage(err)}`
        );
      }
    }

    throw new Error(`Unable to open WebUSB CMSIS-DAP device. Attempts: ${failures.join(" | ")}`);
  }

  async close(): Promise<void> {
    if (this.activeTransport) {
      await this.activeTransport.close();
    }
  }

  async read(): Promise<DataView> {
    if (!this.activeTransport) {
      throw new Error("Transport not opened");
    }

    const response = await this.activeTransport.read();
    if (response.byteLength < 2) {
      throw new Error(
        `CMSIS-DAP v2 returned a short response (${response.byteLength} byte(s)). Disconnect its duplicate WebHID v1 channel and retry.`
      );
    }

    return response;
  }

  async write(data: BufferSource): Promise<void> {
    if (!this.activeTransport) {
      throw new Error("Transport not opened");
    }

    return this.activeTransport.write(data);
  }
}

function createCortexTarget(
  transport: DapTransport,
  swdClockHz: number
): {
  dap: CmsisDAP;
  target: CortexM;
} {
  const dap = new CmsisDAP(
    transport,
    undefined,
    swdClockHz
  );
  return {
    dap,
    target: new CortexM(dap),
  };
}

export default function CortexProgrammer() {
  const [selectedTarget, setSelectedTarget] = useState<TargetKey>("stm32f103rc");
  const [familyFilter, setFamilyFilter] = useState<FamilyFilter>("all");
  const [targetSearch, setTargetSearch] = useState("");
  const [swdClockHz, setSwdClockHz] = useState(DEFAULT_SWD_CLOCK_HZ);
  const [configurationOpen, setConfigurationOpen] = useState(true);
  const [cmsisTransport, setCmsisTransport] =
    useState<CmsisTransportKind>("auto");
  const [detectedProbe, setDetectedProbe] = useState("");
  const [authorizedProbeCount, setAuthorizedProbeCount] = useState(0);
  const [authorizedProbes, setAuthorizedProbes] = useState<
    AuthorizedCmsisProbe[]
  >([]);
  const [selectedProbeId, setSelectedProbeId] = useState("");
  const [batchProbeIds, setBatchProbeIds] = useState<string[]>([]);
  const [panelSlotProbeIds, setPanelSlotProbeIds] = useState<
    Array<string | null>
  >(() => Array.from({ length: MAX_PANEL_SLOTS }, () => null));
  const [batchStatuses, setBatchStatuses] = useState<
    Record<string, BatchProbeStatus>
  >({});
  const [logs, setLogs] = useState("");
  const [connectingTarget, setConnectingTarget] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [firmware, setFirmware] = useState<File | null>(null);
  const [firmwareBytes, setFirmwareBytes] = useState<Uint8Array | null>(null);
  const [firmwareHandle, setFirmwareHandle] =
    useState<FileSystemFileHandleLike | null>(null);
  const [firmwareName, setFirmwareName] = useState("");
  const [batchName, setBatchName] = useState("");
  const [progress, setProgress] = useState(0);
  const [showConsole, setShowConsole] = useState(false);
  const [scanningProbes, setScanningProbes] = useState(false);
  const [authorizingProbe, setAuthorizingProbe] = useState<
    AuthorizedCmsisProbe["transport"] | null
  >(null);
  const [authorizingSlot, setAuthorizingSlot] = useState<number | null>(null);
  const logsContainerRef = useRef<HTMLDivElement | null>(null);

  function addLog(text: string) {
    setLogs((prev) => prev + text);
  }

  function rememberSelectedProbe(
    device: WebUsbDeviceInfo,
    transport: AuthorizedCmsisProbe["transport"]
  ): AuthorizedCmsisProbe {
    const existingProbe =
      authorizedProbes.find((probe) => {
        const existingDevice = probe.device as WebUsbDeviceInfo;
        const sameSerial =
          device.serialNumber !== undefined &&
          existingDevice.serialNumber === device.serialNumber;
        const sameUnserializedDevice =
          device.serialNumber === undefined &&
          existingDevice.serialNumber === undefined &&
          existingDevice.productName === device.productName;

        return (
          probe.device === device ||
          (probe.transport === transport &&
            isSamePhysicalProbe(existingDevice, device) &&
            (sameSerial || sameUnserializedDevice))
        );
      }) ?? null;
    const probe =
      existingProbe ??
      createAuthorizedProbe(device, transport, authorizedProbes.length);

    if (!existingProbe) {
      setAuthorizedProbes((current) => [...current, probe]);
      setAuthorizedProbeCount((current) => current + 1);
    }
    setSelectedProbeId(probe.id);
    setDetectedProbe(probe.label);
    return probe;
  }

  const scanAuthorizedProbes = useCallback(async (reason?: string) => {
    const usb = (
      navigator as Navigator & {
        usb?: {
          getDevices?: () => Promise<unknown[]>;
        };
      }
    ).usb;
    const hid = (navigator as Navigator & { hid?: WebHidApi }).hid;

    if (!usb?.getDevices && !hid?.getDevices) return [];

    setScanningProbes(true);
    try {
      const [usbDevices, hidDevices] = await Promise.all([
        usb?.getDevices?.() ?? Promise.resolve([]),
        hid?.getDevices?.() ?? Promise.resolve([]),
      ]);
      const webUsbProbes = getWebUsbCmsisDapDevices(usbDevices);
      const webHidProbes = getCmsisDapDevices(hidDevices).filter(
        (hidDevice) =>
          !webUsbProbes.some((usbDevice) =>
            isSamePhysicalProbe(usbDevice, hidDevice) ||
            (prefersWebUsbDualMode(hidDevice) &&
              usbDevice.vendorId === hidDevice.vendorId &&
              usbDevice.productId === hidDevice.productId)
          )
      );
      const rememberedProbes = [
        ...webUsbProbes.map((device, index) =>
          createAuthorizedProbe(device, "webusb", index)
        ),
        ...webHidProbes.map((device, index) =>
          createAuthorizedProbe(device, "webhid", index)
        ),
      ];

      setAuthorizedProbes(rememberedProbes);
      setAuthorizedProbeCount(rememberedProbes.length);
      setPanelSlotProbeIds((current) => {
        const availableIds = new Set(
          rememberedProbes.map((probe) => probe.id)
        );
        const nextSlots = current.map((probeId) =>
          probeId && availableIds.has(probeId) ? probeId : null
        );
        const assignedIds = new Set(
          nextSlots.filter((probeId): probeId is string => probeId !== null)
        );

        for (const probe of rememberedProbes) {
          if (assignedIds.has(probe.id)) continue;
          const emptySlot = nextSlots.indexOf(null);
          if (emptySlot === -1) break;
          nextSlots[emptySlot] = probe.id;
          assignedIds.add(probe.id);
        }

        return nextSlots;
      });
      setBatchProbeIds((current) =>
        current.filter((probeId) =>
          rememberedProbes.some((probe) => probe.id === probeId)
        )
      );
      setBatchStatuses((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([probeId]) =>
            rememberedProbes.some((probe) => probe.id === probeId)
          )
        )
      );
      setSelectedProbeId((current) =>
        rememberedProbes.some((probe) => probe.id === current)
          ? current
          : rememberedProbes.length === 1
            ? rememberedProbes[0].id
            : ""
      );
      setDetectedProbe((current) =>
        rememberedProbes.some((probe) => probe.label === current)
          ? current
          : rememberedProbes.length === 1
            ? rememberedProbes[0].label
            : ""
      );

      if (reason) {
        setLogs(
          (previous) =>
            previous +
            `${reason}: ${rememberedProbes.length} programador(es) CMSIS-DAP conectado(s).\n`
        );
      }

      return rememberedProbes;
    } catch (err: unknown) {
      setLogs(
        (previous) =>
          previous +
          `No se pudieron reescanear los programadores: ${getErrorMessage(err)}\n`
      );
      return [];
    } finally {
      setScanningProbes(false);
    }
  }, []);

  useEffect(() => {
    const usb = (
      navigator as Navigator & {
        usb?: {
          addEventListener?: (type: string, listener: EventListener) => void;
          removeEventListener?: (type: string, listener: EventListener) => void;
        };
      }
    ).usb;
    const hid = (navigator as Navigator & { hid?: WebHidApi }).hid;
    const handleDeviceChange: EventListener = () => {
      void scanAuthorizedProbes("Cambio de conexión detectado");
    };

    void scanAuthorizedProbes();
    usb?.addEventListener?.("connect", handleDeviceChange);
    usb?.addEventListener?.("disconnect", handleDeviceChange);
    hid?.addEventListener?.("connect", handleDeviceChange);
    hid?.addEventListener?.("disconnect", handleDeviceChange);

    return () => {
      usb?.removeEventListener?.("connect", handleDeviceChange);
      usb?.removeEventListener?.("disconnect", handleDeviceChange);
      hid?.removeEventListener?.("connect", handleDeviceChange);
      hid?.removeEventListener?.("disconnect", handleDeviceChange);
    };
  }, [scanAuthorizedProbes]);

  const targetEntries = Object.entries(TARGETS) as Array<
    [TargetKey, (typeof TARGETS)[TargetKey]]
  >;
  const normalizedTargetSearch = targetSearch.trim().toLowerCase();
  const filteredTargetEntries = targetEntries.filter(([key, target]) => {
    const matchesFamily =
      familyFilter === "all" || target.family === familyFilter;
    const searchableText =
      `${key} ${target.label} ${target.description}`.toLowerCase();
    return (
      matchesFamily && searchableText.includes(normalizedTargetSearch)
    );
  });
  const selectedTargetAvailable = filteredTargetEntries.some(
    ([key]) => key === selectedTarget
  );

  function selectFamily(nextFamily: FamilyFilter) {
    setFamilyFilter(nextFamily);

    const firstMatchingTarget = targetEntries.find(
      ([, target]) =>
        nextFamily === "all" || target.family === nextFamily
    );
    if (
      firstMatchingTarget &&
      nextFamily !== "all" &&
      TARGETS[selectedTarget].family !== nextFamily
    ) {
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
          getDevices?: () => Promise<unknown[]>;
          requestDevice(options?: unknown): Promise<unknown>;
        };
      }
    ).usb;
  }

  function getHidApi() {
    return (navigator as Navigator & { hid?: WebHidApi }).hid;
  }

  async function authorizeCmsisDapProbe(
    transportKind: AuthorizedCmsisProbe["transport"],
    slotIndex?: number
  ) {
    if (!window.isSecureContext) {
      addLog(
        "La autorización CMSIS-DAP requiere HTTPS o localhost. Abre la aplicación desde su URL HTTPS.\n"
      );
      return;
    }

    setAuthorizingProbe(transportKind);
    setAuthorizingSlot(slotIndex ?? null);
    try {
      let selectedDevice: WebUsbDeviceInfo | null = null;

      if (transportKind === "webusb") {
        const usb = getUsbApi();
        if (!usb) {
          throw new Error(
            "WebUSB no está disponible. Usa Chrome o Edge de escritorio y abre la página directamente."
          );
        }

        addLog(
          "Abriendo selector WebUSB. Elige un CMSIS-DAP v2 conectado.\n"
        );
        selectedDevice = (await usb.requestDevice({
          filters: KNOWN_CMSIS_DAP_IDS,
        })) as WebUsbDeviceInfo;
      } else {
        const hid = getHidApi();
        if (!hid) {
          throw new Error(
            "WebHID no está disponible. Usa Chrome o Edge de escritorio y abre la página directamente."
          );
        }

        addLog(
          "Abriendo selector WebHID. Elige un CMSIS-DAP v1 conectado.\n"
        );
        const devices = await hid.requestDevice({ filters: [] });
        selectedDevice =
          devices.find((device) => looksLikeCmsisDapDevice(device)) ?? null;

        if (!selectedDevice) {
          throw new Error(
            "El dispositivo HID seleccionado no se identificó como CMSIS-DAP."
          );
        }

        if (prefersWebUsbDualMode(selectedDevice)) {
          throw new Error(
            `${selectedDevice.productName ?? "Este CMSIS-DAP"} expone v1 y v2 en el mismo dispositivo. Asígnalo con el botón v2 / USB para evitar usar ambas interfaces simultáneamente.`
          );
        }
      }

      const probes = await scanAuthorizedProbes(
        `Autorización ${transportKind === "webusb" ? "WebUSB v2" : "WebHID v1"} actualizada`
      );
      const selectedProbe =
        probes.find((probe) => probe.device === selectedDevice) ??
        probes.find(
          (probe) =>
            probe.transport === transportKind &&
            isSamePhysicalProbe(
              probe.device as WebUsbDeviceInfo,
              selectedDevice
            )
        ) ??
        null;

      if (selectedProbe) {
        setSelectedProbeId(selectedProbe.id);
        setDetectedProbe(selectedProbe.label);
        setCmsisTransport("auto");
        if (slotIndex !== undefined) {
          setPanelSlotProbeIds((current) =>
            current.map((probeId, index) => {
              if (index === slotIndex) return selectedProbe.id;
              return probeId === selectedProbe.id ? null : probeId;
            })
          );
          setBatchProbeIds((current) =>
            current.includes(selectedProbe.id)
              ? current
              : [...current, selectedProbe.id]
          );
        }
        addLog(`CMSIS-DAP autorizado: ${selectedProbe.label}\n`);
      }
    } catch (err: unknown) {
      addLog(
        `No se pudo autorizar ${transportKind === "webusb" ? "WebUSB v2" : "WebHID v1"}: ${getErrorMessage(err)}\n`
      );
    } finally {
      setAuthorizingProbe(null);
      setAuthorizingSlot(null);
    }
  }

  async function resolveConnectedProbe(
    probe: AuthorizedCmsisProbe
  ): Promise<AuthorizedCmsisProbe> {
    const rememberedDevice = probe.device as WebUsbDeviceInfo;

    if (probe.transport === "webusb") {
      const usb = getUsbApi();
      const connectedDevices = getWebUsbCmsisDapDevices(
        (await usb?.getDevices?.()) ?? []
      );
      const connectedDevice =
        connectedDevices.find(
          (device) =>
            rememberedDevice.serialNumber !== undefined &&
            device.serialNumber === rememberedDevice.serialNumber &&
            isSamePhysicalProbe(device, rememberedDevice)
        ) ??
        connectedDevices.find((device) =>
          isSamePhysicalProbe(device, rememberedDevice)
        ) ??
        null;

      if (!connectedDevice) {
        throw new Error(
          `${probe.label}: programador WebUSB desconectado o sin autorización`
        );
      }

      return {
        ...probe,
        device: connectedDevice,
      };
    }

    const hid = getHidApi();
    const connectedDevices = (await hid?.getDevices?.()) ?? [];
    const connectedDevice =
      connectedDevices.find((device) => device === probe.device) ??
      connectedDevices.find(
        (device) =>
          device.vendorId === rememberedDevice.vendorId &&
          device.productId === rememberedDevice.productId &&
          looksLikeCmsisDapDevice(device)
      ) ?? null;

    if (!connectedDevice) {
      throw new Error(
        `${probe.label}: programador WebHID desconectado o sin autorización`
      );
    }

    return {
      ...probe,
      device: connectedDevice,
    };
  }

  async function requestCmsisDapTransport(): Promise<DapTransport | null> {
    const usb = getUsbApi();
    const hid = getHidApi();
    let selectedAuthorizedProbe =
      authorizedProbes.find((probe) => probe.id === selectedProbeId) ?? null;
    let activeTransport = cmsisTransport;

    if (!usb && !hid) {
      alert("WebUSB/WebHID APIs are not supported");
      return null;
    }

    if (selectedAuthorizedProbe) {
      try {
        selectedAuthorizedProbe = await resolveConnectedProbe(
          selectedAuthorizedProbe
        );
      } catch (err: unknown) {
        addLog(`${getErrorMessage(err)}\n`);
        selectedAuthorizedProbe = null;
      }
    }

    if (activeTransport === "auto") {
      if (selectedAuthorizedProbe) {
        activeTransport = selectedAuthorizedProbe.transport;
        addLog(
          `Selected CMSIS-DAP probe: ${selectedAuthorizedProbe.label}.\n`
        );
      }

      const [usbDevices, hidDevices] = await Promise.all([
        usb?.getDevices?.() ?? Promise.resolve([]),
        hid?.getDevices?.() ?? Promise.resolve([]),
      ]);
      const authorizedUsbDevices = getWebUsbCmsisDapDevices(usbDevices);
      const authorizedHidDevices = hidDevices.filter(
        (device) =>
          looksLikeCmsisDapDevice(device) &&
          !authorizedUsbDevices.some((usbDevice) =>
            isSamePhysicalProbe(usbDevice, device) ||
            (prefersWebUsbDualMode(device) &&
              usbDevice.vendorId === device.vendorId &&
              usbDevice.productId === device.productId)
          )
      );

      if (selectedAuthorizedProbe) {
        // The selected probe already determines the transport.
      } else if (
        authorizedHidDevices.length > 0 &&
        authorizedUsbDevices.length === 0
      ) {
        activeTransport = "webhid";
      } else if (
        authorizedUsbDevices.length > 0 &&
        authorizedHidDevices.length === 0
      ) {
        activeTransport = "webusb";
      } else if (!usb && hid) {
        activeTransport = "webhid";
      } else {
        activeTransport = "webusb";
      }

      addLog(
        `Automatic CMSIS-DAP transport: ${activeTransport === "webusb" ? "WebUSB v2" : "WebHID v1"}.\n`
      );
    }

    if (activeTransport === "webhid") {
      if (!hid) {
        addLog("WebHID is not supported by this browser.\n");
        return null;
      }

      try {
        const rememberedDevices = (await hid.getDevices?.()) ?? [];
        const rememberedDevice =
          selectedAuthorizedProbe?.transport === "webhid"
            ? (selectedAuthorizedProbe.device as WebHidDevice)
            : rememberedDevices.find(
                  (device) =>
                    device.vendorId === 0x1a86 &&
                    device.productId === 0x8011
                ) ??
              rememberedDevices.find(
                (device) =>
                  looksLikeCmsisDapDevice(device) &&
                  !prefersWebUsbDualMode(device)
              ) ??
              null;

        if (rememberedDevice) {
          const probe =
            selectedAuthorizedProbe?.transport === "webhid"
              ? selectedAuthorizedProbe
              : rememberSelectedProbe(rememberedDevice, "webhid");
          setSelectedProbeId(probe.id);
          setDetectedProbe(probe.label);
          addLog(
            `CMSIS-DAP detectado automáticamente: ${probe.label}\n`
          );
          return new WebHidCmsisDapTransport(rememberedDevice);
        }

        addLog("Using WebHID. Select the CMSIS-DAP probe.\n");
        const devices = await hid.requestDevice({
          // An empty filter is intentional. Some CMSIS-DAP firmware exposes
          // incomplete HID descriptors and disappears with VID/PID filters.
          filters: [],
        });
        const device =
          devices.find(
            (currentDevice) =>
              looksLikeCmsisDapDevice(currentDevice) &&
              !prefersWebUsbDualMode(currentDevice)
          ) ?? null;

        if (device) {
          const probe = rememberSelectedProbe(device, "webhid");
          addLog(
            `CMSIS-DAP HID seleccionado: ${probe.label}\n`
          );

          return new WebHidCmsisDapTransport(device);
        }

        addLog("No WebHID device was selected.\n");
      } catch (err: unknown) {
        addLog(
          `WebHID selection cancelled or unavailable: ${getErrorMessage(err)}\n`
        );
      }

      return null;
    }

    if (activeTransport === "webusb") {
      if (!usb) {
        addLog("WebUSB is not supported by this browser.\n");
        return null;
      }

      try {
        const rememberedDevices = getWebUsbCmsisDapDevices(
          (await usb.getDevices?.()) ?? []
        );
        const rememberedDevice =
          selectedAuthorizedProbe?.transport === "webusb"
            ? selectedAuthorizedProbe.device
            : rememberedDevices.length === 1
              ? rememberedDevices[0]
              : null;

        let device: unknown = rememberedDevice;
        if (device) {
          addLog("Using an authorized WebUSB CMSIS-DAP probe.\n");
        } else {
          addLog(
            rememberedDevices.length > 1
              ? `${rememberedDevices.length} authorized WebUSB probes found. Select one in the browser dialog.\n`
              : "Using WebUSB. Select the CMSIS-DAP v2 probe in the browser dialog.\n"
          );
          device = await usb.requestDevice({
            filters: KNOWN_CMSIS_DAP_IDS,
          });
        }

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
          addLog(
            `Selected device is not clearly identified as CMSIS-DAP (${formatUsbId(usbDevice.vendorId)}:${formatUsbId(usbDevice.productId)}). Choose another device.\n`
          );
          return null;
        }

        rememberSelectedProbe(usbDevice, "webusb");

        return new FlexibleWebUsbTransport(
          device as ConstructorParameters<typeof DapWebUSB>[0],
          addLog
        );
      } catch (err: unknown) {
        addLog(
          `WebUSB selection cancelled or unavailable: ${getErrorMessage(err)}\n`
        );
      }
    }

    return null;
  }

  async function connectCortexTarget() {
    if (connectingTarget || flashing) {
      addLog("A Cortex operation is already in progress; wait for it to finish.\n");
      return;
    }

    setConnectingTarget(true);
    addLog(
      `\nConnecting to Cortex target over SWD at ${formatSwdClock(swdClockHz)}...\n`
    );

    let transport: DapTransport | null = null;
    let target: CortexM | null = null;

    try {
      transport = await requestCmsisDapTransport();
      if (!transport) return;

      const session = createCortexTarget(transport, swdClockHz);
      target = session.target;
      await target.connect();
      const targetConfig = TARGETS[selectedTarget];
      if (targetConfig.algorithm === "py32f0") {
        await session.dap.configureTransfer(0, PY32_DAP_WAIT_RETRY, 0);
      }
      addLog("SWD connected\n");

      await target.halt();
      addLog("Core halted\n");

      const cpuid = await target.readMem32(CORTEX_CPUID_ADDRESS);
      addLog(`CPUID: ${formatHex32(cpuid)}\n`);

      try {
        const debugId = await target.readMem32(STM32_DBGMCU_IDCODE_ADDRESS);
        addLog(
          `DBGMCU_IDCODE: ${formatHex32(debugId)} ` +
            `(dev ${formatHex32(getDebugDeviceId(debugId))}, ` +
            `rev 0x${getDebugRevisionId(debugId).toString(16).padStart(4, "0")})\n`
        );
      } catch {
        addLog("DBGMCU_IDCODE: unavailable\n");
      }

      if (targetConfig.algorithm === "py32f0") {
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
      addLog(
        `Cortex target error: ${getCortexProbeErrorMessage(err, swdClockHz)}\n`
      );
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

  async function testSelectedCortexTargets() {
    if (connectingTarget || flashing) {
      addLog("A Cortex operation is already in progress; wait for it to finish.\n");
      return;
    }

    const selectedProbes = authorizedProbes.filter((probe) =>
      batchProbeIds.includes(probe.id)
    );
    if (selectedProbes.length === 0) {
      alert("Selecciona al menos un programador para probar");
      return;
    }

    const targetConfig = TARGETS[selectedTarget];
    const initialStatuses = Object.fromEntries(
      selectedProbes.map((probe) => [
        probe.id,
        {
          state: "waiting",
          progress: 0,
          message: "Esperando prueba",
        } satisfies BatchProbeStatus,
      ])
    );

    const updateProbeStatus = (
      probeId: string,
      update: Partial<BatchProbeStatus>
    ) => {
      setBatchStatuses((current) => ({
        ...current,
        [probeId]: {
          ...(current[probeId] ?? { state: "waiting", progress: 0 }),
          ...update,
        },
      }));
    };

    setConnectingTarget(true);
    setProgress(0);
    setBatchStatuses(initialStatuses);
    addLog(
      `\n=== Prueba de panel: ${selectedProbes.length} canal(es), target ${targetConfig.label}, SWD ${formatSwdClock(swdClockHz)} ===\n`
    );

    const results = await Promise.allSettled(
      selectedProbes.map(async (probe) => {
        const channelLog = (message: string) =>
          addLog(`[${probe.label}] ${message}`);
        let transport: DapTransport | null = null;
        let target: CortexM | null = null;

        updateProbeStatus(probe.id, {
          state: "programming",
          progress: 10,
          message: "Conectando SWD",
        });

        try {
          const connectedProbe = await resolveConnectedProbe(probe);
          transport =
            connectedProbe.transport === "webhid"
              ? new WebHidCmsisDapTransport(
                  connectedProbe.device as WebHidDevice
                )
              : new FlexibleWebUsbTransport(
                  connectedProbe.device as ConstructorParameters<
                    typeof DapWebUSB
                  >[0],
                  channelLog
                );

          const session = createCortexTarget(transport, swdClockHz);
          target = session.target;
          await target.connect();
          if (targetConfig.algorithm === "py32f0") {
            await session.dap.configureTransfer(0, PY32_DAP_WAIT_RETRY, 0);
          }

          updateProbeStatus(probe.id, {
            progress: 60,
            message: "Leyendo target",
          });
          await target.halt();
          const cpuid = await target.readMem32(CORTEX_CPUID_ADDRESS);
          channelLog(`SWD OK · CPUID ${formatHex32(cpuid)}\n`);
          await target.resume(false);

          updateProbeStatus(probe.id, {
            state: "success",
            progress: 100,
            message: `SWD OK · CPUID ${formatHex32(cpuid)}`,
          });
          return probe;
        } catch (err: unknown) {
          const message = getCortexProbeErrorMessage(err, swdClockHz);
          updateProbeStatus(probe.id, {
            state: "error",
            progress: 100,
            message,
          });
          channelLog(`FALLO DE PRUEBA: ${message}\n`);
          throw new Error(`${probe.label}: ${message}`, { cause: err });
        } finally {
          try {
            await target?.disconnect();
          } catch {
            try {
              await transport?.close();
            } catch {
              // This channel is already closed or unavailable.
            }
          }
        }
      })
    );

    const successful = results.filter(
      (result) => result.status === "fulfilled"
    ).length;
    const failed = results.length - successful;
    setProgress(100);
    addLog(
      `=== Prueba terminada: ${successful} correctos, ${failed} fallidos, ${results.length} total ===\n`
    );
    setConnectingTarget(false);
  }

  async function flashCortexFirmware() {
    if (connectingTarget || flashing) {
      addLog("A Cortex operation is already in progress; wait for it to finish.\n");
      return;
    }

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
    addLog(
      `\nFlashing Cortex firmware: ${selectedFirmware.name} · SWD ${formatSwdClock(swdClockHz)}\n`
    );

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

      const session = createCortexTarget(transport, swdClockHz);
      target = session.target;
      await target.connect();
      if (targetConfig.algorithm === "py32f0") {
        await session.dap.configureTransfer(0, PY32_DAP_WAIT_RETRY, 0);
        addLog("DAP wait retry extended for PY32 flash\n");
      }
      addLog("SWD connected\n");

      await target.halt();
      addLog("Core halted\n");

      addLog(
        `Target: ${targetConfig.label}, image ${firmwareImage.format.toUpperCase()} ` +
          `${formatBytes(firmwareBytes.length)} at ${formatHex32(firmwareImage.address)}\n`
      );

      const callbacks = { addLog, setProgress };

      if (targetConfig.algorithm === "py32f0") {
        await flashPy32F0(target, firmwareImage, targetConfig, callbacks);
      } else {
        await flashStm32F1(target, firmwareImage, targetConfig, callbacks);
      }

      setProgress(100);
      addLog("Cortex firmware flashed and verified\n");

      await target.softReset();
      addLog("Target reset\n");
    } catch (err: unknown) {
      console.error(err);
      addLog(
        `Flash Cortex error: ${getCortexProbeErrorMessage(err, swdClockHz)}\n`
      );
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

  async function flashCortexFirmwareBatch() {
    if (connectingTarget || flashing) {
      addLog("A Cortex operation is already in progress; wait for it to finish.\n");
      return;
    }

    const selectedProbes = authorizedProbes.filter((probe) =>
      batchProbeIds.includes(probe.id)
    );
    if (selectedProbes.length === 0) {
      alert("Selecciona al menos un programador para el lote");
      return;
    }

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

    const targetConfig = TARGETS[selectedTarget];
    let firmwareImage: ReturnType<typeof parseFirmwareImage>;

    try {
      firmwareImage = parseFirmwareImage(
        selectedFirmware.bytes,
        selectedFirmware.name,
        targetConfig
      );
      const flashOffset = firmwareImage.address - targetConfig.flashBase;
      if (
        flashOffset < 0 ||
        flashOffset + firmwareImage.data.length > targetConfig.flashSizeBytes
      ) {
        throw new Error(
          `Firmware image at ${formatHex32(firmwareImage.address)} exceeds ${targetConfig.label} flash`
        );
      }
    } catch (err: unknown) {
      alert(getErrorMessage(err));
      return;
    }

    const progressByProbe = new Map(
      selectedProbes.map((probe) => [probe.id, 0])
    );
    const initialStatuses = Object.fromEntries(
      selectedProbes.map((probe) => [
        probe.id,
        { state: "waiting", progress: 0 } satisfies BatchProbeStatus,
      ])
    );

    setFlashing(true);
    setProgress(0);
    setBatchStatuses(initialStatuses);
    addLog(
      `\n=== Lote ${batchName.trim() || "sin referencia"}: ${selectedProbes.length} canal(es), ${selectedFirmware.name}, SWD ${formatSwdClock(swdClockHz)} ===\n`
    );

    const updateProbeStatus = (
      probeId: string,
      update: Partial<BatchProbeStatus>
    ) => {
      setBatchStatuses((current) => ({
        ...current,
        [probeId]: {
          ...(current[probeId] ?? { state: "waiting", progress: 0 }),
          ...update,
        },
      }));
    };

    const updateProbeProgress = (probeId: string, nextProgress: number) => {
      progressByProbe.set(probeId, nextProgress);
      updateProbeStatus(probeId, { progress: nextProgress });
      const totalProgress = Array.from(progressByProbe.values()).reduce(
        (total, current) => total + current,
        0
      );
      setProgress(
        Number((totalProgress / selectedProbes.length).toFixed(1))
      );
    };

    const results = await Promise.allSettled(
      selectedProbes.map(async (probe) => {
        const channelLog = (message: string) =>
          addLog(`[${probe.label}] ${message}`);
        let transport: DapTransport | null = null;
        let target: CortexM | null = null;

        updateProbeStatus(probe.id, {
          state: "programming",
          progress: 0,
          message: "Conectando",
        });
        channelLog("Inicio del canal\n");

        try {
          const connectedProbe = await resolveConnectedProbe(probe);
          transport =
            connectedProbe.transport === "webhid"
              ? new WebHidCmsisDapTransport(
                  connectedProbe.device as WebHidDevice
                )
              : new FlexibleWebUsbTransport(
                  connectedProbe.device as ConstructorParameters<
                    typeof DapWebUSB
                  >[0],
                  channelLog
                );
          channelLog("Programador reconfirmado en el bus\n");

          const session = createCortexTarget(transport, swdClockHz);
          target = session.target;
          await target.connect();
          if (targetConfig.algorithm === "py32f0") {
            await session.dap.configureTransfer(0, PY32_DAP_WAIT_RETRY, 0);
          }
          channelLog("SWD conectado\n");

          await target.halt();
          channelLog("Core detenido\n");

          const callbacks = {
            addLog: channelLog,
            setProgress: (nextProgress: number) =>
              updateProbeProgress(probe.id, nextProgress),
          };

          if (targetConfig.algorithm === "py32f0") {
            await flashPy32F0(
              target,
              firmwareImage,
              targetConfig,
              callbacks
            );
          } else {
            await flashStm32F1(
              target,
              firmwareImage,
              targetConfig,
              callbacks
            );
          }

          await target.softReset();
          updateProbeProgress(probe.id, 100);
          updateProbeStatus(probe.id, {
            state: "success",
            message: "Programado y verificado",
          });
          channelLog("OK: programado, verificado y reiniciado\n");
          return probe;
        } catch (err: unknown) {
          const message = getCortexProbeErrorMessage(err, swdClockHz);
          updateProbeStatus(probe.id, {
            state: "error",
            message,
          });
          channelLog(`FALLO: ${message}\n`);
          throw new Error(`${probe.label}: ${message}`, { cause: err });
        } finally {
          try {
            await target?.disconnect();
          } catch {
            try {
              await transport?.close();
            } catch {
              // This channel is already closed or unavailable.
            }
          }
        }
      })
    );

    const successful = results.filter(
      (result) => result.status === "fulfilled"
    ).length;
    const failedResults = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected"
    );

    setProgress(100);
    addLog(
      `=== Resultado del lote ${batchName.trim() || "sin referencia"}: ${successful} correctos, ${failedResults.length} fallidos, ${selectedProbes.length} total ===\n`
    );
    for (const failedResult of failedResults) {
      addLog(`- ${getErrorMessage(failedResult.reason)}\n`);
    }
    setFlashing(false);
  }

  useEffect(() => {
    if (!showConsole) return;

    const logsElement = logsContainerRef.current;
    if (!logsElement) return;

    logsElement.scrollTop = logsElement.scrollHeight;
  }, [logs, showConsole]);

  const busy = connectingTarget || flashing || authorizingProbe !== null;
  const webUsbAvailable = Boolean(getUsbApi());
  const webHidAvailable = Boolean(getHidApi());
  const selectedBatchProbeCount = authorizedProbes.filter((probe) =>
    batchProbeIds.includes(probe.id)
  ).length;
  const batchStatusValues = Object.values(batchStatuses);
  const successfulProbeCount = batchStatusValues.filter(
    (status) => status.state === "success"
  ).length;
  const failedProbeCount = batchStatusValues.filter(
    (status) => status.state === "error"
  ).length;
  const programmingProbeCount = batchStatusValues.filter(
    (status) => status.state === "programming"
  ).length;
  const panelSlots = panelSlotProbeIds.map(
    (probeId) =>
      authorizedProbes.find((probe) => probe.id === probeId) ?? null
  );
  const selectedTargetConfig = TARGETS[selectedTarget];
  const buttonBase =
    "rounded border px-2 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <main className="min-h-[calc(100vh-65px)] w-full">
      <section className="min-h-[calc(100vh-65px)] overflow-hidden border-y border-slate-800 bg-slate-100">
        <div
          className={`grid min-w-0 gap-0 ${
            configurationOpen
              ? "xl:grid-cols-[330px_minmax(0,1fr)]"
              : "grid-cols-1"
          }`}
        >
          {configurationOpen ? (
          <div className="grid min-w-0 content-start gap-2">
            <div className="border-b border-r border-slate-300 bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-bold text-slate-950">
                  Configuración
                </div>
                <div className="font-mono text-[10px] font-bold text-cyan-700">
                  {formatSwdClock(swdClockHz)}
                </div>
              </div>
              <label className="mb-2 block min-w-0">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Lote / orden de producción
                </div>
                <input
                  className="w-full rounded border border-slate-300 bg-slate-50 px-2 py-1.5 font-mono text-xs font-semibold text-slate-950 outline-none placeholder:text-slate-400 focus:border-cyan-500"
                  disabled={busy}
                  onChange={(event) => setBatchName(event.target.value)}
                  placeholder="Ej. OP-2026-0042"
                  type="text"
                  value={batchName}
                />
              </label>
              <div className="mb-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Filtrar objetivos
                  </div>
                  <div className="text-[10px] font-medium text-slate-400">
                    {filteredTargetEntries.length} resultados
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {FAMILY_FILTERS.map((family) => (
                    <button
                      className={`rounded border px-1.5 py-1 text-[11px] font-bold transition disabled:opacity-50 ${
                        familyFilter === family.id
                          ? "border-cyan-500 bg-cyan-50 text-cyan-900"
                          : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
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
                <input
                  className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-900 outline-none placeholder:text-slate-400 focus:border-cyan-500"
                  disabled={busy}
                  onChange={(event) => setTargetSearch(event.target.value)}
                  placeholder="Buscar target..."
                  type="search"
                  value={targetSearch}
                />
              </div>
              <label className="block min-w-0">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Microcontrolador objetivo
                </div>
                <select
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-950"
                  disabled={busy || filteredTargetEntries.length === 0}
                  onChange={(event) =>
                    setSelectedTarget(event.target.value as TargetKey)
                  }
                  value={selectedTargetAvailable ? selectedTarget : ""}
                >
                  {!selectedTargetAvailable ? (
                    <option value="">
                      {filteredTargetEntries.length === 0
                        ? "Sin resultados"
                        : "Selecciona un objetivo"}
                    </option>
                  ) : null}
                  {filteredTargetEntries.map(([key, target]) => (
                    <option key={key} value={key}>
                      {target.label}
                    </option>
                  ))}
                </select>
                <div className="mt-1 truncate text-[10px] text-slate-500">
                  {selectedTargetAvailable
                    ? selectedTargetConfig.description
                    : "Selecciona un objetivo de los resultados filtrados."}
                </div>
              </label>
              <label className="mt-2 block min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Velocidad SWD
                  </span>
                  <span className="font-mono text-[10px] font-bold text-cyan-700">
                    {formatSwdClock(swdClockHz)}
                  </span>
                </div>
                <select
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-950"
                  disabled={busy}
                  onChange={(event) =>
                    setSwdClockHz(Number(event.target.value))
                  }
                  value={swdClockHz}
                >
                  {SWD_CLOCK_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mx-2 rounded border border-slate-300 bg-white p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Firmware
              </div>
              <label
                className={`block w-full rounded border border-slate-900 bg-slate-950 px-2 py-1.5 text-center text-xs font-semibold text-white transition ${
                  busy
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:bg-slate-800"
                }`}
              >
                Seleccionar firmware
                <input
                  accept=".bin,.elf,application/octet-stream"
                  className="sr-only"
                  disabled={busy}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    const file = input.files?.[0] ?? null;
                    void setSelectedFirmware(file, null).finally(() => {
                      input.value = "";
                    });
                  }}
                  type="file"
                />
              </label>
              <div className="mt-1 min-w-0 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs">
                <div className="truncate font-semibold text-slate-950">
                  {firmwareName || "Ningún archivo seleccionado"}
                </div>
                <div className="text-[10px] text-slate-500">
                  {firmware ? formatBytes(firmware.size) : ".bin o .elf"}
                </div>
              </div>
            </div>

            <div className="mx-2 mb-2 rounded border border-slate-300 bg-white p-2">
              <div className="mb-1 flex items-center justify-between gap-3">
                <div className="text-xs font-semibold text-slate-800">
                  Progreso
                </div>
                <div className="font-mono text-sm text-slate-600">
                  {progress}%
                </div>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-cyan-500 transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <button
              className="mx-2 mb-2 rounded border border-cyan-600 bg-cyan-50 px-2 py-1.5 text-xs font-bold text-cyan-900 hover:bg-cyan-100"
              disabled={busy}
              onClick={() => setConfigurationOpen(false)}
              type="button"
            >
              Listo · ocultar configuración
            </button>
          </div>
          ) : null}

          <aside className="min-w-0 bg-slate-100 p-2 lg:p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-bold text-slate-700 hover:border-cyan-500 hover:text-cyan-800 disabled:opacity-50"
                  disabled={busy}
                  onClick={() =>
                    setConfigurationOpen((current) => !current)
                  }
                  type="button"
                >
                  {configurationOpen ? "Ocultar configuración" : "Configurar"}
                </button>
                <div className="min-w-0 truncate text-[11px] text-slate-600">
                  <strong className="text-slate-900">
                    {selectedTargetConfig.label}
                  </strong>
                  {" · "}
                  {formatSwdClock(swdClockHz)}
                  {" · "}
                  {firmwareName || "sin firmware"}
                  {" · "}
                  <span className="font-mono font-bold">{progress}%</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="rounded-full border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] font-bold text-slate-700">
                  {authorizedProbeCount} conectados ·{" "}
                  {selectedBatchProbeCount}/{MAX_PANEL_SLOTS} sockets activos
                </div>
                <button
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[10px] font-bold text-slate-700 shadow-sm transition hover:border-cyan-500 hover:text-cyan-800 disabled:cursor-wait disabled:opacity-60"
                  disabled={busy || scanningProbes}
                  onClick={() =>
                    void scanAuthorizedProbes("Reescaneo manual")
                  }
                  type="button"
                >
                  {scanningProbes
                    ? "Escaneando..."
                    : "Reescanear"}
                </button>
              </div>
            </div>
            <div className="grid gap-2">
              <details className="group min-w-0 rounded border border-slate-200 bg-slate-50">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 text-xs font-semibold text-slate-700">
                  <span>Autorización avanzada</span>
                  <span className="text-slate-400 transition group-open:rotate-180">
                    ▾
                  </span>
                </summary>
                <div className="grid gap-2 border-t border-slate-200 p-3">
              <div className="rounded-md border border-cyan-200 bg-cyan-50 p-3 text-xs text-cyan-950">
                <div className="font-semibold">
                  Autoriza los programadores para este sitio
                </div>
                <div className="mt-1 text-cyan-800">
                  Los permisos de localhost no se comparten con GitHub Pages.
                  Autoriza cada programador una vez; después podrás
                  reescanearlo automáticamente.
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <button
                    className="rounded-md border border-cyan-600 bg-white px-2.5 py-2 font-semibold text-cyan-900 shadow-sm transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy || !webUsbAvailable}
                    onClick={() => void authorizeCmsisDapProbe("webusb")}
                    type="button"
                  >
                    {authorizingProbe === "webusb"
                      ? "Esperando selector..."
                      : "Autorizar v2 / WebUSB"}
                  </button>
                  <button
                    className="rounded-md border border-cyan-600 bg-white px-2.5 py-2 font-semibold text-cyan-900 shadow-sm transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy || !webHidAvailable}
                    onClick={() => void authorizeCmsisDapProbe("webhid")}
                    type="button"
                  >
                    {authorizingProbe === "webhid"
                      ? "Esperando selector..."
                      : "Autorizar v1 / WebHID"}
                  </button>
                </div>
                {!webUsbAvailable || !webHidAvailable ? (
                  <div className="mt-2 font-medium text-amber-800">
                    Tu navegador no expone{" "}
                    {!webUsbAvailable && !webHidAvailable
                      ? "WebUSB ni WebHID"
                      : !webUsbAvailable
                        ? "WebUSB"
                        : "WebHID"}
                    . Abre la URL HTTPS directamente en Chrome o Edge de
                    escritorio.
                  </div>
                ) : null}
              </div>
              <div
                className={
                  detectedProbe
                    ? "min-w-0 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
                    : "min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-500"
                }
              >
                <div className="text-xs font-semibold uppercase tracking-wide">
                  Programador
                </div>
                <div className="mt-0.5 break-words font-medium">
                  {detectedProbe
                    ? `Detectado: ${detectedProbe}`
                    : authorizedProbeCount > 1
                      ? `${authorizedProbeCount} programadores autorizados; selecciona uno`
                    : "Ningún CMSIS-DAP autorizado para este sitio"}
                </div>
              </div>

              <label className="grid min-w-0 gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                Programador CMSIS-DAP
                <select
                  className="w-full min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-800"
                  disabled={busy}
                  onChange={(event) => {
                    const probeId = event.target.value;
                    const probe =
                      authorizedProbes.find(
                        (candidate) => candidate.id === probeId
                      ) ?? null;
                    setSelectedProbeId(probeId);
                    setDetectedProbe(probe?.label ?? "");
                    if (probe) setCmsisTransport("auto");
                  }}
                  value={selectedProbeId}
                >
                  <option value="">
                    {authorizedProbes.length > 0
                      ? "Seleccionar o autorizar otro..."
                      : "Autorizar un programador nuevo..."}
                  </option>
                  {authorizedProbes.map((probe) => (
                    <option key={probe.id} value={probe.id}>
                      {probe.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid min-w-0 gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                Transporte CMSIS-DAP
                <select
                  className="w-full min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-800"
                  disabled={busy}
                  onChange={(event) =>
                    setCmsisTransport(event.target.value as CmsisTransportKind)
                  }
                  value={cmsisTransport}
                >
                  <option value="auto">Automático (v1 / v2)</option>
                  <option value="webhid">WebHID (CMSIS-DAP v1 / QinHeng)</option>
                  <option value="webusb">WebUSB (CMSIS-DAP v2)</option>
                </select>
              </label>
                </div>
              </details>

              <fieldset className="min-w-0 rounded border border-slate-200 bg-slate-50/70 p-2">
                <legend className="px-1 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                  Canales disponibles
                </legend>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 shadow-sm hover:border-cyan-400 hover:text-cyan-800"
                      disabled={busy || authorizedProbes.length === 0}
                      onClick={() =>
                        setBatchProbeIds(
                          panelSlots
                            .filter(
                              (probe): probe is AuthorizedCmsisProbe =>
                                probe !== null
                            )
                            .map((probe) => probe.id)
                        )
                      }
                      type="button"
                    >
                      Activar conectados
                    </button>
                    <button
                      className="rounded border border-transparent px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-200/70 hover:text-slate-800"
                      disabled={busy || batchProbeIds.length === 0}
                      onClick={() => setBatchProbeIds([])}
                      type="button"
                    >
                      Desactivar
                    </button>
                  </div>
                  <div className="text-[10px] font-medium text-slate-500">
                    {authorizedProbes.length} conectados
                  </div>
                </div>
                <div
                  className={`grid min-w-0 gap-2 sm:grid-cols-2 ${
                    configurationOpen
                      ? "lg:grid-cols-3 2xl:grid-cols-5"
                      : "md:grid-cols-3 xl:grid-cols-5"
                  }`}
                >
                  {panelSlots.map((probe, slotIndex) => {
                    if (!probe) {
                      return (
                        <div
                          className="grid min-h-24 content-between gap-2 rounded-md border border-dashed border-slate-300 bg-slate-100/60 p-2.5"
                          key={`empty-slot-${slotIndex}`}
                        >
                          <div className="flex items-center gap-2">
                            <div className="grid size-6 shrink-0 place-items-center rounded-full border border-slate-300 bg-white font-mono text-[10px] font-bold text-slate-400">
                              {slotIndex + 1}
                            </div>
                            <div className="text-xs font-semibold text-slate-500">
                              Socket vacío
                            </div>
                          </div>
                          <select
                            className="w-full rounded border border-cyan-500 bg-white px-2 py-1.5 text-xs font-bold text-cyan-900 disabled:opacity-50"
                            defaultValue=""
                            disabled={busy}
                            onChange={(event) => {
                              const transport = event.currentTarget.value as
                                | AuthorizedCmsisProbe["transport"]
                                | "";
                              event.currentTarget.value = "";
                              if (transport) {
                                void authorizeCmsisDapProbe(
                                  transport,
                                  slotIndex
                                );
                              }
                            }}
                          >
                            <option value="">
                              {authorizingSlot === slotIndex
                                ? "Esperando selector..."
                                : "Conectar programador..."}
                            </option>
                            <option
                              disabled={!webUsbAvailable}
                              value="webusb"
                            >
                              v2 / WebUSB
                            </option>
                            <option
                              disabled={!webHidAvailable}
                              value="webhid"
                            >
                              v1 / WebHID
                            </option>
                          </select>
                        </div>
                      );
                    }

                        const probeStatus = batchStatuses[probe.id];
                        const statusClassName =
                          probeStatus?.state === "success"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                            : probeStatus?.state === "error"
                              ? "border-red-200 bg-red-50 text-red-800"
                              : probeStatus?.state === "programming"
                                ? "border-amber-200 bg-amber-50 text-amber-800"
                                : "border-slate-200 bg-slate-50 text-slate-700";

                        return (
                          <div
                            className={`relative grid min-h-24 min-w-0 content-between gap-2 rounded-md border p-2.5 text-xs shadow-sm transition ${statusClassName}`}
                            key={probe.id}
                          >
                            <span className="absolute right-2 top-2 grid size-6 place-items-center rounded-full border border-current/15 bg-white/70 font-mono text-[10px] font-bold opacity-70">
                              {slotIndex + 1}
                            </span>
                            <label className="flex min-w-0 cursor-pointer items-start gap-2">
                              <input
                                checked={batchProbeIds.includes(probe.id)}
                                className="mt-0.5 shrink-0"
                                disabled={busy}
                                onChange={(event) =>
                                  setBatchProbeIds((current) =>
                                    event.target.checked
                                      ? [...current, probe.id]
                                      : current.filter(
                                          (probeId) => probeId !== probe.id
                                        )
                                  )
                                }
                                type="checkbox"
                              />
                              <span className="min-w-0">
                                <span className="block break-words pr-7 text-sm font-bold leading-snug">
                                  {probe.label.split(" · ")[0]}
                                </span>
                                <span className="mt-1 block break-words font-mono text-[10px] font-medium opacity-75">
                                  {probe.label.split(" · ").slice(1).join(" · ")}
                                </span>
                              </span>
                            </label>
                            {probeStatus ? (
                              <>
                                <span className="break-words pl-5 text-[11px] font-semibold">
                                  {probeStatus.state === "success"
                                    ? probeStatus.message || "Correcto"
                                    : probeStatus.state === "error"
                                      ? `Falló: ${probeStatus.message}`
                                      : probeStatus.state === "programming"
                                        ? `${probeStatus.message || "Procesando"} ${probeStatus.progress.toFixed(0)}%`
                                        : "En espera"}
                                </span>
                                <span className="ml-6 h-1.5 overflow-hidden rounded-full bg-white/80">
                                  <span
                                    className={`block h-full rounded-full ${
                                      probeStatus.state === "error"
                                        ? "bg-red-500"
                                        : probeStatus.state === "success"
                                          ? "bg-emerald-500"
                                          : "bg-cyan-500"
                                    }`}
                                    style={{
                                      width: `${probeStatus.progress}%`,
                                    }}
                                  />
                                </span>
                              </>
                            ) : null}
                            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
                              <select
                                className="min-w-0 rounded border border-current/20 bg-white/70 px-1.5 py-1 text-[10px] font-bold hover:bg-white disabled:opacity-50"
                                defaultValue=""
                                disabled={busy}
                                onChange={(event) => {
                                  const transport = event.currentTarget
                                    .value as
                                    | AuthorizedCmsisProbe["transport"]
                                    | "";
                                  event.currentTarget.value = "";
                                  if (transport) {
                                    void authorizeCmsisDapProbe(
                                      transport,
                                      slotIndex
                                    );
                                  }
                                }}
                              >
                                <option value="">Cambiar programador...</option>
                                <option
                                  disabled={!webUsbAvailable}
                                  value="webusb"
                                >
                                  v2 / WebUSB
                                </option>
                                <option
                                  disabled={!webHidAvailable}
                                  value="webhid"
                                >
                                  v1 / WebHID
                                </option>
                              </select>
                              <button
                                className="rounded border border-current/20 bg-white/70 px-2 py-1 text-[10px] font-bold hover:bg-white disabled:opacity-50"
                                disabled={busy}
                                onClick={() => {
                                  setPanelSlotProbeIds((current) =>
                                    current.map((probeId, index) =>
                                      index === slotIndex ? null : probeId
                                    )
                                  );
                                  setBatchProbeIds((current) =>
                                    current.filter(
                                      (probeId) => probeId !== probe.id
                                    )
                                  );
                                }}
                                type="button"
                              >
                                Quitar
                              </button>
                            </div>
                          </div>
                        );
                      })}
                </div>
              </fieldset>

              <div className="grid grid-cols-3 overflow-hidden rounded border border-slate-200 bg-white">
                <div className="border-r border-slate-200 px-2 py-1 text-center">
                  <div className="font-mono text-sm font-bold text-emerald-600">
                    {successfulProbeCount}
                  </div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    OK
                  </div>
                </div>
                <div className="border-r border-slate-200 px-2 py-1 text-center">
                  <div className="font-mono text-sm font-bold text-amber-600">
                    {programmingProbeCount}
                  </div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Procesando
                  </div>
                </div>
                <div className="px-2 py-1 text-center">
                  <div className="font-mono text-sm font-bold text-red-600">
                    {failedProbeCount}
                  </div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Rechazo
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white p-2">
                <div className="flex gap-1.5">
                  <button
                    className={`${buttonBase} border-slate-300 bg-white text-slate-600 hover:border-cyan-400 hover:text-cyan-800`}
                    disabled={busy || !selectedTargetAvailable}
                    onClick={connectCortexTarget}
                    type="button"
                  >
                    {connectingTarget ? "Conectando..." : "Probar uno"}
                  </button>
                  <button
                    className={`${buttonBase} border-slate-300 bg-white text-slate-600 hover:border-slate-500 hover:text-slate-900`}
                    disabled={busy || !firmware || !selectedTargetAvailable}
                    onClick={flashCortexFirmware}
                    type="button"
                  >
                    {flashing ? "Programando..." : "Programar uno"}
                  </button>
                </div>
                <div className="flex flex-1 justify-end gap-1.5 sm:flex-none">
                  <button
                    className={`${buttonBase} border-cyan-600 bg-cyan-50 px-3 text-cyan-900 shadow-sm hover:bg-cyan-100`}
                    disabled={
                      busy ||
                      !selectedTargetAvailable ||
                      selectedBatchProbeCount === 0
                    }
                    onClick={testSelectedCortexTargets}
                    type="button"
                  >
                    {connectingTarget
                      ? "Probando lote..."
                      : `Probar lote · ${selectedBatchProbeCount}`}
                  </button>
                  <button
                    className={`${buttonBase} border-cyan-500 bg-cyan-400 px-4 text-sm font-bold text-slate-950 shadow-sm hover:bg-cyan-300`}
                    disabled={
                      busy ||
                      !firmware ||
                      !selectedTargetAvailable ||
                      selectedBatchProbeCount === 0
                    }
                    onClick={flashCortexFirmwareBatch}
                    type="button"
                  >
                    {flashing
                      ? "Programando lote..."
                      : `Programar lote · ${selectedBatchProbeCount}`}
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </div>

        <div className="border-t border-slate-200 bg-slate-950 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-slate-200">
                Consola CMSIS-DAP / SWD
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-100 transition hover:bg-slate-800 disabled:opacity-50"
                disabled={busy || logs.length === 0}
                onClick={() => setLogs("")}
                type="button"
              >
                Limpiar
              </button>
              <button
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-100 transition hover:bg-slate-800"
                onClick={() => setShowConsole((current) => !current)}
                type="button"
              >
                {showConsole ? "Ocultar consola" : "Mostrar consola"}
              </button>
            </div>
          </div>

          {showConsole ? (
            <div
              className="mt-2 h-[36vh] min-h-[220px] overflow-y-auto rounded border border-slate-800 bg-slate-900 p-2 font-mono text-xs whitespace-pre-wrap text-slate-100"
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
