import { useState } from "react";
import CortexProgrammer from "./components/CortexProgrammer";
import ESPFlasher from "./components/ESPFlasher";
import Rp2Programmer from "./components/Rp2Programmer";

type AppSection = "cortex" | "rp2" | "esp32";

const sections = [
  {
    id: "cortex",
    label: "Cortex",
    activeClassName: "bg-cyan-400 text-slate-950 shadow-sm",
  },
  {
    id: "rp2",
    label: "RP2",
    activeClassName: "bg-indigo-400 text-slate-950 shadow-sm",
  },
  {
    id: "esp32",
    label: "ESP32",
    activeClassName: "bg-orange-500 text-white shadow-sm",
  },
] as const satisfies ReadonlyArray<{
  id: AppSection;
  label: string;
  activeClassName: string;
}>;

function App() {
  const [activeSection, setActiveSection] = useState<AppSection>("cortex");

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950 text-white shadow-sm">
        <div className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center justify-between gap-3 px-3 py-3 md:px-5">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg border border-cyan-400/30 bg-cyan-400/10 font-mono text-xs font-black text-cyan-300">
              PL
            </div>
            <div>
              <div className="text-sm font-semibold tracking-wide">
                Panel Loader
              </div>
              <div className="text-xs text-slate-400">
                Sistema de carga y verificación
              </div>
            </div>
          </div>

          <nav
            aria-label="Secciones principales"
            className="grid w-full grid-cols-3 rounded-md border border-slate-700 bg-slate-900 p-1 sm:w-auto sm:min-w-[420px]"
          >
            {sections.map((section) => (
              <button
                className={`rounded px-3 py-2 text-sm font-semibold transition ${
                  activeSection === section.id
                    ? section.activeClassName
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
                aria-current={activeSection === section.id ? "page" : undefined}
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                type="button"
              >
                {section.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {activeSection === "cortex" ? <CortexProgrammer /> : activeSection === "rp2" ? <Rp2Programmer /> : <ESPFlasher />}
    </div>
  );
}

export default App;
