import { useEffect, useState } from "react";
import { newExperiment, switchExperiment } from "../app/actions";
import {
  browserEnvironment,
  deleteExperiment,
  listExperiments,
  type ExperimentInfo,
} from "../app/experiments";
import { experiment, showError, ui, useExperimentInfo } from "../app/session";
import { Button, Dialog, Field, TextInput } from "./controls";

const when = (at: number) =>
  at > 0
    ? new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "not saved yet";

/** The experiments kept in this browser: open another, rename this one, delete those done with. */
export function ExperimentsDialog() {
  const current = useExperimentInfo();
  const [list, setList] = useState<ExperimentInfo[] | null>(null);
  const [name, setName] = useState(current.name);
  const refresh = () => void listExperiments(browserEnvironment()).then(setList);
  useEffect(refresh, []);
  // The one open here is shown even before its first save has entered it in the list.
  const shown = [current, ...(list ?? []).filter((item) => item.id !== current.id)];
  const rename = () =>
    experiment.rename(name).then(refresh, (error: unknown) => showError("Could not rename", error));
  return (
    <Dialog title="Experiments" width={520} onClose={() => ui.set({ dialog: null })}>
      <p className="m-0 leading-relaxed text-muted">
        Experiments are kept in this browser as you work. Each tab works on one; another can be
        opened here.
      </p>
      <Field label="This one" group>
        <TextInput
          aria-label="Name of this experiment"
          className="min-w-0 flex-1"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void rename();
            }
          }}
        />
        <Button disabled={name.trim() === "" || name.trim() === current.name} onClick={rename}>
          Rename
        </Button>
      </Field>
      <div
        role="list"
        aria-label="Experiments"
        className="max-h-64 overflow-auto rounded border border-line bg-paper"
      >
        {shown.map((item) => (
          <div
            key={item.id}
            role="listitem"
            className="flex items-center gap-2 border-b border-line-soft px-2 py-1 last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
            <span className="text-muted">
              {item.id === current.id ? "open in this tab" : when(item.savedAt)}
            </span>
            {item.id === current.id ? null : (
              <>
                <Button onClick={() => void switchExperiment(item.id)}>Open</Button>
                <Button
                  onClick={() => {
                    if (
                      !window.confirm(`Delete the experiment "${item.name}" from this browser?`)
                    ) {
                      return;
                    }
                    deleteExperiment(browserEnvironment(), item.id).then(
                      refresh,
                      (error: unknown) => showError("Could not delete the experiment", error),
                    );
                  }}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
      <div>
        <Button onClick={() => void newExperiment()}>New Experiment</Button>
      </div>
    </Dialog>
  );
}
