# Changelog

## 0.1.1

Brought up to the `manul-browser` engine 0.1.6.

- `SWITCH TO TAB` is highlighted, completed and in the Step Palette, and so
  are `Double-click` and `Right-click` written with a hyphen.
- Inline comments after a step (`CLICK 'Save'  # the toolbar one`) are
  highlighted as comments. The engine reports such a step without its
  comment, and its result now still lands on its line; an `IF`, `ELSE` or
  loop line with a comment is formatted as a block.
- `manulBrowser.run.locale` passes `--locale`, so Chromium and Firefox ask
  pages for the same language.
- **Debug: Show Variables** (and a Variables button in the Run panel) lists
  the variables the hunt holds at a pause, from the engine's `vars` answer.
- **Open HTML Report** opens the newest `reports/report_*.html`. The engine
  writes one report per hunt now and no longer writes
  `reports/manul_report.html`.
- A run stopped at a pause is reported as stopped, not as a pass.
- Command descriptions, `manul.config.json` validation and completion are
  regenerated from the 0.1.6 contracts: `locale`, `disable_cache`,
  `browser_mode`, `verbose`, `debug_mode`, `break_lines`, `tags` and
  `verify_max_retries` are new; `semantic_cache_enabled`,
  `custom_controls_dirs`, `log_name_maxlen` and `log_thought_maxlen`, which
  the engine ignores, are gone. `scripts/sync-contracts.mjs` regenerates them.
- **Check Setup** says when the engine is older than 0.1.6 and what that
  costs.
- The Hooks view reads `@manul.custom_control("Checkout", "Coupon")` the way
  Python does, page first: it used to show the page as the target. A page of
  `*` (or `manul.ANY_PAGE`) is shown as every page, in Python and JavaScript.
- **Insert Step** and the Step Palette keep a step inside its block on a blank
  line: it used to land at the margin, outside the `STEP`.

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
