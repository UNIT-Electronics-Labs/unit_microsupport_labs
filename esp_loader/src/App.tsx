import { useState, type ReactNode } from "react";
import CortexProgrammer from "./components/CortexProgrammer";
import ESPFlasher from "./components/ESPFlasher";
import Rp2Programmer from "./components/Rp2Programmer";
import SerialMonitor from "./components/SerialMonitor";

type DeviceFamily = "py32" | "stm32" | "gd32" | "rp2" | "esp32" | "serial";
type CommunicationInterface = "auto" | "webusb" | "webhid" | "webserial";

type FamilyOption = {
  id: DeviceFamily;
  label: string;
  maker: string;
  description: string;
  core: string;
};

type InterfaceOption = {
  id: CommunicationInterface;
  label: string;
  protocol: string;
  description: string;
  recommended?: boolean;
};

const FAMILY_OPTIONS: readonly FamilyOption[] = [
  {
    id: "py32",
    label: "PY32",
    maker: "Puya",
    description: "Series F002, F003, F030 y F071",
    core: "Cortex-M0+",
  },
  {
    id: "stm32",
    label: "STM32",
    maker: "STMicroelectronics",
    description: "Familia STM32F1",
    core: "Cortex-M3",
  },
  {
    id: "gd32",
    label: "GD32",
    maker: "GigaDevice",
    description: "Familia GD32F1",
    core: "Cortex-M3",
  },
  {
    id: "rp2",
    label: "RP2",
    maker: "Raspberry Pi",
    description: "RP2350 por CMSIS-DAP / SWD",
    core: "Cortex-M33",
  },
  {
    id: "esp32",
    label: "ESP32",
    maker: "Espressif",
    description: "ESP32, C3, C5, C6, H2 y S3",
    core: "ROM bootloader",
  },
  {
    id: "serial",
    label: "Terminal serial",
    maker: "Herramienta",
    description: "Visualiza datos UART/USB sin transmitir",
    core: "Solo lectura",
  },
];

const CORTEX_INTERFACES: readonly InterfaceOption[] = [
  {
    id: "auto",
    label: "Automática",
    protocol: "CMSIS-DAP",
    description: "Detecta WebUSB v2 o WebHID v1.",
    recommended: true,
  },
  {
    id: "webusb",
    label: "USB",
    protocol: "WebUSB · CMSIS-DAP v2",
    description: "Para sondas CMSIS-DAP v2.",
  },
  {
    id: "webhid",
    label: "HID",
    protocol: "WebHID · CMSIS-DAP v1",
    description: "Para DAPLink, QinHeng y sondas v1.",
  },
];

const ESP_INTERFACES: readonly InterfaceOption[] = [
  {
    id: "webserial",
    label: "Puerto serie",
    protocol: "Web Serial",
    description: "Conexión USB/UART al bootloader del ESP.",
    recommended: true,
  },
];
const RP2_INTERFACES: readonly InterfaceOption[] = CORTEX_INTERFACES.filter(
  (option) => option.id === "webusb" || option.id === "webhid"
);

const LAST_SELECTION_KEY = "panel-loader:last-selection";

function FamilyIcon({ family }: { family: DeviceFamily }) {
  if (family === "serial") {
    return (
      <svg aria-hidden="true" className="size-6" fill="none" viewBox="0 0 24 24">
        <path d="M4.5 5.5h15v13h-15z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
        <path d="m8 10 2 2-2 2m4.5 0H16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      </svg>
    );
  }

  if (family === "esp32") {
    return (
      <svg aria-hidden="true" className="size-6" fill="none" viewBox="0 0 24 24">
        <path d="M7 8.5h10M7 12h10M7 15.5h6M4.5 4.5h15v15h-15z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
        <path d="M1.5 8h3m-3 4h3m-3 4h3m15-8h3m-3 4h3m-3 4h3M8 1.5v3m4-3v3m4-3v3M8 19.5v3m4-3v3m4-3v3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="size-6" fill="none" viewBox="0 0 24 24">
      <path d="M8 4.5h8a3.5 3.5 0 0 1 3.5 3.5v8a3.5 3.5 0 0 1-3.5 3.5H8A3.5 3.5 0 0 1 4.5 16V8A3.5 3.5 0 0 1 8 4.5Z" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9 9h6v6H9zM1.5 8h3m-3 4h3m-3 4h3m15-8h3m-3 4h3m-3 4h3M8 1.5v3m4-3v3m4-3v3M8 19.5v3m4-3v3m4-3v3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

function StepHeading({ number, children }: { number: string; children: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="grid size-6 place-items-center rounded-full bg-cyan-400 font-mono text-[11px] font-black text-slate-950">
        {number}
      </span>
      <h2 className="text-sm font-bold text-slate-950">{children}</h2>
    </div>
  );
}

function readLastSelection(): {
  family: DeviceFamily;
  communication: CommunicationInterface;
} {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_SELECTION_KEY) ?? "null");
    const validFamily = FAMILY_OPTIONS.some((option) => option.id === saved?.family);
    const validInterface = [...CORTEX_INTERFACES, ...ESP_INTERFACES].some(
      (option) => option.id === saved?.communication
    );

    const compatibleSelection =
      saved?.family === "esp32" || saved?.family === "serial"
        ? saved?.communication === "webserial"
        : saved?.family === "rp2"
          ? saved?.communication === "webusb" || saved?.communication === "webhid"
          : saved?.communication !== "webserial";

    if (validFamily && validInterface && compatibleSelection) {
      return saved;
    }
  } catch {
    // Keep a safe default if browser storage is unavailable or malformed.
  }

  return { family: "py32", communication: "auto" };
}

