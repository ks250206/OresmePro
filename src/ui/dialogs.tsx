import { lazy, Suspense, useEffect, useState } from "react";
import { ui, useDoc, useUi, type DialogRequest } from "../app/session";
import { dialogKey } from "./dialogKey";
import { isTimeZone, timeZone } from "../core/plot/ticks";
import {
  Dialog,
  Field,
  focusInvalidField,
  InvalidFieldContext,
  Select,
  TextInput,
} from "./controls";
import { AttributesDialog } from "./AttributesDialog";
import { ExperimentsDialog } from "./ExperimentsDialog";
import { PackagesDialog } from "./PackagesDialog";
import { TemplateEditorDialog } from "./TemplateEditor";
import {
  CloseWindowDialog,
  LinkGraphsDialog,
  NewProcedureDialog,
  RenameWindowDialog,
  SaveExperimentDialog,
  UnsavedLeaveDialog,
} from "./WindowDialogs";
import { GraphTemplatesDialog, SaveGraphTemplateDialog } from "./GraphTemplateDialogs";
import { ImportDialog } from "./ImportDialog";
import { NewGraphDialog } from "./NewGraphDialog";
import { ResultsDialog } from "./ResultsDialog";
import { PluginsDialog } from "./PluginsDialog";
import { TemplatesDialog } from "./TemplatesDialog";
import { SetWaveValuesDialog } from "./SetWaveValuesDialog";
import {
  AddAxisDialog,
  AddTextDialog,
  DrawTextDialog,
  GraphScriptDialog,
  MatrixPlotDialog,
  ModifyAxisDialog,
  ModifyContourDialog,
  ModifyDrawingDialog,
  ModifyGraphDialog,
  ModifyImageDialog,
  ModifyTraceDialog,
} from "./GraphDialogs";
import { ArrangeLayoutDialog, PageTextDialog } from "./LayoutDialogs";
import {
  MakeWavesDialog,
  NameDialog,
  NewTableDialog,
  TableColumnsDialog,
  WaveScalingDialog,
  WaveTypeDialog,
} from "./WaveDialogs";
import { close, submit } from "./dialogParts";

/**
 * Dialogs opened seldom, and large: loaded the first time one is opened,
 * not with the app.
 */
const analysis = () => import("./AnalysisDialogs");
const CurveFitDialog = lazy(() => analysis().then((m) => ({ default: m.CurveFitDialog })));
const AnalysisDialog = lazy(() => analysis().then((m) => ({ default: m.AnalysisDialog })));
const BackgroundDialog = lazy(() => analysis().then((m) => ({ default: m.BackgroundDialog })));
const OnsetDialog = lazy(() => analysis().then((m) => ({ default: m.OnsetDialog })));
const StylesDialog = lazy(() =>
  import("./StylesDialog").then((m) => ({ default: m.StylesDialog })),
);

/** Chooses the time zone dates are shown and typed in. */
function TimeZoneDialog() {
  const current = useDoc((state) => state.timeZone);
  const [choice, setChoice] = useState(
    current === "UTC" || current === "local" ? current : "other",
  );
  const [name, setName] = useState(current === "UTC" || current === "local" ? "" : current);
  const zone = choice === "other" ? name.trim() : choice;
  const valid = isTimeZone(zone);
  const here = timeZone("local").label;
  return (
    <Dialog
      title="Time Zone for Dates"
      width={400}
      onClose={close}
      submitDisabled={!valid || zone === current}
      onSubmit={() => submit({ op: "setTimeZone", zone })}
    >
      <p className="m-0 leading-relaxed text-muted">
        Date waves hold moments in time. This sets the clock they are read on: on graph axes, in
        tables, and for dates typed or loaded without an offset.
      </p>
      <Field label="Show dates in">
        <Select
          aria-label="Time zone"
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value="UTC">UTC</option>
          <option value="local">This computer's zone ({here})</option>
          <option value="other">Another zone…</option>
        </Select>
      </Field>
      {choice === "other" ? (
        <Field label="Zone name" name="zone">
          <TextInput
            aria-label="Zone name"
            aria-invalid={name.trim() !== "" && !valid}
            className="flex-1"
            placeholder="Asia/Tokyo"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      ) : null}
    </Dialog>
  );
}

