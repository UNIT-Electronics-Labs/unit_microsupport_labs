import CortexProgrammer from "./components/CortexProgrammer";

function App() {
  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950 text-white shadow-sm">
        <div className="mx-auto flex w-[min(98vw,1800px)] flex-wrap items-center justify-between gap-3 px-3 py-3 md:px-5">
          <div>
            <div className="text-sm font-semibold tracking-wide">
              Internal Programmer
            </div>
            <div className="text-xs text-slate-400">
              PY32F003 CMSIS-DAP Programmer
            </div>
          </div>
        </div>
      </header>

      <CortexProgrammer />
    </div>
  );
}

export default App;