function App() {
  const [initialSelection] = useState(readLastSelection);
  const [selectedFamily, setSelectedFamily] = useState<DeviceFamily>(
    initialSelection.family
  );
  const [selectedInterface, setSelectedInterface] =
    useState<CommunicationInterface>(initialSelection.communication);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  const selectedFamilyOption = FAMILY_OPTIONS.find(
    (option) => option.id === selectedFamily
  )!;
  const availableInterfaces =
    selectedFamily === "esp32" || selectedFamily === "serial"
      ? ESP_INTERFACES
      : selectedFamily === "rp2"
        ? RP2_INTERFACES
        : CORTEX_INTERFACES;
  const selectedInterfaceOption = availableInterfaces.find(
    (option) => option.id === selectedInterface
  );

  function chooseFamily(family: DeviceFamily) {
    setSelectedFamily(family);
    setSelectedInterface(
      family === "esp32" || family === "serial" ? "webserial" :
        family === "rp2" ? "webhid" : "auto"
    );
  }

  function openWorkspace() {
    const communication =
      selectedFamily === "esp32" || selectedFamily === "serial"
        ? "webserial"
        : selectedInterface;

    try {
      localStorage.setItem(
        LAST_SELECTION_KEY,
        JSON.stringify({ family: selectedFamily, communication })
      );
    } catch {
      // Storage is a convenience only; it must never block programming.
    }

    setSelectedInterface(communication);
    setWorkspaceOpen(true);
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950 text-white shadow-sm">
        <div className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center justify-between gap-3 px-3 py-3 md:px-5">
          <button
            className="flex items-center gap-3 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            onClick={() => setWorkspaceOpen(false)}
            type="button"
          >
            <span className="grid size-9 place-items-center rounded-lg border border-cyan-400/30 bg-cyan-400/10 font-mono text-xs font-black text-cyan-300">
              PL
            </span>
            <span>
              <span className="block text-sm font-semibold tracking-wide">
                Panel Loader
              </span>
              <span className="block text-xs text-slate-400">
                Sistema de carga y verificación
              </span>
            </span>
          </button>

          {workspaceOpen ? (
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 sm:min-w-72">
                <span className="text-cyan-300">
                  <FamilyIcon family={selectedFamily} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-bold text-white">
                    {selectedFamilyOption.label}
                  </span>
                  <span className="block truncate text-[10px] text-slate-400">
                    {selectedInterfaceOption?.protocol}
                  </span>
                </span>
              </div>
              <button
                className="shrink-0 rounded-md border border-cyan-400/50 bg-cyan-400/10 px-3 py-2 text-xs font-bold text-cyan-200 transition hover:bg-cyan-400/20"
                onClick={() => setWorkspaceOpen(false)}
                type="button"
              >
                Cambiar estación
              </button>
            </div>
          ) : (
            <div className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
              Selección de estación
            </div>
          )}
        </div>
      </header>

      {workspaceOpen ? (
        selectedFamily === "serial" ? (
          <SerialMonitor />
        ) : selectedFamily === "esp32" ? (
          <ESPFlasher />
        ) : selectedFamily === "rp2" ? (
          <Rp2Programmer
            initialTransport={selectedInterface as "webusb" | "webhid"}
            key={`rp2-${selectedInterface}`}
          />
        ) : (
          <CortexProgrammer
            initialFamily={selectedFamily}
            initialTransport={
              selectedInterface as "auto" | "webusb" | "webhid"
            }
            key={`${selectedFamily}-${selectedInterface}`}
          />
        )
      ) : (
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
          <div className="mb-7 max-w-2xl">
            <div className="mb-2 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-700">
              Configuración rápida
            </div>
            <h1 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
              Elige tu estación o herramienta
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Selecciona la familia y la interfaz. El panel abrirá el
              programador correcto con la configuración ya aplicada.
            </p>
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(310px,0.9fr)]">
            <section className="rounded-lg border border-slate-300 bg-white p-4 shadow-sm sm:p-5">
              <StepHeading number="1">Familia o herramienta</StepHeading>
              <div className="grid gap-2 sm:grid-cols-2">
                {FAMILY_OPTIONS.map((family) => {
                  const selected = selectedFamily === family.id;

                  return (
                    <button
                      aria-pressed={selected}
                      className={`group flex min-h-28 items-start gap-3 rounded-md border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 ${
                        selected
                          ? "border-cyan-500 bg-cyan-50 shadow-sm"
                          : "border-slate-200 bg-white hover:border-slate-400 hover:bg-slate-50"
                      }`}
                      key={family.id}
                      onClick={() => chooseFamily(family.id)}
                      type="button"
                    >
                      <span
                        className={`grid size-10 shrink-0 place-items-center rounded-md border ${
                          selected
                            ? "border-cyan-300 bg-cyan-100 text-cyan-800"
                            : "border-slate-200 bg-slate-100 text-slate-500 group-hover:text-slate-700"
                        }`}
                      >
                        <FamilyIcon family={family.id} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-base font-black text-slate-950">
                            {family.label}
                          </span>
                          {selected ? (
                            <span className="rounded-full bg-cyan-500 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-white">
                              Seleccionada
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-[11px] font-semibold text-slate-500">
                          {family.maker} · {family.core}
                        </span>
                        <span className="mt-2 block text-xs text-slate-600">
                          {family.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="rounded-lg border border-slate-300 bg-white p-4 shadow-sm sm:p-5">
              <StepHeading number="2">Interfaz de comunicación</StepHeading>
              <div className="grid gap-2">
                {availableInterfaces.map((communication) => {
                  const selected = selectedInterface === communication.id;

                  return (
                    <button
                      aria-pressed={selected}
                      className={`flex items-center gap-3 rounded-md border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 ${
                        selected
                          ? "border-cyan-500 bg-cyan-50"
                          : "border-slate-200 hover:border-slate-400 hover:bg-slate-50"
                      }`}
                      key={communication.id}
                      onClick={() => setSelectedInterface(communication.id)}
                      type="button"
                    >
                      <span
                        className={`grid size-4 shrink-0 place-items-center rounded-full border ${
                          selected
                            ? "border-cyan-600 bg-cyan-500"
                            : "border-slate-300 bg-white"
                        }`}
                      >
                        {selected ? (
                          <span className="size-1.5 rounded-full bg-white" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-slate-950">
                            {communication.label}
                          </span>
                          {communication.recommended ? (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-emerald-800">
                              Recomendada
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block font-mono text-[10px] font-bold text-cyan-700">
                          {communication.protocol}
                        </span>
                        <span className="mt-1 block text-[11px] text-slate-500">
                          {communication.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  Estación preparada
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-black text-slate-950">
                      {selectedFamilyOption.label}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {selectedInterfaceOption?.protocol}
                    </div>
                  </div>
                  <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" />
                </div>
              </div>

              <button
                className="mt-3 flex w-full items-center justify-between rounded-md border border-cyan-500 bg-cyan-400 px-4 py-3 text-sm font-black text-slate-950 shadow-sm transition hover:bg-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-600 focus-visible:ring-offset-2"
                onClick={openWorkspace}
                type="button"
              >
                <span>
                  {selectedFamily === "serial"
                    ? "Abrir terminal serial"
                    : `Abrir programador ${selectedFamilyOption.label}`}
                </span>
                <span aria-hidden="true">→</span>
              </button>

              <p className="mt-3 text-center text-[10px] leading-4 text-slate-400">
                La última selección se recordará en este navegador.
              </p>
            </section>
          </div>
        </main>
      )}
    </div>
  );
}

export default App;
