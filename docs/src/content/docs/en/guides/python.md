---
title: Command history and Python scripting
sidebar:
  order: 10
---

## Recall commands

In the Command Window, use **↑ / ↓** to recall commands matching the typed prefix, or **Ctrl+R** to search. Some interface actions are echoed as Python. Check the target wave and window names before replaying a command that modifies data.

## Save scripts as procedures

Choose **Windows → New Procedure**, enter Python, and click **Run**. **Shift+Enter** executes the selection or current line, and **Ctrl+Enter** (**⌘+Enter** on macOS) executes the entire file. Procedures are stored in the experiment. Use `op.new_procedure(name, code)` to create one from Python.

The command session starts with `np` and `op` preloaded. Include `import numpy as np` and `import oresme as op` in a procedure to make its dependencies clear. SciPy, pandas, scikit-learn, and lmfit load on first use. Use **Python → Interrupt** for a long-running command. Restarting Python clears session variables and leaves the experiment's waves in the app.

## Apply changes together

Changes made inside `with op.atomic():` reach the experiment together, as one undo step, when the block ends without an exception. If the block raises, nothing it did is kept. Python inside the block sees its own changes; the interface shows none of them until the block ends.

```python
with op.atomic():
    corrected = op.make("corrected", raw.data - background.data)
    op.display(corrected)
```

Analyses that make waves and results, such as `op.fit`, `op.fit_peaks`, and `op.background`, each run in such a block. Changes made in the interface while a block runs are kept alongside the block's changes when they do not overlap. If a wave the block read has changed meanwhile, nothing is kept and `OresmeError` is raised. Graphs cannot be drawn or saved inside a block.

[Using the API](../../reference/) · [Procedure](../../reference/api/global/#procedure) · [atomic](../../reference/api/global/#atomic)
