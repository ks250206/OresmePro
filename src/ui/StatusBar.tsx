import { kernel, useKernelState, useUi } from "../app/session";

const DOT: Record<string, string> = {
  ready: "bg-[#2da44e]",
  busy: "bg-[#d4a72c]",
  starting: "bg-[#d4a72c]",
  failed: "bg-danger",
  unavailable: "bg-muted",
};

export function StatusBar() {
  const state = useKernelState();
  const readout = useUi((ui) => ui.readout);
  return (
    <footer className="flex h-[22px] shrink-0 items-center gap-3 border-t border-line bg-chrome px-2 text-[11.5px]">
      <span className="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
        {state.status === "starting" || state.status === "busy" ? (
          <span className="spinner" aria-hidden />
        ) : (
          <span className={`h-2 w-2 rounded-full ${DOT[state.status]}`} aria-hidden />
        )}
        <span className="truncate">
          {state.input !== null ? "Python is waiting for input in the command line" : state.message}
        </span>
      </span>
      {state.status === "busy" ? (
        <button
          type="button"
          className="rounded border border-line bg-paper px-1.5 leading-4 hover:bg-chrome-2"
          onClick={() => kernel.interruptExecution()}
        >
          {state.interrupting ? "Restart Python" : "Interrupt"}{" "}
          <span className="text-muted">Ctrl+C</span>
        </button>
      ) : null}
      <span className="flex-1" />
      <span className="selectable font-mono text-muted">{readout}</span>
    </footer>
  );
}
