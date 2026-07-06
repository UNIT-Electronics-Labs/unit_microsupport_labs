import { useState } from "react";
import CortexProgrammer from "./components/CortexProgrammer";
import ESPFlasher from "./components/ESPFlasher";

type AppSection = "cortex" | "esp32";

const sections = [
  { id: "cortex", label: "Cortex" },
  { id: "esp32", label: "ESP32" },
] as const satisfies ReadonlyArray<{ id: AppSection; label: string }>;

function App() {
  const [activeSection, setActiveSection] = useState<AppSection>("cortex");

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950 text-white shadow-sm">
        <div className="mx-auto flex w-[min(98vw,1800px)] flex-wrap items-center justify-between gap-3 px-3 py-3 md:px-5">
          <div>
            <div className="text-sm font-semibold tracking-wide">
              Internal Programmer
            </div>
            <div className="text-xs text-slate-400">
              Cortex CMSIS-DAP / ESP32 Web Serial
            </div>
          </div>

          <nav
            aria-label="Secciones principales"
            className="grid w-full grid-cols-2 rounded-md border border-slate-700 bg-slate-900 p-1 sm:w-auto sm:min-w-[320px]"
          >
            {sections.map((section) => (
              <button
                className={`rounded px-3 py-2 text-sm font-semibold transition ${
                  activeSection === section.id
                    ? "bg-cyan-400 text-slate-950 shadow-sm"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`}
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

      {activeSection === "cortex" ? <CortexProgrammer /> : <ESPFlasher />}
    </div>
  );
}

export default App;
