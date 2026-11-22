// mend: one command-line tool that applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool-call edits) to a
// tree of text files, exactly as SPEC.md says. Node 22, standard library only.
// Run as `node main.ts [options] [PATCH]`. When MAKEFUN_ENV_URL is set the
// trial hand-over at the bottom runs instead (see runner.ts beside this file).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 parse fault at patch line `line` (1-based). */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One failed edit: exit 1 prints `error: <code> <path>` for it. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file as lines plus its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** How one line compares at a matching tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in `lines` at `tier` (overlaps allowed). */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const k = oldLines.length;
  if (k === 0 || k > lines.length) return out;
  for (let i = 0; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) where O occurs, with its positions. */
function findTier(
  lines: string[],
  oldLines: string[],
  strict: boolean,
  from: number = 0,
): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(lines, oldLines, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a replacement: a context line is the file's own matched line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oldIndex: number; // index into O when ctx, else -1
}

/**
 * The lines that replace O's k lines at `at`: context lines come from the file,
 * other lines of N are re-indented at tier 2 (F for P, SPEC.md section 5).
 */
function replacement(
  fileLines: string[],
  at: number,
  oldLines: string[],
  newLines: NewLine[],
  tier: number,
): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && oldLines.length > 0) {
    f = leadingWs(fileLines[at] ?? '');
    p = leadingWs(oldLines[0]!);
  }
  return newLines.map((e) => {
    if (e.ctx) return fileLines[at + e.oldIndex]!;
    if (tier === 2) {
      const t = e.text;
      if (t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return e.text;
  });
}

/** The tree as the edits leave it; `now` holds changed paths (null: deleted). */
class Tree {
  private readonly seen = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, for the `R old -> new` output lines. */
  readonly moves: { old: string; new: string }[] = [];

  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file the tree holds, or throw the edit's failure for it. */
function needFile(tree: Tree, p: string): string {
  if (!isSafePath(p)) throw new EditFault('unsafe', p);
  const t = tree.get(p);
  if (t === null) throw new EditFault('missing', p);
  return t;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const lineNo = o.insert_line;
    const added = splitPatch(o.new_str);
    return (tree) => {
      const before = needFile(tree, p);
      const f = splitFile(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new EditFault('no-match', p);
      f.lines.splice(lineNo, 0, ...added);
      tree.now.set(p, joinFile(f));
    };
  }

  return null;
}

/** The edits of a JSON patch: one array, or one edit object per line. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(i + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'mark'; text: string; rawEmpty: boolean };

interface Hunk {
  a: number;
  body: BodyLine[];
  /** True when a `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
}

interface UniSection {
  gitOld: string;
  gitNew: string;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Read one hunk body starting at `lines[i]` (the line after the header). */
function readHunkBody(lines: string[], i: number, a: number): { hunk: Hunk; next: number } {
  const body: BodyLine[] = [];
  while (i < lines.length) {
    const b = lines[i]!;
    if (b.startsWith('diff --git ')) break;
    if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (b === '') body.push({ kind: 'ctx', text: '', rawEmpty: true });
    else if (b[0] === ' ') body.push({ kind: 'ctx', text: b.slice(1), rawEmpty: false });
    else if (b[0] === '-') body.push({ kind: 'old', text: b.slice(1), rawEmpty: false });
    else if (b[0] === '+') body.push({ kind: 'new', text: b.slice(1), rawEmpty: false });
    else if (b[0] === '\\') body.push({ kind: 'mark', text: b.slice(1), rawEmpty: false });
    else break;
    i++;
  }
  while (body.length > 0 && body[body.length - 1]!.rawEmpty) {
    body.pop();
  }
  let noNewline = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      noNewline = k + 1 < body.length && body[k + 1]!.kind === 'mark';
      break;
    }
  }
  return { hunk: { a, body, noNewline }, next: i };
}

/** A hunk's O lines (context + `-`) and N lines (context + `+`, context flagged). */
function hunkSides(hunk: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let oi = 0;
  for (const b of hunk.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oldIndex: oi });
      oi++;
    } else if (b.kind === 'old') {
      o.push(b.text);
      oi++;
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oldIndex: -1 });
    }
  }
  return { o, n };
}

