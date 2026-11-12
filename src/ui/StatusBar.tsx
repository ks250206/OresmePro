import { revertExperiment } from "../app/actions";
import { experiment, kernel, useExperimentState, useKernelState, useUi } from "../app/session";

const DOT: Record<string, string> = {
  ready: "bg-[#2da44e]",
  busy: "bg-[#d4a72c]",
  starting: "bg-[#d4a72c]",
  failed: "bg-danger",
  unavailable: "bg-muted",
};

const buttonClass = "rounded border border-line bg-paper px-1.5 leading-4 hover:bg-chrome-2";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Says whether the experiment is saved in the browser, and offers what can be done if not. */
function SaveStatus() {
  const state = useExperimentState();
  switch (state.kind) {
    case "starting":
    case "idle":
      return null;
    case "off":
      return (
        <span
          className="text-muted"
          title="This browser gives the page no storage (a private window, perhaps). Use File › Save Experiment As… to keep your work."
        >
          Not kept in this browser
        </span>
      );
    case "saving":
      return <span className="text-muted">Saving…</span>;
    case "saved":
      return (
        <span className="text-muted" title="The experiment is kept in this browser as you work.">
          Saved {clock(state.at)}
        </span>
      );
    case "failed":
      return (
        <span className="flex items-center gap-1.5 text-danger" role="alert">
          <span className="max-w-[40ch] truncate" title={state.error}>
            Not saved: {state.error}
          </span>
          <button type="button" className={buttonClass} onClick={() => experiment.retry()}>
            Try Again
          </button>
        </span>
      );
    case "elsewhere":
      return (
        <span className="flex items-center gap-1.5 text-danger" role="alert">
          <span title="Another tab is saving this experiment. What you do here is not saved, so that neither tab replaces the other's work.">
            Open in another tab: not saved here
          </span>
          <button
            type="button"
            className={buttonClass}
            title="Save the experiment as it is in this tab from now on. The other tab stops saving."
            onClick={() => void experiment.takeOver()}
          >
            Save Here Instead
          </button>
        </span>
      );
    case "unread":
      return (
        <span className="flex items-center gap-1.5 text-danger" role="alert">
          <span title={state.error}>The saved experiment could not be read: not saved</span>
          {state.backup ? (
            <button type="button" className={buttonClass} onClick={() => void revertExperiment()}>
              Go Back to Backup
            </button>
          ) : null}
          <button
            type="button"
            className={buttonClass}
            title="Give up on what could not be read and save the experiment as it is in this tab."
            onClick={() => {
              if (window.confirm("Save over the experiment that could not be read?")) {
                experiment.startAfresh();
              }
            }}
          >
            Start Afresh
          </button>
        </span>
      );
  }
}

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
        <button type="button" className={buttonClass} onClick={() => kernel.interruptExecution()}>
          {state.interrupting ? "Restart Python" : "Interrupt"}{" "}
          <span className="text-muted">Ctrl+C</span>
        </button>
      ) : null}
      <span className="flex-1" />
      <span className="selectable font-mono text-muted">{readout}</span>
      <span className="flex shrink-0 items-center" aria-label="Saving" role="group">
        <SaveStatus />
      </span>
    </footer>
  );
}
