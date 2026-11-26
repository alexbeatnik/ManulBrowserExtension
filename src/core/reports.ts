// Finding the HTML report a run wrote.
//
// Since 0.1.6 the engine writes one report per hunt — per data row for a hunt
// with @data: — as reports/report_<title>_<YYYYMMDD_HHMMSS>_<seq>.html, and no
// aggregate. Older engines wrote a single reports/manul_report.html. The
// newest of either is the one a person just asked for.

import * as fs from 'fs';
import * as path from 'path';

const REPORT = /^(?:report_.+|manul_report)\.html$/;

/** The most recently written report under `<root>/reports`, if there is one. */
export function latestReport(root: string): string | undefined {
  const dir = path.join(root, 'reports');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { file: string; mtime: number } | undefined;
  for (const name of names) {
    if (!REPORT.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs };
    } catch {
      // Removed while we looked.
    }
  }
  return best?.file;
}