/** Apply a section's hunks in order to a file's text; throws the hunk's failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkSides(h);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const inserted = n.map((e) => e.text);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...inserted);
      if (atEnd) f.finalBreak = !h.noNewline;
    } else {
      const found = findTier(f.lines, o, strict);
      if (found === null) throw new EditFault('no-match', path);
      const target = h.a - 1 + d;
      let at = found.pos[0]!;
      let best = Math.abs(at - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          at = p;
        }
      }
      const touchesEnd = at + o.length === f.lines.length;
      const repl = replacement(f.lines, at, o, n, found.tier);
      f.lines.splice(at, o.length, ...repl);
      if (touchesEnd) f.finalBreak = !h.noNewline;
    }
    d += n.length - o.length;
  }
  return joinFile(f);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new ParseFault(i + 1);
      cur = {
        gitOld: m[1]!,
        gitNew: m[2]!,
        pairOld: null,
        pairNew: null,
        renameFrom: null,
        renameTo: null,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === null) {
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = {
        gitOld: stripAB(headerPath(l)),
        gitNew: stripAB(headerPath(lines[i + 1]!)),
        pairOld: headerPath(l),
        pairNew: headerPath(lines[i + 1]!),
        renameFrom: null,
        renameTo: null,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new ParseFault(i + 1);
      const { hunk, next } = readHunkBody(lines, i + 1, Number(m[1]));
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur === null) {
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new ParseFault(i + 2);
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }

  return sections.map((sec) => {
    let oldP: string;
    let newP: string;
    if (sec.pairOld !== null && sec.pairNew !== null) {
      oldP = stripAB(sec.pairOld);
      newP = stripAB(sec.pairNew);
    } else if (sec.renameFrom !== null || sec.renameTo !== null) {
      oldP = sec.renameFrom ?? sec.gitOld;
      newP = sec.renameTo ?? sec.gitNew;
    } else {
      oldP = sec.gitOld;
      newP = sec.gitNew;
    }
    const isCreate = oldP === '/dev/null' || sec.newFile;
    const isDelete = newP === '/dev/null' || sec.deletedFile;

    if (isCreate) {
      return (tree: Tree) => {
        if (!isSafePath(newP)) throw new EditFault('unsafe', newP);
        if (tree.get(newP) !== null) throw new EditFault('exists', newP);
        const plus: string[] = [];
        let finalBreak = true;
        for (const h of sec.hunks) {
          for (let k = 0; k < h.body.length; k++) {
            const b = h.body[k]!;
            if (b.kind === 'new') {
              plus.push(b.text);
              finalBreak = !(k + 1 < h.body.length && h.body[k + 1]!.kind === 'mark');
            }
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      };
    }
    if (isDelete) {
      return (tree: Tree) => {
        if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
        if (tree.get(oldP) === null) throw new EditFault('missing', oldP);
        tree.now.set(oldP, null);
      };
    }
    if (oldP !== newP) {
      return (tree: Tree) => {
        if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
        if (!isSafePath(newP)) throw new EditFault('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new EditFault('missing', oldP);
        if (tree.get(newP) !== null) throw new EditFault('exists', newP);
        const out = applyHunks(before, sec.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, out);
        tree.moves.push({ old: oldP, new: newP });
      };
    }
    return (tree: Tree) => {
      if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
      const before = tree.get(oldP);
      if (before === null) throw new EditFault('missing', oldP);
      tree.now.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.pos.length > 1) throw new EditFault('ambiguous', path);
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oldIndex: -1 }));
    const out = replacement(f.lines, found.pos[0]!, oldLines, n, found.tier);
    f.lines.splice(found.pos[0]!, oldLines.length, ...out);
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new ParseFault(searchAt + 1);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new ParseFault(searchAt + 1);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let m = searchAt - 1; m >= prevEnd; m--) {
      const t = lines[m]!;
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchAt + 1);
    prevPath = path;
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevEnd = k + 1;
    i = k + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4Chunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
}

function chunkSides(ch: V4Chunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let oi = 0;
  for (const b of ch.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oldIndex: oi });
      oi++;
    } else if (b.kind === 'old') {
      o.push(b.text);
      oi++;
    } else {
      n.push({ text: b.text, ctx: false, oldIndex: -1 });
    }
  }
  return { o, n };
}

/** The first line at or after `from` equal to `anchor` at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

function v4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: V4Chunk[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (at === null) throw new EditFault('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = chunkSides(ch);
      if (o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...n.map((e) => e.text));
        cursor = at + n.length;
        continue;
      }
      const found = findTier(f.lines, o, strict, cursor);
      if (found === null) throw new EditFault('no-match', path);
      let at = found.pos[0]!;
      if (ch.eof) {
        const endAt = f.lines.length - o.length;
        if (!found.pos.includes(endAt)) throw new EditFault('no-match', path);
        at = endAt;
      }
      const repl = replacement(f.lines, at, o, n, found.tier);
      f.lines.splice(at, o.length, ...repl);
      cursor = at + n.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i++;
      continue;
    }
    const isSection = (prefix: string): boolean => l.startsWith(prefix);
    if (!isSection('*** Add File: ') && !isSection('*** Delete File: ') && !isSection('*** Update File: ')) {
      throw new ParseFault(i + 1);
    }
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const headerLen = kind === 'add' ? 14 : kind === 'delete' ? 17 : 17;
    const path = l.slice(headerLen).trim();
    const sectionAt = i;
    // Collect the section's lines, up to the next section or End Patch.
    const raw: string[] = [];
    i++;
    while (i < last) {
      const s = lines[i]!;
      if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
      raw.push(s);
      i++;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const s = raw[k]!;
        if (s === '') fileLines.push('');
        else if (s.startsWith('+')) fileLines.push(s.slice(1));
        else throw new ParseFault(sectionAt + 2 + k);
      }
      edits.push(((p: string, fl: string[]) => (tree: Tree) => {
        if (!isSafePath(p)) throw new EditFault('unsafe', p);
        if (tree.get(p) !== null) throw new EditFault('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      })(path, fileLines));
      continue;
    }
    if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!isBlank(raw[k]!)) throw new ParseFault(sectionAt + 2 + k);
      }
      edits.push(((p: string) => (tree: Tree) => {
        if (!isSafePath(p)) throw new EditFault('unsafe', p);
        if (tree.get(p) === null) throw new EditFault('missing', p);
        tree.now.set(p, null);
      })(path));
      continue;
    }
    // Update File: optional Move to first, then chunks.
    let moveTo: string | null = null;
    const chunks: V4Chunk[] = [];
    let cur: V4Chunk | null = null;
    let closed = false; // true after *** End of File, until the next @@
    let seenContent = false;
    for (let k = 0; k < raw.length; k++) {
      const s = raw[k]!;
      const lineNo = sectionAt + 2 + k;
      if (s.startsWith('*** Move to: ')) {
        if (seenContent || moveTo !== null) throw new ParseFault(lineNo);
        moveTo = s.slice(13).trim();
        seenContent = true;
        continue;
      }
      if (s.startsWith('@@')) {
        cur = { anchor: s.slice(2).trim(), eof: false, body: [] };
        chunks.push(cur);
        closed = false;
        seenContent = true;
        continue;
      }
      if (s === '*** End of File') {
        if (cur === null) throw new ParseFault(lineNo);
        cur.eof = true;
        cur = null;
        closed = true;
        seenContent = true;
        continue;
      }
      const isBody = s === '' || s[0] === ' ' || s[0] === '-' || s[0] === '+';
      if (!isBody) throw new ParseFault(lineNo);
      if (cur === null) {
        if (closed) {
          if (isBlank(s)) continue;
          throw new ParseFault(lineNo);
        }
        if (chunks.length > 0) throw new ParseFault(lineNo);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      seenContent = true;
      if (s === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (s[0] === ' ') cur.body.push({ kind: 'ctx', text: s.slice(1) });
      else if (s[0] === '-') cur.body.push({ kind: 'old', text: s.slice(1) });
      else cur.body.push({ kind: 'new', text: s.slice(1) });
    }
    if (chunks.length === 0 && moveTo === null) throw new ParseFault(sectionAt + 1);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection, the command line, output and exit codes           */
/* ------------------------------------------------------------------ */

/** SPEC.md section 4: the first rule that holds, or null. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Output rows: A/D/M per changed path, R for a move pair, all in byte order
  // (an R line sorts by its new path). A path whose bytes did not change is not listed.
  const rows: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const mv of tree.moves) {
    if (
      tree.original(mv.old) !== null &&
      tree.get(mv.old) === null &&
      tree.original(mv.new) === null &&
      tree.get(mv.new) !== null
    ) {
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      movedOld.add(mv.old);
      movedNew.add(mv.new);
    }
  }
  const paths = [...tree.now.keys()].sort(byteOrder);
  for (const p of paths) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // Moves write their files too (a move's paths are in tree.now already, but the
  // R pair was skipped above, so write them here).
  if (!check) {
    for (const p of movedNew) {
      const now = tree.now.get(p)!;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
    for (const p of movedOld) rmSync(p, { force: true });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