function AboutDialog() {
  return (
    <Dialog title="About OresmePro" onClose={close} width={460}>
      <p className="selectable m-0 text-[13px]">
        <b>OresmePro</b> <span aria-label="Version">{__APP_VERSION__}</span>
        <span className="text-muted"> · Python (Pyodide {__PYODIDE_VERSION__})</span>
      </p>
      <p className="selectable m-0 leading-relaxed">
        OresmePro is named after <b>Nicole Oresme</b> (c. 1320&ndash;1382), the French scholar
        credited with drawing the first graphs: in the 1350s he plotted how a quantity varies by
        setting its intensity (<i>latitudo</i>) against its extent (<i>longitudo</i>), some three
        centuries before Descartes.
      </p>
      <div className="selectable grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
        <b>Enter</b>
        <span>Run the command line (Shift+Enter: new line)</span>
        <b>&uarr; / &darr;</b>
        <span>Earlier commands starting with what you typed</span>
        <b>Ctrl+R</b>
        <span>Search the history</span>
        <b>&rarr;</b>
        <span>Accept the greyed-out suggestion</span>
        <b>Tab</b>
        <span>Complete a Python name</span>
        <b>Ctrl+C</b>
        <span>Interrupt running Python</span>
        <b>Drag in a graph</b>
        <span>Marquee, then choose Expand or Shrink</span>
        <b>Wheel / Alt+drag</b>
        <span>Zoom and pan a graph</span>
        <b>Double-click</b>
        <span>An axis or trace, to modify it</span>
      </div>
    </Dialog>
  );
}

