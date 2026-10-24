import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  extractRainMakerProvisioning,
  type RainMakerProvisioningPayload,
} from "../rainmaker/provisioning";

const BAUD_RATE_OPTIONS = [
  9_600,
  19_200,
  38_400,
  57_600,
  115_200,
  230_400,
  460_800,
  921_600,
] as const;
const DEFAULT_BAUD_RATE = 115_200;
const MAX_VISIBLE_CHARACTERS = 500_000;
const RAINMAKER_DETECTION_BUFFER_SIZE = 16_000;

type SerialPortInfo = {
  usbVendorId?: number;
  usbProductId?: number;
};

type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  open(options: {
    baudRate: number;
    dataBits: 8;
    stopBits: 1;
    parity: "none";
    flowControl: "none";
  }): Promise<void>;
  close(): Promise<void>;
  getInfo?(): SerialPortInfo;
};

type SerialApi = {
  requestPort(): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
  addEventListener(type: "connect" | "disconnect", listener: EventListener): void;
  removeEventListener(type: "connect" | "disconnect", listener: EventListener): void;
};

type SerialConnectionEvent = Event & {
  port?: SerialPortLike;
};

function getSerialApi(): SerialApi | undefined {
  return (navigator as Navigator & { serial?: SerialApi }).serial;
}

function formatUsbId(value?: number): string {
  return value === undefined ? "????" : value.toString(16).padStart(4, "0");
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No se seleccionó ningún puerto.";
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("failed to open serial port")) {
    return "No se pudo abrir el puerto. Comprueba que ninguna otra aplicación lo esté usando.";
  }

  return message;
}

function isDeviceLostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes("device has been lost") ||
    normalizedMessage.includes("device was disconnected") ||
    normalizedMessage.includes("disconnected") ||
    normalizedMessage.includes("networkerror")
  );
}

function isSerialPort(value: unknown): value is SerialPortLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    typeof (value as { open?: unknown }).open === "function"
  );
}

function getEventPort(event: Event): SerialPortLike | null {
  const legacyPort = (event as SerialConnectionEvent).port;
  if (isSerialPort(legacyPort)) return legacyPort;
  return isSerialPort(event.target) ? event.target : null;
}

function portsMatch(
  candidate: SerialPortLike,
  expectedInfo: SerialPortInfo | null
): boolean {
  if (!expectedInfo) return false;
  const candidateInfo = candidate.getInfo?.() ?? {};
  return (
    candidateInfo.usbVendorId === expectedInfo.usbVendorId &&
    candidateInfo.usbProductId === expectedInfo.usbProductId
  );
}

