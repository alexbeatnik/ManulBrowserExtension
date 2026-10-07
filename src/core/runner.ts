// Running a hunt and listening to it.
//
// The engine is started with `--jsonl`: stdout then carries one JSON object per
// finished step and one for the whole hunt, and everything meant for a person
// goes to stderr. While debugging, stdout also carries the pause markers, and
// stdin carries the answers. This module turns that into events and knows
// nothing about VS Code.

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { EngineInfo, supports } from './engine';

export const PAUSE_MARKER = '\x00MANUL_DEBUG_PAUSE\x00';
export const EXPLAIN_MARKER = '\x00MANUL_EXPLAIN_NEXT\x00';

export interface CandidateResult {
  rank: number;
  xpath: string;
  tag: string;
  role?: string;
  visible_text?: string;
  aria_label?: string;
  placeholder?: string;
  id?: string;
  is_visible: boolean;
  is_enabled: boolean;
  score: Record<string, number>;
  chosen?: boolean;
}

export interface StepResult {
  step: string;
  step_index: number;
  step_block?: string;
  command_type: string;
  page_url?: string;
  target_query?: string;
  type_hint?: string;
  candidates_considered?: number;
  ranked_candidates?: CandidateResult[];
  winner_xpath?: string;
  winner_score?: number;
  action_performed?: string;
  action_value?: string;
  success: boolean;
  error?: string;
  failure_reason?: string;
  duration_ms: number;
  screenshot_path?: string;
}

export interface HuntResult {
  hunt_file: string;
  title?: string;
  total_steps: number;
  passed: number;
  failed: number;
  results: StepResult[];
  total_duration_ms: number;
  success: boolean;
  soft_errors?: string[];
  attempts?: number;
  flaky?: boolean;
}

export interface PauseEvent {
  step: string;
  /** 1-based index of the command about to run. */
  idx: number;
}

export interface ExplainEvent {
  step: string;
  score: number;
  confidence_label?: string;
  target_found?: boolean;
  target_element?: string | null;
  explanation?: string;
  risk?: string;
  suggestion?: string | null;
  heuristic_match?: string | null;
}

export type DebugCommand = 'next' | 'continue' | 'debug-stop' | 'abort' | 'highlight' | 'explain-next';

export interface RunOptions {
  /** `chromium`, `firefox`, or empty to leave it to the config file. */
  browser?: string;
  channel?: string;
  /** Undefined leaves it to the config file. */
  headless?: boolean;
  retries?: number;
  screenshot?: string;
  htmlReport?: boolean;
  explain?: boolean;
  tags?: string;
  hooks?: string;
  /** 1-based lines to pause on. */
  breakLines?: number[];
  /** Pause before every step. */
  stepThrough?: boolean;
  extraArgs?: string[];
}

/**
 * The arguments for one run. Options the installed engine does not list in its
 * help are left out, and reported, rather than passed and refused: an older
 * engine should run the hunt it can run.
 */
export function buildArgs(
  target: string,
  opts: RunOptions,
  engine?: EngineInfo,
): { args: string[]; dropped: string[] } {
  const args = ['run', target];
  const dropped: string[] = [];
  const add = (flag: string, ...value: string[]): void => {
    if (supports(engine, flag)) args.push(`--${flag}`, ...value);
    else dropped.push(`--${flag}`);
  };

  add('jsonl');
  if (opts.browser) add('browser', opts.browser);
  if (opts.channel) add('channel', opts.channel);
  if (opts.headless === true) add('headless');
  if (opts.headless === false && supports(engine, 'headless')) args.push('--headless=false');
  if (opts.retries && opts.retries > 0) add('retries', String(opts.retries));
  if (opts.screenshot) add('screenshot', opts.screenshot);
  if (opts.htmlReport) add('html-report');
  if (opts.explain) add('explain');
  if (opts.tags) add('tags', opts.tags);
  if (opts.hooks) add('hooks', opts.hooks);
  if (opts.breakLines?.length) add('break-lines', opts.breakLines.join(','));
  else if (opts.stepThrough) add('debug');
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return { args, dropped };
}

/** Splits a stream into lines, holding back whatever has no newline yet. */
export class LineSplitter {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, ''));
  }

  flush(): string[] {
    const rest = this.pending;
    this.pending = '';
    return rest ? [rest] : [];
  }
}

