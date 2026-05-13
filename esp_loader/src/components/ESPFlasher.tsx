import { useEffect, useRef, useState } from "react";
import { ESPLoader, Transport } from "esptool-js";

export default function ESPFlasher() {

  const [connected, setConnected] = useState(false);

  const [logs, setLogs] = useState("");

  const [port, setPort] = useState<any>(null);

  const [firmware, setFirmware] = useState<File | null>(null);

  const [firmwareName, setFirmwareName] = useState("");

  const [flashAddress, setFlashAddress] = useState("0x0000");

  const [flashing, setFlashing] = useState(false);

  const [progress, setProgress] = useState(0);

  const readerRef = useRef<any>(null);

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

  async function delay(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function loadDefaultFirmware() {
    try {
      addLog("Cargando firmware por defecto...\n");
      const firmwareUrl = `${import.meta.env.BASE_URL}firmware/momo.ino.merged.bin`;
      const response = await fetch(firmwareUrl);
      addLog(`Respuesta HTTP: ${response.status} ${response.statusText}\n`);
      
      if (!response.ok) {
        addLog(`Error HTTP: ${response.statusText}\n`);
        return;
      }
      
      const blob = await response.blob();
      addLog(`Blob cargado: ${blob.size} bytes\n`);
      
      const file = new File([blob], "momo.ino.merged.bin", { type: "application/octet-stream" });
      setFirmware(file);
      setFirmwareName("momo.ino.merged.bin");
      addLog(`✓ Firmware cargado: momo.ino.merged.bin (${file.size} bytes)\n`);
    } catch (err: any) {
      console.error("Error en loadDefaultFirmware:", err);
      addLog(`✗ Error cargando firmware: ${err.message}\n`);
    }
  }

  async function connectESP() {

    try {

      const serial = getSerialApi();

      if (!serial) {

        alert("Web Serial API no soportado");

        return;
      }

      const selectedPort = await serial.requestPort();

      await openPortSafely(selectedPort, 115200);

      setPort(selectedPort);

      setConnected(true);

      addLog("ESP conectado\n");

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

      if (readerRef.current) {

        await readerRef.current.cancel();

        readerRef.current.releaseLock();
      }

      if (port) {

        await port.close();
      }

      setConnected(false);

      setPort(null);

      addLog("\nESP desconectado\n");

    } catch (err: any) {

      console.error(err);

      addLog(`Disconnect Error: ${err.message}\n`);
    }
  }

  async function flashFirmware() {

    try {

      if (!port) {

        alert("Conecta el ESP32");

        return;
      }

      if (!firmware) {

        alert("Selecciona un firmware");

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

      addLog("ESP detectado correctamente\n");

      const firmwareBuffer = await firmware.arrayBuffer();

      const binary = new Uint8Array(firmwareBuffer);

      const parsedFlashAddress = Number.parseInt(flashAddress, 16);

      addLog("Iniciando flasheo...\n");

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

      addLog("\nFirmware cargado correctamente\n");

      setProgress(100);

      await esploader.transport.disconnect();

      setConnected(false);
      setPort(null);

      addLog("ESP liberado\n");

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

        alert("Conecta el ESP32");

        return;
      }

      setFlashing(true);

      setProgress(0);

      addLog("\nInicializando borrado...\n");

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

      addLog("ESP detectado correctamente\n");
      addLog("Iniciando borrado total...\n");

      await esploader.eraseFlash();

      addLog("\nFlash borrada correctamente\n");

      setProgress(100);

      await esploader.transport.disconnect();

      setConnected(false);
      setPort(null);

      addLog("ESP liberado\n");

      setFlashing(false);

    } catch (err: any) {

      console.error(err);

      addLog(`\nErase Error: ${err.message}\n`);

      setFlashing(false);
    }
  }

  async function sendCommand(cmd: string) {

    try {

      if (!port?.writable) return;

      const writer = port.writable.getWriter();

      const data = new TextEncoder().encode(cmd + "\n");

      await writer.write(data);

      writer.releaseLock();

      addLog(`>> ${cmd}\n`);

    } catch (err: any) {

      console.error(err);

      addLog(`Write Error: ${err.message}\n`);
    }
  }

  useEffect(() => {

    return () => {
      disconnectESP();
    };

  }, []);

  return (

    <div
      style={{
        background: "#111",
        color: "#fff",
        minHeight: "100vh",
        padding: 20,
        fontFamily: "Arial",
      }}
    >

      <h1>ESP32 Web Flasher</h1>

      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >

        {!connected ? (

          <button onClick={connectESP}>
            Connect ESP32
          </button>

        ) : (

          <button onClick={disconnectESP}>
            Disconnect
          </button>

        )}

        <input
          type="file"
          accept=".bin"
          onChange={(e) => {

            if (e.target.files?.length) {

              setFirmware(e.target.files[0]);
              setFirmwareName(e.target.files[0].name);

              addLog(
                `Firmware seleccionado: ${e.target.files[0].name}\n`
              );
            }
          }}
        />

        <button onClick={loadDefaultFirmware}>
          Load Default Firmware
        </button>

        <input
          type="text"
          placeholder="Flash Address (e.g., 0x0000)"
          value={flashAddress}
          onChange={(e) => setFlashAddress(e.target.value)}
          style={{
            padding: 5,
            borderRadius: 4,
            border: "1px solid #666",
            background: "#222",
            color: "#fff",
          }}
        />

        {firmwareName && (
          <div style={{ color: "lime", fontSize: 14, padding: "5px 10px" }}>
            ✓ {firmwareName}
          </div>
        )}

        <button
          onClick={flashFirmware}
          disabled={!connected || !firmware || flashing}
        >
          {flashing ? "Flashing..." : "Flash Firmware"}
        </button>

        <button
          onClick={eraseFlash}
          disabled={!connected || flashing}
        >
          Erase Flash
        </button>

        <button
          onClick={() => sendCommand("test")}
          disabled={!connected}
        >
          Send TEST
        </button>

      </div>

      <div
        style={{
          width: "100%",
          height: 25,
          background: "#333",
          borderRadius: 10,
          overflow: "hidden",
          marginBottom: 20,
        }}
      >

        <div
          style={{
            width: `${progress}%`,
            height: "100%",
            background: "lime",
            transition: "0.2s",
          }}
        />

      </div>

      <div
        style={{
          marginBottom: 10,
        }}
      >
        Progress: {progress}%
      </div>

      <div
        style={{
          background: "#000",
          border: "1px solid #444",
          padding: 10,
          height: 450,
          overflowY: "scroll",
          whiteSpace: "pre-wrap",
          fontFamily: "monospace",
        }}
      >
        {logs}
      </div>

      <div
        style={{
          marginTop: 20,
        }}
      >

        Status:

        <span
          style={{
            marginLeft: 10,
            color: connected ? "lime" : "red",
          }}
        >
          {connected ? "CONNECTED" : "DISCONNECTED"}
        </span>

      </div>

    </div>
  );
}