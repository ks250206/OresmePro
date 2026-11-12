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

[Using the API](../../reference/) · [Procedure](../../reference/api/global/#procedure)