export type StdoutEvent =
  | { kind: 'step'; data: StepResult }
  | { kind: 'result'; data: HuntResult }
  | { kind: 'pause'; data: PauseEvent }
  | { kind: 'explain'; data: ExplainEvent }
  | { kind: 'text'; data: string };

/** One line of the engine's stdout, classified. Never throws. */
export function parseStdoutLine(line: string): StdoutEvent | undefined {
  if (!line) return undefined;
  const marker = (m: string): string | undefined => {
    const at = line.indexOf(m);
    return at >= 0 ? line.slice(at + m.length) : undefined;
  };
  const pause = marker(PAUSE_MARKER);
  if (pause !== undefined) {
    try {
      return { kind: 'pause', data: JSON.parse(pause) as PauseEvent };
    } catch {
      return { kind: 'pause', data: { step: '', idx: 0 } };
    }
  }
  const explain = marker(EXPLAIN_MARKER);
  if (explain !== undefined) {
    try {
      return { kind: 'explain', data: JSON.parse(explain) as ExplainEvent };
    } catch {
      return undefined;
    }
  }
  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line) as { event?: string; data?: unknown };
      if (obj.event === 'step' && obj.data) return { kind: 'step', data: obj.data as StepResult };
      if (obj.event === 'result' && obj.data) return { kind: 'result', data: obj.data as HuntResult };
    } catch {
      // Not ours; fall through and show it.
    }
  }
  return { kind: 'text', data: line };
}

export interface HuntRunEvents {
  step: [StepResult];
  result: [HuntResult];
  pause: [PauseEvent];
  explain: [ExplainEvent];
  /** Human-readable output: the engine's stderr and anything unrecognised. */
  log: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null; error?: Error }];
}

/** One engine process running one target. */
export class HuntRun extends EventEmitter<HuntRunEvents> {
  private child?: ChildProcess;
  private killed = false;

  constructor(
    private readonly enginePath: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    super();
  }

  get commandLine(): string {
    return [this.enginePath, ...this.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  }

  start(): void {
    const child = spawn(this.enginePath, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const out = new LineSplitter();
    const err = new LineSplitter();
    const onStdout = (line: string): void => {
      const ev = parseStdoutLine(line);
      if (!ev) return;
      if (ev.kind === 'text') this.emit('log', ev.data);
      else if (ev.kind === 'step') this.emit('step', ev.data);
      else if (ev.kind === 'result') this.emit('result', ev.data);
      else if (ev.kind === 'pause') this.emit('pause', ev.data);
      else this.emit('explain', ev.data);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => out.push(chunk).forEach(onStdout));
    child.stderr?.on('data', (chunk: string) => err.push(chunk).forEach((l) => this.emit('log', l)));
    // An engine that exits while we are writing to it must not take the
    // extension host down with an unhandled EPIPE.
    child.stdin?.on('error', () => undefined);

    let reported = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (reported) return;
      reported = true;
      out.flush().forEach(onStdout);
      err.flush().forEach((l) => this.emit('log', l));
      this.emit('exit', { code, signal, error });
    };
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
  }

  /** Answer a debug pause. */
  send(command: DebugCommand | string): void {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin?.write(`${command}\n`);
  }

  /**
   * Stop the run. Asks first — the engine closes the browser it launched on
   * the way out — and kills if it has not gone shortly after.
   */
  stop(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || this.killed) return;
    this.killed = true;
    // Only a paused engine reads this, but that is exactly the case in which
    // it can still leave cleanly.
    this.send('abort');

    const force = (): void => {
      if (child.exitCode !== null || child.pid === undefined) return;
      if (process.platform === 'win32') {
        // Windows has no signal to ask with, and killing only the engine
        // would orphan the browser it launched: take the whole tree.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () =>
          child.kill(),
        );
      } else {
        child.kill('SIGKILL');
      }
    };
    if (process.platform === 'win32') {
      setTimeout(force, 800).unref();
    } else {
      child.kill('SIGTERM');
      setTimeout(force, 3000).unref();
    }
  }

  get stopped(): boolean {
    return this.killed;
  }
}

/** `1234` → `1.2s`, `87` → `87ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Strips ANSI colour codes; an output channel shows them as noise. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