function renderDialog(dialog: DialogRequest) {
  switch (dialog.kind) {
    case "plugins":
      return <PluginsDialog />;
    case "newGraph":
      return <NewGraphDialog />;
    case "appendTraces":
      return <NewGraphDialog append={dialog.graph} />;
    case "matrixPlot":
      return <MatrixPlotDialog plot={dialog.plot} graph={dialog.graph} />;
    case "newTable":
      return <NewTableDialog />;
    case "tableColumns":
      return <TableColumnsDialog table={dialog.table} mode={dialog.mode} />;
    case "modifyDrawing":
      return <ModifyDrawingDialog graph={dialog.graph} drawing={dialog.drawing} />;
    case "drawText":
      return (
        <DrawTextDialog
          graph={dialog.graph}
          point={dialog.point}
          coords={dialog.coords}
          hAxis={dialog.hAxis}
          vAxis={dialog.vAxis}
        />
      );
    case "makeWaves":
      return <MakeWavesDialog folder={dialog.folder} />;
    case "modifyTrace":
      return <ModifyTraceDialog graph={dialog.graph} trace={dialog.trace} />;
    case "modifyAxis":
      return <ModifyAxisDialog graph={dialog.graph} axis={dialog.axis} />;
    case "modifyImage":
      return <ModifyImageDialog graph={dialog.graph} image={dialog.image} />;
    case "modifyContour":
      return <ModifyContourDialog graph={dialog.graph} contour={dialog.contour} />;
    case "addAxis":
      return <AddAxisDialog graph={dialog.graph} />;
    case "modifyGraph":
      return <ModifyGraphDialog graph={dialog.graph} />;
    case "addText":
      return <AddTextDialog graph={dialog.graph} />;
    case "editAnnotation":
      return <AddTextDialog graph={dialog.graph} annotation={dialog.annotation} />;
    case "renameWave":
      return <NameDialog target={dialog.wave} mode="rename" />;
    case "duplicateWave":
      return <NameDialog target={dialog.wave} mode="duplicate" />;
    case "newFolder":
      return <NameDialog target={dialog.parent} mode="newFolder" />;
    case "renameFolder":
      return <NameDialog target={dialog.folder} mode="renameFolder" />;
    case "waveScaling":
      return <WaveScalingDialog wave={dialog.wave} />;
    case "waveType":
      return <WaveTypeDialog wave={dialog.wave} />;
    case "setWaveValues":
      return <SetWaveValuesDialog wave={dialog.wave} />;
    case "curveFit":
      return <CurveFitDialog wave={dialog.wave} />;
    case "analysis":
      return <AnalysisDialog operation={dialog.operation} wave={dialog.wave} />;
    case "background":
      return <BackgroundDialog wave={dialog.wave} />;
    case "onset":
      return <OnsetDialog wave={dialog.wave} />;
    case "graphScript":
      return <GraphScriptDialog graph={dialog.graph} />;
    case "styles":
      return <StylesDialog graph={dialog.graph} />;
    case "saveGraphTemplate":
      return <SaveGraphTemplateDialog graph={dialog.graph} />;
    case "graphTemplates":
      return <GraphTemplatesDialog template={dialog.template} />;
    case "timeZone":
      return <TimeZoneDialog />;
    case "pageText":
      return <PageTextDialog layout={dialog.layout} item={dialog.item} />;
    case "arrangeLayout":
      return <ArrangeLayoutDialog layout={dialog.layout} items={dialog.items} />;
    case "importData":
      // Keyed by the file: the next file starts from its own preset, not this one's choices.
      return (
        <ImportDialog
          key={`${dialog.file.name}:${dialog.rest.length}`}
          file={dialog.file}
          rest={dialog.rest}
        />
      );
    case "results":
      return <ResultsDialog {...(dialog.result ? { focus: dialog.result } : {})} />;
    case "templates":
      return (
        <TemplatesDialog
          {...(dialog.template ? { template: dialog.template } : {})}
          {...(dialog.run ? { run: dialog.run } : {})}
        />
      );
    case "experiments":
      return <ExperimentsDialog />;
    case "linkGraphs":
      return <LinkGraphsDialog graph={dialog.graph} />;
    case "attributes":
      return <AttributesDialog targets={dialog.targets} />;
    case "editTemplate":
      return <TemplateEditorDialog template={dialog.template} />;
    case "packages":
      return <PackagesDialog />;
    case "saveExperiment":
      return <SaveExperimentDialog />;
    case "unsavedLeave":
      return <UnsavedLeaveDialog target={dialog.target} />;
    case "closeWindow":
      return <CloseWindowDialog name={dialog.name} />;
    case "renameWindow":
      return <RenameWindowDialog name={dialog.name} />;
    case "newProcedure":
      return <NewProcedureDialog />;
    case "about":
      return <AboutDialog />;
  }
}

export function DialogHost() {
  const dialog = useUi((state) => state.dialog);
  const alert = useUi((state) => state.alert);
  const invalidField = useUi((state) => state.invalidField);
  const key = dialog ? dialogKey(dialog) : null;
  // The mark is for the dialog that is open: closing it, or opening another, takes it away.
  useEffect(
    () => () => {
      if (ui.get().invalidField !== null) ui.set({ invalidField: null });
    },
    [key],
  );
  return (
    <>
      {dialog ? (
        <div
          key={key}
          // Changing anything in the dialog takes the mark away: it was about the value refused.
          onInput={() => {
            if (ui.get().invalidField !== null) ui.set({ invalidField: null });
          }}
        >
          <InvalidFieldContext.Provider value={invalidField}>
            <Suspense fallback={null}>{renderDialog(dialog)}</Suspense>
          </InvalidFieldContext.Provider>
        </div>
      ) : null}
      {alert ? (
        <Dialog
          title={alert.title}
          width={380}
          onClose={() => {
            ui.set({ alert: null });
            // Back in the dialog, at the row to put right.
            requestAnimationFrame(() => focusInvalidField());
          }}
        >
          <p role="alert" className="selectable m-0 whitespace-pre-wrap leading-relaxed">
            {alert.message}
          </p>
        </Dialog>
      ) : null}
    </>
  );
}
