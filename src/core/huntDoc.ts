// Reading a .hunt file the way the editor needs to: where the STEP blocks are,
// which lines are commands, and which line a result the engine reports belongs
// to. This is deliberately not a second parser — the engine owns the grammar —
// only enough structure to draw on.

export const RE_STEP = /^\s*(?:\d+\.\s*)?STEP\b\s*\d*\s*:?\s*(.*)$/i;
export const RE_DONE = /^\s*DONE\b\.?\s*$/i;
export const RE_HEADER = /^\s*@(\w+)\s*:\s*(.*)$/;
export const RE_COMMENT = /^\s*#/;
export const RE_BLOCK_OPEN = /^\s*\[(SETUP|TEARDOWN)\]\s*$/i;
export const RE_BLOCK_CLOSE = /^\s*\[END\s+(SETUP|TEARDOWN)\]\s*$/i;
export const RE_OPENER = /^\s*(IF|REPEAT|FOR\s+EACH|WHILE)\b.*:\s*$/i;
export const RE_BRANCH = /^\s*(ELIF\b.*|ELSE)\s*:\s*$/i;
export const RE_END = /^\s*END\s*(IF|REPEAT|WHILE|FOR|EACH)\b.*$/i;
export const RE_CALL = /^\s*CALL\s+(?:HOST|PYTHON|GO|JS|NODE)\s+([\w.\-]+)/i;

export interface HuntStep {
  /** The header as the engine reports it in `step_block`. */
  header: string;
  label: string;
  /** 0-based line of the header. */
  line: number;
  /** 0-based line of the last line that belongs to the block. */
  endLine: number;
}

export interface HuntCommand {
  line: number;
  /** Trimmed text, whitespace collapsed — what a reported step is matched on. */
  text: string;
  /** Index into `steps`, or -1 for a command outside any STEP. */
  step: number;
}

export interface HuntOutline {
  title: string;
  context: string;
  tags: string[];
  schedule: string;
  data: string;
  steps: HuntStep[];
  commands: HuntCommand[];
  /** Names used by CALL lines, with the line of each use. */
  calls: Array<{ name: string; line: number }>;
}

export const normalise = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** A list number in front of a command (`3. CLICK …`) is not part of it. */
const stripListNumber = (s: string): string => s.replace(/^\d+\.\s+/, '');

export function parseHunt(text: string): HuntOutline {
  const lines = text.split(/\r?\n/);
  const outline: HuntOutline = {
    title: '',
    context: '',
    tags: [],
    schedule: '',
    data: '',
    steps: [],
    commands: [],
    calls: [],
  };
  let current = -1;
  let lastContent = -1;

  const closeStep = (): void => {
    if (current >= 0) outline.steps[current].endLine = Math.max(outline.steps[current].line, lastContent);
  };

  lines.forEach((raw, line) => {
    if (!raw.trim() || RE_COMMENT.test(raw)) return;

    const header = raw.match(RE_HEADER);
    if (header) {
      const value = header[2].trim();
      switch (header[1].toLowerCase()) {
        case 'title':
          outline.title = value;
          break;
        case 'context':
          outline.context = value;
          break;
        case 'tags':
          outline.tags = value.split(',').map((t) => t.trim()).filter(Boolean);
          break;
        case 'schedule':
          outline.schedule = value;
          break;
        case 'data':
          outline.data = value;
          break;
      }
      return;
    }

    if (RE_DONE.test(raw)) {
      closeStep();
      current = -1;
      return;
    }

    const step = raw.match(RE_STEP);
    if (step) {
      closeStep();
      outline.steps.push({ header: normalise(raw), label: step[1].trim(), line, endLine: line });
      current = outline.steps.length - 1;
      lastContent = line;
      return;
    }

    lastContent = line;
    if (RE_BLOCK_OPEN.test(raw) || RE_BLOCK_CLOSE.test(raw)) return;

    const text = normalise(stripListNumber(raw.trim()));
    outline.commands.push({ line, text, step: current });
    const call = raw.match(RE_CALL);
    if (call) outline.calls.push({ name: call[1], line });
  });
  closeStep();
  return outline;
}