export default function SerialMonitor() {
  const [baudRate, setBaudRate] = useState(DEFAULT_BAUD_RATE);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [waitingForReconnect, setWaitingForReconnect] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [output, setOutput] = useState("");
  const [receivedBytes, setReceivedBytes] = useState(0);
  const [portLabel, setPortLabel] = useState("Sin puerto seleccionado");
  const [errorMessage, setErrorMessage] = useState("");
  const [rainMakerProvisioning, setRainMakerProvisioning] =
    useState<RainMakerProvisioningPayload | null>(null);
  const [rainMakerQrDataUrl, setRainMakerQrDataUrl] = useState("");
  const [rainMakerQrError, setRainMakerQrError] = useState("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle"
  );

  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const readTaskRef = useRef<Promise<void> | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(false);
  const pendingOutputRef = useRef("");
  const mountedRef = useRef(true);
  const baudRateRef = useRef(DEFAULT_BAUD_RATE);
  const autoReconnectRef = useRef(true);
  const reconnectWantedRef = useRef(false);
  const preferredPortInfoRef = useRef<SerialPortInfo | null>(null);
  const preferredPortLabelRef = useRef("Sin puerto seleccionado");
  const openingPortRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reopenPortRef = useRef<((port: SerialPortLike) => Promise<void>) | null>(
    null
  );
  const rainMakerDetectionBufferRef = useRef("");
  const rainMakerPayloadRef = useRef("");

  function detectRainMakerProvisioning(text: string) {
    rainMakerDetectionBufferRef.current = (
      rainMakerDetectionBufferRef.current + text
    ).slice(-RAINMAKER_DETECTION_BUFFER_SIZE);

    const provisioning = extractRainMakerProvisioning(
      rainMakerDetectionBufferRef.current
    );
    if (!provisioning || provisioning.payload === rainMakerPayloadRef.current) {
      return;
    }

    rainMakerPayloadRef.current = provisioning.payload;
    setRainMakerProvisioning(provisioning);
    setRainMakerQrDataUrl("");
    setRainMakerQrError("");
    setCopyStatus("idle");

    void QRCode.toDataURL(provisioning.payload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 420,
      color: {
        dark: "#020617",
        light: "#ffffff",
      },
    })
      .then((dataUrl) => {
        if (
          mountedRef.current &&
          rainMakerPayloadRef.current === provisioning.payload
        ) {
          setRainMakerQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setRainMakerQrError(
            `No se pudo generar el QR: ${getErrorMessage(error)}`
          );
        }
      });
  }

  function appendOutput(text: string) {
    if (!text) return;
    detectRainMakerProvisioning(text);

    if (pausedRef.current) {
      pendingOutputRef.current = (
        pendingOutputRef.current + text
      ).slice(-MAX_VISIBLE_CHARACTERS);
      return;
    }

    setOutput((current) =>
      (current + text).slice(-MAX_VISIBLE_CHARACTERS)
    );
  }

  async function readPort(port: SerialPortLike) {
    const decoder = new TextDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      if (!port.readable) {
        throw new Error("El puerto no expone un flujo de lectura.");
      }

      reader = port.readable.getReader();
      readerRef.current = reader;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        if (mountedRef.current) {
          setReceivedBytes((current) => current + value.byteLength);
          appendOutput(decoder.decode(value, { stream: true }));
        }
      }

      const finalText = decoder.decode();
      if (mountedRef.current) appendOutput(finalText);
    } catch (error) {
      if (mountedRef.current && portRef.current === port) {
        if (isDeviceLostError(error)) {
          if (autoReconnectRef.current) {
            reconnectWantedRef.current = true;
            setWaitingForReconnect(true);
            setErrorMessage("");
            setPortLabel(`${preferredPortLabelRef.current} · esperando USB`);
          } else {
            setErrorMessage(
              "El dispositivo se desconectó. Vuelve a seleccionar el puerto para continuar."
            );
          }
        } else {
          setErrorMessage(`La lectura se detuvo: ${getErrorMessage(error)}`);
        }
      }
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        // The reader may already have released its lock after a disconnect.
      }
      if (readerRef.current === reader) readerRef.current = null;

      if (mountedRef.current && portRef.current === port) {
        portRef.current = null;
        setConnected(false);
        if (!reconnectWantedRef.current) {
          setPortLabel("Sin puerto seleccionado");
        }
        void port.close().catch(() => undefined);
      }
    }
  }

  async function openPort(port: SerialPortLike, reconnecting = false) {
    if (openingPortRef.current || portRef.current) return;
    openingPortRef.current = true;
    setConnecting(true);
    if (reconnecting) setWaitingForReconnect(true);
    setErrorMessage("");

    try {
      await port.open({
        baudRate: baudRateRef.current,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
      });

      const info = port.getInfo?.() ?? {};
      const label = `USB ${formatUsbId(info.usbVendorId)}:${formatUsbId(info.usbProductId)}`;
      preferredPortInfoRef.current = info;
      preferredPortLabelRef.current = label;
      reconnectWantedRef.current = false;
      portRef.current = port;
      setPortLabel(label);
      setWaitingForReconnect(false);
      setConnected(true);
      appendOutput(
        reconnecting ? "\n[Puerto serial reconectado]\n" : ""
      );
      readTaskRef.current = readPort(port);
    } catch (error) {
      if (reconnecting && autoReconnectRef.current) {
        reconnectWantedRef.current = true;
        setWaitingForReconnect(true);
        setPortLabel(`${preferredPortLabelRef.current} · esperando USB`);
        reconnectTimerRef.current = window.setTimeout(() => {
          void (async () => {
            if (!reconnectWantedRef.current || !autoReconnectRef.current) return;
            const serial = getSerialApi();
            const authorizedPorts = await serial?.getPorts().catch(() => []);
            const matchingPort = authorizedPorts?.find((candidate) =>
              portsMatch(candidate, preferredPortInfoRef.current)
            );
            if (matchingPort) await reopenPortRef.current?.(matchingPort);
          })();
        }, 1_000);
      } else {
        setErrorMessage(getErrorMessage(error));
        setWaitingForReconnect(false);
      }
      setConnected(false);
    } finally {
      openingPortRef.current = false;
      setConnecting(false);
    }
  }

  async function connect() {
    const serial = getSerialApi();
    if (!serial) {
      setErrorMessage(
        "Web Serial no está disponible. Abre la aplicación en Chrome o Edge de escritorio mediante HTTPS."
      );
      return;
    }

    setConnecting(true);
    setErrorMessage("");
    reconnectWantedRef.current = false;
    setWaitingForReconnect(false);

    try {
      const selectedPort = await serial.requestPort();
      setConnecting(false);
      await openPort(selectedPort);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
      setConnected(false);
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    reconnectWantedRef.current = false;
    setWaitingForReconnect(false);
    setErrorMessage("");
    const activePort = portRef.current;
    portRef.current = null;

    try {
      await readerRef.current?.cancel();
    } catch {
      // The device may already be unplugged.
    }

    try {
      await readTaskRef.current;
    } catch {
      // Read errors are already shown in the terminal status.
    }
    readTaskRef.current = null;

    try {
      await activePort?.close();
    } catch {
      // A disconnected port can already be closed by the browser.
    }

    setConnected(false);
    setPortLabel("Sin puerto seleccionado");
  }

  function cancelReconnect() {
    reconnectWantedRef.current = false;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setWaitingForReconnect(false);
    setConnecting(false);
    setPortLabel("Sin puerto seleccionado");
    setErrorMessage("");
  }

  function changeAutoReconnect(enabled: boolean) {
    autoReconnectRef.current = enabled;
    setAutoReconnect(enabled);
    if (!enabled && waitingForReconnect) cancelReconnect();
  }

  function togglePause() {
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      const pendingOutput = pendingOutputRef.current;
      pendingOutputRef.current = "";
      appendOutput(pendingOutput);
      return;
    }

    pausedRef.current = true;
    setPaused(true);
  }

  function clearOutput() {
    setOutput("");
    setReceivedBytes(0);
    pendingOutputRef.current = "";
  }

  function downloadOutput() {
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `serial-${new Date().toISOString().replaceAll(":", "-")}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function downloadRainMakerQr() {
    if (!rainMakerQrDataUrl || !rainMakerProvisioning) return;
    const safeName = rainMakerProvisioning.data.name.replaceAll(
      /[^a-zA-Z0-9_-]/g,
      "_"
    );
    const anchor = document.createElement("a");
    anchor.href = rainMakerQrDataUrl;
    anchor.download = `rainmaker-${safeName}.png`;
    anchor.click();
  }

  async function copyRainMakerPayload() {
    if (!rainMakerProvisioning) return;

    try {
      await navigator.clipboard.writeText(rainMakerProvisioning.payload);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  function dismissRainMakerQr() {
    rainMakerPayloadRef.current = "";
    rainMakerDetectionBufferRef.current = "";
    setRainMakerProvisioning(null);
    setRainMakerQrDataUrl("");
    setRainMakerQrError("");
    setCopyStatus("idle");
  }

  useEffect(() => {
    if (!autoScroll || paused) return;
    const terminal = terminalRef.current;
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }, [autoScroll, output, paused]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      const activePort = portRef.current;
      const activeReader = readerRef.current;
      portRef.current = null;
      reconnectWantedRef.current = false;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      void (async () => {
        try {
          await activeReader?.cancel();
        } catch {
          // The port may already be disconnected.
        }
        await activePort?.close().catch(() => undefined);
      })();
    };
  }, []);

  useEffect(() => {
    reopenPortRef.current = (port) => openPort(port, true);
  });

  useEffect(() => {
    const serial = getSerialApi();
    if (!serial) return;

    const handleConnect: EventListener = (event) => {
      if (!reconnectWantedRef.current || !autoReconnectRef.current) return;

      const eventPort = getEventPort(event);
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = window.setTimeout(() => {
        void (async () => {
          const authorizedPorts = eventPort
            ? [eventPort]
            : await serial.getPorts().catch(() => []);
          const matchingPort = authorizedPorts.find((port) =>
            portsMatch(port, preferredPortInfoRef.current)
          );
          if (matchingPort) await reopenPortRef.current?.(matchingPort);
        })();
      }, 400);
    };

    const handleDisconnect: EventListener = (event) => {
      const disconnectedPort = getEventPort(event);
      if (
        !portRef.current ||
        (disconnectedPort && disconnectedPort !== portRef.current)
      ) {
        return;
      }

      if (autoReconnectRef.current) {
        reconnectWantedRef.current = true;
        setWaitingForReconnect(true);
        setPortLabel(`${preferredPortLabelRef.current} · esperando USB`);
        setErrorMessage("");
      }
    };

    serial.addEventListener("connect", handleConnect);
    serial.addEventListener("disconnect", handleDisconnect);
    return () => {
      serial.removeEventListener("connect", handleConnect);
      serial.removeEventListener("disconnect", handleDisconnect);
    };
  }, []);

  const serialAvailable = Boolean(getSerialApi());

  return (
    <main className="min-h-[calc(100vh-65px)] w-full bg-slate-100 p-3 sm:p-5">
      <section className="mx-auto w-full max-w-[1500px] overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4">
          <div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-700">
              Herramienta de diagnóstico
            </div>
            <h1 className="mt-1 text-xl font-black tracking-tight text-slate-950">
              Terminal serial
            </h1>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Monitor de datos UART/USB. Esta terminal no transmite datos al dispositivo.
            </p>
          </div>
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide ${
              connected
                ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                : waitingForReconnect
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-slate-300 bg-slate-50 text-slate-500"
            }`}
          >
            <span
              className={`size-2 rounded-full ${
                connected
                  ? "animate-pulse bg-emerald-500"
                  : waitingForReconnect
                    ? "animate-pulse bg-amber-500"
                    : "bg-slate-400"
              }`}
            />
            {connected
              ? "Recibiendo"
              : waitingForReconnect
                ? "Esperando USB"
                : "Desconectado"}
          </div>
        </div>

        <div className="grid lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="border-b border-slate-200 bg-slate-50 p-4 lg:border-b-0 lg:border-r">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
              Configuración del puerto
            </div>

            <label className="mt-3 block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Velocidad
              </span>
              <select
                className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950 outline-none focus:border-cyan-500 disabled:opacity-50"
                disabled={connected || connecting}
                onChange={(event) => {
                  const nextBaudRate = Number(event.target.value);
                  baudRateRef.current = nextBaudRate;
                  setBaudRate(nextBaudRate);
                }}
                value={baudRate}
              >
                {BAUD_RATE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option.toLocaleString()} baud
                  </option>
                ))}
              </select>
            </label>

            <div className="mt-2 rounded border border-slate-200 bg-white p-3">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Formato
              </div>
              <div className="mt-1 font-mono text-xs font-bold text-slate-700">
                8 bits · Sin paridad · 1 stop
              </div>
            </div>

            <div className="mt-2 rounded border border-slate-200 bg-white p-3">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                Puerto
              </div>
              <div className="mt-1 break-all font-mono text-xs font-bold text-slate-700">
                {portLabel}
              </div>
            </div>

            <label className="mt-2 flex cursor-pointer items-start gap-2 rounded border border-slate-200 bg-white p-3">
              <input
                checked={autoReconnect}
                className="mt-0.5 accent-cyan-500"
                onChange={(event) => changeAutoReconnect(event.target.checked)}
                type="checkbox"
              />
              <span>
                <span className="block text-xs font-bold text-slate-800">
                  Reconexión automática
                </span>
                <span className="mt-0.5 block text-[10px] leading-4 text-slate-500">
                  Reanuda la lectura si la placa se reinicia o el USB vuelve a aparecer.
                </span>
              </span>
            </label>

            <button
              className={`mt-3 w-full rounded border px-3 py-2.5 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-50 ${
                connected
                  ? "border-red-300 bg-red-50 text-red-800 hover:bg-red-100"
                  : waitingForReconnect
                    ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                  : "border-cyan-500 bg-cyan-400 text-slate-950 hover:bg-cyan-300"
              }`}
              disabled={
                (connecting && !waitingForReconnect) ||
                (!connected && !waitingForReconnect && !serialAvailable)
              }
              onClick={() => {
                if (connected) void disconnect();
                else if (waitingForReconnect) cancelReconnect();
                else void connect();
              }}
              type="button"
            >
              {waitingForReconnect
                ? "Cancelar reconexión"
                : connecting
                ? "Esperando selector..."
                : connected
                  ? "Desconectar puerto"
                  : "Seleccionar y conectar"}
            </button>

            {!serialAvailable ? (
              <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-2.5 text-[11px] leading-4 text-amber-900">
                Web Serial requiere Chrome o Edge de escritorio y una conexión HTTPS.
              </div>
            ) : null}

            {errorMessage ? (
              <div
                aria-live="polite"
                className="mt-3 rounded border border-red-200 bg-red-50 p-2.5 text-[11px] leading-4 text-red-800"
              >
                {errorMessage}
              </div>
            ) : null}
          </aside>

          <div className="min-w-0 bg-slate-950 p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <div className="text-xs font-bold text-slate-100">Datos recibidos</div>
                <div className="font-mono text-[10px] text-slate-400">
                  {formatByteCount(receivedBytes)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <label className="mr-1 flex cursor-pointer items-center gap-1.5 text-[10px] font-semibold text-slate-300">
                  <input
                    checked={autoScroll}
                    className="accent-cyan-400"
                    onChange={(event) => setAutoScroll(event.target.checked)}
                    type="checkbox"
                  />
                  Seguir salida
                </label>
                <button
                  className={`rounded border px-2 py-1 text-[10px] font-bold transition ${
                    paused
                      ? "border-amber-400 bg-amber-400/15 text-amber-200"
                      : "border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
                  }`}
                  onClick={togglePause}
                  type="button"
                >
                  {paused ? "Reanudar vista" : "Pausar vista"}
                </button>
                <button
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] font-bold text-slate-200 transition hover:bg-slate-800 disabled:opacity-40"
                  disabled={!output}
                  onClick={downloadOutput}
                  type="button"
                >
                  Descargar
                </button>
                <button
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] font-bold text-slate-200 transition hover:bg-slate-800 disabled:opacity-40"
                  disabled={!output && receivedBytes === 0}
                  onClick={clearOutput}
                  type="button"
                >
                  Limpiar
                </button>
              </div>
            </div>

            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_310px]">
              <div
                aria-live="polite"
                aria-label="Salida del puerto serial"
                className="h-[62vh] min-h-[360px] overflow-auto rounded border border-slate-800 bg-slate-900 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-emerald-300 shadow-inner"
                ref={terminalRef}
                role="log"
                tabIndex={0}
              >
                {output || (
                  <span className="text-slate-500">
                    {connected
                      ? "Puerto conectado. Esperando datos seriales…"
                      : waitingForReconnect
                        ? "Dispositivo desconectado. La lectura continuará cuando vuelva a conectarse…"
                        : "Selecciona un puerto para comenzar la lectura…"}
                  </span>
                )}
              </div>

              <aside className="min-w-0 rounded border border-slate-700 bg-white p-3 text-slate-900">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-[9px] font-black uppercase tracking-[0.16em] text-cyan-700">
                      ESP RainMaker
                    </div>
                    <div className="mt-1 text-sm font-black">
                      QR de aprovisionamiento
                    </div>
                  </div>
                  <span
                    className={`mt-1 size-2 rounded-full ${
                      rainMakerProvisioning
                        ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]"
                        : "animate-pulse bg-slate-300"
                    }`}
                  />
                </div>

                {rainMakerProvisioning ? (
                  <div className="mt-3">
                    <div className="grid min-h-64 place-items-center overflow-hidden rounded border border-slate-200 bg-white p-2">
                      {rainMakerQrDataUrl ? (
                        <img
                          alt={`QR de aprovisionamiento para ${rainMakerProvisioning.data.name}`}
                          className="aspect-square w-full max-w-64 object-contain [image-rendering:pixelated]"
                          src={rainMakerQrDataUrl}
                        />
                      ) : rainMakerQrError ? (
                        <div className="p-3 text-center text-xs text-red-700">
                          {rainMakerQrError}
                        </div>
                      ) : (
                        <div className="text-xs font-semibold text-slate-400">
                          Generando QR…
                        </div>
                      )}
                    </div>

                    <dl className="mt-3 grid gap-1.5 text-[11px]">
                      <div className="flex items-center justify-between gap-3 rounded bg-slate-50 px-2 py-1.5">
                        <dt className="font-semibold text-slate-500">Dispositivo</dt>
                        <dd className="truncate font-mono font-bold text-slate-900">
                          {rainMakerProvisioning.data.name}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded bg-slate-50 px-2 py-1.5">
                        <dt className="font-semibold text-slate-500">Transporte</dt>
                        <dd className="font-mono font-bold uppercase text-cyan-800">
                          {rainMakerProvisioning.data.transport}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded bg-slate-50 px-2 py-1.5">
                        <dt className="font-semibold text-slate-500">PoP</dt>
                        <dd className="truncate font-mono font-bold text-slate-900">
                          {rainMakerProvisioning.data.pop || "Sin PoP"}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-3 grid grid-cols-2 gap-1.5">
                      <button
                        className="rounded border border-cyan-600 bg-cyan-50 px-2 py-2 text-[10px] font-black text-cyan-900 hover:bg-cyan-100 disabled:opacity-50"
                        disabled={!rainMakerQrDataUrl}
                        onClick={downloadRainMakerQr}
                        type="button"
                      >
                        Descargar PNG
                      </button>
                      <button
                        className="rounded border border-slate-300 bg-white px-2 py-2 text-[10px] font-black text-slate-700 hover:bg-slate-50"
                        onClick={() => void copyRainMakerPayload()}
                        type="button"
                      >
                        {copyStatus === "copied"
                          ? "JSON copiado"
                          : copyStatus === "error"
                            ? "No se pudo copiar"
                            : "Copiar JSON"}
                      </button>
                    </div>
                    <button
                      className="mt-2 w-full rounded px-2 py-1 text-[10px] font-semibold text-slate-400 hover:bg-slate-50 hover:text-slate-700"
                      onClick={dismissRainMakerQr}
                      type="button"
                    >
                      Descartar QR
                    </button>
                    <p className="mt-2 text-[9px] leading-4 text-amber-700">
                      El QR incluye la prueba de posesión. Compártelo únicamente con la persona que vinculará el dispositivo.
                    </p>
                  </div>
                ) : (
                  <div className="mt-3 grid min-h-64 place-items-center rounded border border-dashed border-slate-300 bg-slate-50 p-5 text-center">
                    <div>
                      <svg
                        aria-hidden="true"
                        className="mx-auto size-10 text-slate-300"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm11 0h2v2h-2zm3 0h2v5h-2zm-3 4h2v2h-2z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
                      </svg>
                      <div className="mt-3 text-xs font-bold text-slate-600">
                        Esperando datos RainMaker
                      </div>
                      <p className="mt-1 text-[10px] leading-4 text-slate-400">
                        La terminal detectará automáticamente el JSON o la URL de aprovisionamiento que imprime el firmware.
                      </p>
                    </div>
                  </div>
                )}
              </aside>
            </div>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-slate-500">
              <span>RX · solo lectura</span>
              <span>{baudRate.toLocaleString()} baud · 8-N-1</span>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
