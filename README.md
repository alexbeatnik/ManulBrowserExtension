# Manul Browser for VS Code

Write browser automation in plain English and run it from the editor.

```
STEP 1: Sign in
    NAVIGATE to https://www.saucedemo.com/
    FILL 'Username' field with 'standard_user'
    FILL 'Password' field with 'secret_sauce'
    CLICK 'Login' button
    VERIFY that 'Products' is present
```

This is the editor side of [manul-browser](https://github.com/alexbeatnik/manul-browser):
one engine, written in Go, that resolves elements by the label a person sees
rather than by selector. The extension finds that engine, runs `.hunt` files
with it, and shows what happened on the lines it happened to.

## Works with whichever way you installed the engine

There is one engine and three ways to get it. The extension looks for all of
them, in this order, and uses the first that actually runs:

| Installed with | Where it is found |
|---|---|
| `npm install manul-browser` | `node_modules/@manul-browser/engine-<os>-<cpu>`, from the workspace folder upwards |
| `pip install manul-browser` | `.venv`, `venv`, `env` or `.env` in the workspace, the active `VIRTUAL_ENV`, or `manulBrowser.pythonPath` |
| A Go build or a release archive | `manul` in the workspace (`./`, `bin/`, `core/`), `$GOBIN`, `$GOPATH/bin`, `~/go/bin` |
| Anything on `PATH` | resolved through pip's and npm's launchers to the binary behind them |

`manulBrowser.enginePath` overrides the search. **Manul: Select Engine** lists
everything that was found and lets you pick; the status bar shows which one is
in use.

Different engine versions are handled by asking, not by assuming: the
extension reads the installed engine's `--help` and leaves out options that
build does not have, and it merges whatever `manul schema` reports into the
command list, so a newer engine's verbs show up in completion without an
extension update.

## Hooks are picked up for you

A hook script holds what a `.hunt` file cannot say: custom controls, `CALL`
handlers, and suite hooks such as `before_all`.

```python
# manul_hooks.py
import manul

@manul.before_all
def login(ctx):
    ctx.set("token", fetch_token())     # {token} in every hunt

manul.serve_hooks()
```

The engine only uses a hook script it is given with `--hooks`. Run a hunt
without the flag and `{token}` stays `{token}`. The extension passes the flag
on every run:

- **Which script** — the nearest `manul_hooks.py`, `manul_hooks.mjs`,
  `manul_hooks.js` or `manul_hooks.cjs` at or above the hunt file, no higher
  than the workspace folder. `manulBrowser.hooks.path` names one explicitly;
  `manulBrowser.hooks.enabled` turns pickup off.
- **Which interpreter** — a Python script runs under the environment the engine
  came from, or the first environment in the workspace that has the `manul`
  package, not under whatever `python` happens to be on `PATH`. That mismatch
  is the usual reason a hook script "does not work": it dies on `import manul`
  before it can say anything.
- **What it registers** — the **Hooks** view lists each script's suite hooks,
  `CALL` handlers and custom controls, and jumps to them. In a hunt,
  `CALL HOST <name>` completes from that list and Go to Definition opens the
  handler; `{` completes the variables the script publishes.
- **What is wrong with it** — a script that never calls `serve_hooks()` /
  `serveHooks()` is flagged before you run it, because the engine would start
  it, wait, and give up.

**Manul: Create Hook Script** writes a starting point in Python or JavaScript.

One thing to know: each hunt file is run as its own engine process, so
`before_all` and `after_all` run once per file, not once for a whole Test
Explorer run. To run a folder as a single suite, right-click it in the
explorer and choose **Manul: Run in Terminal**.

## Running

- **Run** / **Debug** in the editor title, the CodeLens on the first line, the
  explorer context menu, or `Ctrl+Alt+R`.
- The **Test Explorer** lists every `.hunt` file with its `STEP` blocks, runs
  them — several at once if `manulBrowser.run.workers` says so — and reports
  each block.
- After a run every executed line carries its outcome and duration. Hover a
  line for the detail: the error, the candidates the engine ranked for that
  step and why the winner won, and the screenshot if one was taken.
- The **Run** panel in the Manul Browser side bar shows the engine, the hook
  script and the last result, and holds the options: browser, visible or
  headless, screenshots, retries, HTML report.

Options left on **From config** are not passed at all, so `manul.config.json`
decides. That file gets completion and validation.

## Debugging

Set breakpoints in the gutter and choose **Debug**. With no breakpoints the
run pauses before every step.

| | |
|---|---|
| `F10` | run this step, pause before the next |
| `F5` | continue to the next breakpoint |
| `Shift+F5` | stop |
| **Explain** | score the target of the paused step without running it |
| **Show target** | scroll the browser to the element that would be used |

Debug runs always show the browser window.

## Writing

- Syntax highlighting, outline and formatting for `.hunt` files.
- Completion for every command, header and block, with placeholders.
- The **Step Palette** view: the same list, searchable, one click from the
  cursor. **Manul: Insert Step…** is the keyboard version.
- **New Hunt File**, **Record a Hunt from a URL** and **Scan a URL into a
  Draft Hunt** create files in your tests folder.

## When something does not work

Run **Manul: Check Setup (Doctor)**. It checks, and says in plain words:
which engines were found and which one runs, whether that build has the
options the extension needs, which hook script a run would get, and whether
the interpreter for it can actually import the binding.

## Settings

| Setting | Default | |
|---|---|---|
| `manulBrowser.enginePath` | *(find it)* | Path to the `manul` binary |
| `manulBrowser.pythonPath` | *(find it)* | Interpreter or venv folder for the engine and `.py` hooks |
| `manulBrowser.nodePath` | `node` | Node for `.js` / `.mjs` hooks |
| `manulBrowser.hooks.enabled` | `true` | Pass a hook script to every run |
| `manulBrowser.hooks.path` | *(find it)* | A specific hook script |
| `manulBrowser.run.browser` | `config` | `chromium`, `firefox`, or leave it to the config file |
| `manulBrowser.run.channel` | | `chrome`, `msedge`, `firefox-dev`, … |
| `manulBrowser.run.headless` | `config` | `on`, `off`, or leave it to the config file |
| `manulBrowser.run.retries` | `0` | Re-run a failed hunt; a later pass is reported as flaky |
| `manulBrowser.run.screenshot` | `config` | `on-fail`, `always`, `none` |
| `manulBrowser.run.htmlReport` | `false` | Write `reports/manul_report.html` |
| `manulBrowser.run.explain` | `false` | Print score breakdowns |
| `manulBrowser.run.workers` | `1` | Hunt files run at once from the Test Explorer |
| `manulBrowser.run.extraArgs` | `[]` | Extra engine arguments |
| `manulBrowser.run.env` | `{}` | Extra environment variables |
| `manulBrowser.testsHome` | `tests` | Where new hunt files go |
| `manulBrowser.inlineResults` | `true` | Show outcomes at the end of each line |

## Requirements

- VS Code 1.90 or later.
- A `manul-browser` engine, 0.1.2 or later for everything described here.
  Older builds run, with the options they lack left out.
- Chrome, Chromium, Edge or Firefox for the engine to drive.

## Development

```bash
npm install
npm test            # unit tests, no browser needed
npm run package     # builds the .vsix
```

A push to `main` whose `package.json` version has no GitHub Release yet gets
one, with the `.vsix` attached: bumping the version is what releases.

`src/core` has no dependency on VS Code and holds everything worth testing in
isolation: finding the engine, finding and reading hook scripts, mapping the
engine's results back to lines. `src/test/integration` runs inside a real VS
Code against a real engine; its header says how to start it.

## License

Apache 2.0 — Copyright 2026 Oleksii Poliakov. See [LICENSE](LICENSE).