/**
 * Maps the steps an engine reports back onto lines.
 *
 * A result carries the step's text and its block, not its line. Steps arrive
 * in execution order, so the search starts just after the previous match and
 * wraps: a loop body is found again on its second pass, and two identical
 * lines in one file each get their own result.
 */
export class StepLocator {
  private cursor = 0;

  constructor(private readonly outline: HuntOutline) {}

  locate(stepText: string, block?: string): number | undefined {
    const wanted = normalise(stripListNumber(stepText.trim()));
    if (!wanted) return undefined;
    const cmds = this.outline.commands;
    const blockIndex = block
      ? this.outline.steps.findIndex((s) => s.header === normalise(block))
      : -1;

    const search = (requireBlock: boolean): number | undefined => {
      for (let n = 0; n < cmds.length; n++) {
        const i = (this.cursor + n) % cmds.length;
        if (cmds[i].text !== wanted) continue;
        if (requireBlock && cmds[i].step !== blockIndex) continue;
        this.cursor = i + 1;
        return cmds[i].line;
      }
      return undefined;
    };

    return (blockIndex >= 0 ? search(true) : undefined) ?? search(false);
  }

  /** The STEP block a line belongs to. */
  stepAt(line: number): HuntStep | undefined {
    return this.outline.steps.find((s) => line >= s.line && line <= s.endLine);
  }
}

const INDENT = 4;

/**
 * Re-indent a hunt: headers, STEP lines, block markers and DONE at the margin,
 * commands one level in, the body of IF and the loops one level further.
 *
 * Nesting is indentation-based in this language and END lines are optional, so
 * the existing indentation is the only record of where a block ends. It is
 * used as a hint for exactly that and for nothing else: a line that sits at or
 * left of its opener has left the block.
 */
export function formatHunt(lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  // Each open block: the indent its opener had in the source, and the indent
  // it was given.
  const stack: Array<{ was: number; now: number }> = [];

  for (const raw of lines) {
    const text = raw.trim();
    if (!text) {
      out.push('');
      continue;
    }
    const was = raw.length - raw.trimStart().length;
    const base = inside ? INDENT : 0;
    const popLeft = (inclusive: boolean): void => {
      while (stack.length && (inclusive ? was <= stack[stack.length - 1].was : was < stack[stack.length - 1].was)) {
        stack.pop();
      }
    };
    const depth = (): number => (stack.length ? stack[stack.length - 1].now + INDENT : base);

    if (RE_COMMENT.test(text)) {
      // A comment takes the level it sits at and closes nothing: one written
      // at the margin in the middle of a block must not end the block.
      const owner = [...stack].reverse().find((b) => b.was < was);
      out.push(' '.repeat(owner ? owner.now + INDENT : base) + text);
    } else if (RE_HEADER.test(text) && !inside) {
      out.push(text);
    } else if (RE_STEP.test(text) || RE_BLOCK_OPEN.test(text)) {
      stack.length = 0;
      inside = true;
      out.push(text);
    } else if (RE_DONE.test(text) || RE_BLOCK_CLOSE.test(text)) {
      stack.length = 0;
      inside = false;
      out.push(text);
    } else if (RE_OPENER.test(text)) {
      popLeft(true);
      const now = depth();
      stack.push({ was, now });
      out.push(' '.repeat(now) + text);
    } else if (RE_BRANCH.test(text) || RE_END.test(text)) {
      // Aligns with the opener it continues or closes.
      popLeft(false);
      const now = stack.length ? stack[stack.length - 1].now : base;
      if (RE_END.test(text)) stack.pop();
      else if (stack.length) stack[stack.length - 1].was = was;
      out.push(' '.repeat(now) + text);
    } else {
      popLeft(true);
      out.push(' '.repeat(depth()) + text);
    }
  }
  return out;
}
