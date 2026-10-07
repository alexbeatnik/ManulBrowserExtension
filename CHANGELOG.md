# Changelog

## 0.1.0

First release, for the `manul-browser` engine. It replaces the ManulEngine
extension, which drove the engine's Python predecessor.

- Finds the engine however it was installed — the npm package, the Python
  wheel, a Go build or release binary, or `PATH` — and adapts to the options
  that build has.
- Picks up hook scripts (`manul_hooks.py`, `manul_hooks.mjs`, `.js`, `.cjs`)
  and passes them to every run, with an interpreter that can import the
  binding. A Hooks view lists what each script registers.
- Test Explorer integration with per-`STEP` results, parallel files and
  retries.
- Results on the lines they belong to, with the engine's candidate ranking on
  hover.
- Breakpoint and step-through debugging with Explain and Show Target.
- Run panel, Step Palette, completion from the installed engine's own schema,
  formatting, outline.
- Check Setup (Doctor), Record, Scan, New Hunt File.
- Validation and completion for `manul.config.json`.
