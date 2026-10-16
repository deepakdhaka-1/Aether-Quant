// Strategy rule language: safe, vectorised evaluation (TypeScript port of engine/aether/rules.py).
//
//     rsi_value < 30 and close > ema_value
//     macdext_MACD crosses above macdext_MACDSignal
//     (adx_value > 25) AND NOT (chop_value > 61.8)
//     rsi_value > rsi_value_prev and close_prev2 < bbands_LowerBand_prev2
//     close <= entry_price * 0.98                      (exit rules only)
//
// Rules are NEVER eval()'d: the normalised text is tokenised and parsed by a small recursive-descent
// parser that only knows the whitelisted grammar (and/or/not, comparisons, + - * /, unary minus,
// numbers, column names, abs/min/max with fixed arity, entry_price). Everything else -- attribute
// access, subscripts, strings, booleans, other calls, keywords, **, //, % -- is a RuleError at
// compile time, exactly as the Python whitelist rejects it.

export class RuleError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RuleError";
  }
}

export const MAX_RULE_LEN = 2000;
export const POSITION_VARS: Record<string, string> = { entry_price: "entry_price", entry: "entry_price" };
export const COLUMN_ALIASES: Record<string, string> = { price: "close" };
const FUNCS: Record<string, number> = { abs: 1, min: 2, max: 2 };
const PREV = /^([A-Za-z_]\w*?)_prev(\d*)$/;
const CROSS = /([A-Za-z_]\w*)\s+crosses\s+(above|below)\s+([A-Za-z_]\w*|-?\d+(?:\.\d+)?)/gi;
const LABELS = [
  "Entry Logic:", "Exit Logic:", "Entry Short:", "Entry Long:", "Exit Short:", "Exit Long:",
  "Short Entry:", "Long Entry:", "Short Exit:", "Long Exit:", "Stop Loss:", "Take Profit:",
  "Logic:", "LONG:", "SHORT:", "TP:", "SL:", "Exit:",
];
const CONNECTIVE = /^\s*(OR|AND|or|and)\s*$/;

// ---------------------------------------------------------------------------------------------
// Dialect normalisation (text -> canonical rule text). Output still goes through the parser.
// ---------------------------------------------------------------------------------------------
export function cleanAlternatives(text: string): string {
  if (!text || !text.includes("|") || text.includes("||")) return text || "";
  const parts = text.split("|").map((p) => p.trim());
  for (const p of parts) if (/[<>=]|prev|diff|crosses|between/i.test(p)) return p;
  return parts.length ? parts[0] : "";
}

function balancedParenContent(s: string): [string, number] | null {
  const start = s.indexOf("(");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return [s.slice(start + 1, i), i + 1];
    }
  }
  return null;
}

export function normaliseDialect(src: string, side = ""): string {
  let logic = cleanAlternatives((src || "").trim());
  logic = logic.replace(/\/\*[\s\S]*?\*\//g, "");
  // `// note` is a comment only when what follows reads as prose (no operators, not a number).
  logic = logic.replace(/\/\/(?![^\n]*[<>=+\-*/()])(?!\s*[\d.])[^\n]*/g, "");
  const lines: string[] = [];
  for (const line of logic.split("\n")) {
    let ln = line.trim().replace(/^(const|let|var)\s+\w+\s*=\s*/, "");
    for (const label of LABELS) {
      if (ln.toLowerCase().startsWith(label.toLowerCase())) ln = ln.slice(label.length).trim();
    }
    if (ln) lines.push(ln);
  }
  logic = lines.join(" ").trim();

  if (/^\s*if\b/i.test(logic)) {
    const bal = balancedParenContent(logic);
    if (bal) {
      const [content, end] = bal;
      const rest = logic.slice(end).trim();
      logic = rest.startsWith("{") || /\breturn\b/i.test(rest)
        ? content.trim()
        : logic.replace(/^\s*if\b/i, "").trim();
    } else {
      logic = logic.replace(/^\s*if\b/i, "").trim();
    }
  } else if (logic.includes("{") && logic.includes("}")) {
    const body = /\{([\s\S]*)\}/.exec(logic);
    if (body) {
      const content = body[1].trim();
      const ret = /return\s+([\s\S]*?);?\s*$/i.exec(content);
      logic = ret ? ret[1] : content;
    }
  }

  logic = logic.replace(/historical\[(\d+)\]\.(\w+)/g, "$2_prev$1");
  logic = logic.replace(/\bcurrent\.(\w+)/g, "$1");
  logic = logic.replace(/(\w+)\.diff\(\)\s*>\s*0/gi, "($1 > $1_prev)");
  logic = logic.replace(/(\w+)\.diff\(\)\s*<\s*0/gi, "($1 < $1_prev)");

  if (side === "long" || side === "short") {
    const parts = logic.split(/\b(OR|AND|or|and)\b/);
    const rebuilt: string[] = [];
    for (const p of parts) {
      const t = p.trim();
      if (/^(?:OR|AND|or|and)$/.test(t)) {
        rebuilt.push(t);
        continue;
      }
      const bare = t.replace(/^(tp|sl|stop loss|take profit|exit):?\s*/i, "").toLowerCase();
      if (/^(?:\d+(\.\d+)?%?|fixed\s*\d+(\.\d+)?%?)$/.test(bare)) continue; // "TP: 2%" -> extractTpSl
      if (t.toLowerCase().includes("entry_price") && !/[<>=]/.test(t)) {
        // Above entry is a long TP / short SL, below entry a long SL / short TP. Default: a stop.
        const k = /entry_price\s*\*\s*([\d.]+)/i.exec(t);
        const f = k ? parseFloat(k[1]) : null;
        const cmp = f !== null && f !== 1.0 ? (f > 1 ? ">=" : "<=") : (side === "long" ? "<=" : ">=");
        rebuilt.push(`(price_value ${cmp} ${t.replace(/[)]+$/, "")})`);
      } else {
        rebuilt.push(p);
      }
    }
    const out: string[] = [];
    for (const tok of rebuilt.filter((x) => x.trim())) {
      if (CONNECTIVE.test(tok) && (!out.length || CONNECTIVE.test(out[out.length - 1]))) continue;
      out.push(tok);
    }
    while (out.length && CONNECTIVE.test(out[out.length - 1])) out.pop();
    logic = out.join(" ");
  }

  logic = logic.replace(/\b(const|let|var)\b/g, "");
  logic = logic.replace(/%/g, "");
  logic = logic.replace(/[.`*;]+$/, "").trim();
  let opens = (logic.match(/\(/g) || []).length;
  let closes = (logic.match(/\)/g) || []).length;
  while (closes > opens) {
    logic = logic.replace(/\)(?=[^)]*$)/, "");
    closes--;
  }
  logic += ")".repeat(Math.max(0, opens - closes));
  opens = 0;
  return logic;
}

export interface TpSl {
  tp_atr_mult: number | null;
  sl_atr_mult: number | null;
  tp_pct: number | null;
  sl_pct: number | null;
  atr_col: string;
  time_limit_hours: number | null;
}

/** TP/SL/time-limit parameters written as text, e.g. 'SL 1.5 * atr_value, TP: 3%, 48h'. */
export function extractTpSl(text: string): TpSl {
  const res: TpSl = { tp_atr_mult: null, sl_atr_mult: null, tp_pct: null, sl_pct: null, atr_col: "atr_value", time_limit_hours: null };
  if (!text) return res;
  let m = /(?:\bsl\b|stop loss).*?([\d.]+)\s*\*\s*(atr\w*)/i.exec(text);
  if (m) { res.sl_atr_mult = parseFloat(m[1]); res.atr_col = m[2]; }
  m = /(?:\btp\b|take profit).*?([\d.]+)\s*\*\s*(atr\w*)/i.exec(text);
  if (m) { res.tp_atr_mult = parseFloat(m[1]); res.atr_col = m[2]; }
  m = /(?:\btp\b|take profit)[^%*]*?([\d.]+)\s*%/i.exec(text);
  if (m) res.tp_pct = parseFloat(m[1]);
  m = /(?:\bsl\b|stop loss)[^%*]*?([\d.]+)\s*%/i.exec(text);
  if (m) res.sl_pct = parseFloat(m[1]);
  m = /(\d+)\s*(?:h\b|hours?\b)/i.exec(text);
  if (m) res.time_limit_hours = parseInt(m[1], 10);
  return res;
}

export function normalise(src: string, side = ""): string {
  let s = normaliseDialect(src, side);
  s = s.replace(/\bAND\b/gi, "and").replace(/\bOR\b/gi, "or").replace(/\bNOT\b/gi, "not");
  s = s.split("&&").join(" and ").split("||").join(" or ");
  return s.replace(CROSS, (_m, a: string, direction: string, b: string) => {
    const bPrev = /^[A-Za-z_]/.test(b) ? `${b}_prev` : b;
    return direction.toLowerCase() === "above"
      ? `(${a} > ${b} and ${a}_prev <= ${bPrev})`
      : `(${a} < ${b} and ${a}_prev >= ${bPrev})`;
  });
}

// ---------------------------------------------------------------------------------------------
// Tokeniser + parser (a strict subset of Python expression syntax)
// ---------------------------------------------------------------------------------------------
export type Node =
  | { t: "bool"; op: "and" | "or"; values: Node[] }
  | { t: "not"; operand: Node }
  | { t: "neg"; operand: Node }
  | { t: "cmp"; left: Node; ops: string[]; comparators: Node[] }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; left: Node; right: Node }
  | { t: "call"; fn: string; args: Node[] }
  | { t: "name"; id: string }
  | { t: "num"; value: number };

type Tok = { k: "num" | "name" | "op" | "end"; v: string };
const PY_KEYWORDS = new Set([
  "False", "None", "True", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
  "nonlocal", "pass", "raise", "return", "try", "while", "with", "yield",
]);

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    const num = /^(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (num && (/\d/.test(c) || (c === "." && /\d/.test(text[i + 1] ?? "")))) {
      const after = text[i + num[0].length] ?? "";
      if (/[A-Za-z_0-9]/.test(after)) throw new RuleError(`'${text.slice(i)}' is not a valid number`);
      toks.push({ k: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (id) { toks.push({ k: "name", v: id[0] }); i += id[0].length; continue; }
    const two = text.slice(i, i + 2);
    if (["<=", ">=", "==", "!="].includes(two)) { toks.push({ k: "op", v: two }); i += 2; continue; }
    if (two === "**" || two === "//") throw new RuleError(`operator '${two}' is not allowed in a rule`);
    if ("<>+-*/(),".includes(c)) { toks.push({ k: "op", v: c }); i++; continue; }
    throw new RuleError(`cannot parse rule: unexpected character '${c}'`);
  }
  toks.push({ k: "end", v: "" });
  return toks;
}

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok { return this.toks[this.p]; }
  private next(): Tok { return this.toks[this.p++]; }
  private isOp(v: string): boolean { const t = this.peek(); return t.k === "op" && t.v === v; }
  private isKw(v: string): boolean { const t = this.peek(); return t.k === "name" && t.v === v; }
  private expect(v: string) {
    if (!this.isOp(v)) throw new RuleError(`cannot parse rule: expected '${v}'`);
    this.p++;
  }
  parse(): Node {
    const node = this.orExpr();
    if (this.peek().k !== "end") throw new RuleError(`cannot parse rule: unexpected '${this.peek().v}'`);
    return node;
  }
  private orExpr(): Node {
    const values = [this.andExpr()];
    while (this.isKw("or")) { this.p++; values.push(this.andExpr()); }
    return values.length === 1 ? values[0] : { t: "bool", op: "or", values };
  }
  private andExpr(): Node {
    const values = [this.notExpr()];
    while (this.isKw("and")) { this.p++; values.push(this.notExpr()); }
    return values.length === 1 ? values[0] : { t: "bool", op: "and", values };
  }
  private notExpr(): Node {
    if (this.isKw("not")) { this.p++; return { t: "not", operand: this.notExpr() }; }
    return this.comparison();
  }
  private comparison(): Node {
    const left = this.arith();
    const ops: string[] = [];
    const comparators: Node[] = [];
    for (;;) {
      const t = this.peek();
      if (t.k === "op" && ["<", ">", "<=", ">=", "==", "!="].includes(t.v)) {
        this.p++;
        ops.push(t.v);
        comparators.push(this.arith());
      } else if (t.k === "name" && (t.v === "in" || t.v === "is" || (t.v === "not" && ops.length >= 0 && this.toks[this.p + 1]?.v === "in"))) {
        throw new RuleError(`'${t.v}' comparisons are not allowed in a rule`);
      } else break;
    }
    return ops.length ? { t: "cmp", left, ops, comparators } : left;
  }
  private arith(): Node {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().v as "+" | "-";
      left = { t: "bin", op, left, right: this.term() };
    }
    return left;
  }
  private term(): Node {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.next().v as "*" | "/";
      left = { t: "bin", op, left, right: this.unary() };
    }
    return left;
  }
  private unary(): Node {
    if (this.isOp("-")) { this.p++; return { t: "neg", operand: this.unary() }; }
    if (this.isOp("+")) throw new RuleError("'UAdd' is not allowed in a rule");
    return this.atom();
  }
  private atom(): Node {
    const t = this.next();
    if (t.k === "num") return { t: "num", value: Number(t.v) };
    if (t.k === "op" && t.v === "(") {
      const e = this.orExpr();
      this.expect(")");
      return e;
    }
    if (t.k === "name") {
      if (t.v === "and" || t.v === "or" || t.v === "not") throw new RuleError(`cannot parse rule: unexpected '${t.v}'`);
      if (t.v === "True" || t.v === "False" || t.v === "None") throw new RuleError(`constant ${t.v} not allowed`);
      if (PY_KEYWORDS.has(t.v)) throw new RuleError(`'${t.v}' is not allowed in a rule`);
      if (this.isOp("(")) {
        this.p++;
        const args: Node[] = [];
        if (!this.isOp(")")) {
          args.push(this.orExpr());
          while (this.isOp(",")) { this.p++; if (this.isOp(")")) break; args.push(this.orExpr()); }
        }
        this.expect(")");
        if (!(t.v in FUNCS)) throw new RuleError("only abs(), min(), max() calls are allowed");
        if (args.length !== FUNCS[t.v]) throw new RuleError(`${t.v}() takes ${FUNCS[t.v]} argument(s)`);
        return { t: "call", fn: t.v, args };
      }
      const nt = this.peek();
      if (nt.k === "op" && nt.v === "." ) throw new RuleError("'Attribute' is not allowed in a rule");
      return { t: "name", id: t.v };
    }
    throw new RuleError(`cannot parse rule: unexpected '${t.v || "end of rule"}'`);
  }
}

export interface Rule {
  source: string;
  tree: Node;
  columns: Set<string>;
  positionVars: Set<string>;
  usesEntryPrice: boolean;
}

function baseName(name: string): string {
  const m = PREV.exec(name);
  return m ? m[1] : name;
}

function walk(node: Node, fn: (n: Node) => void) {
  fn(node);
  switch (node.t) {
    case "bool": node.values.forEach((v) => walk(v, fn)); break;
    case "not": case "neg": walk(node.operand, fn); break;
    case "cmp": walk(node.left, fn); node.comparators.forEach((v) => walk(v, fn)); break;
    case "bin": walk(node.left, fn); walk(node.right, fn); break;
    case "call": node.args.forEach((v) => walk(v, fn)); break;
  }
}

export function compileRule(src: string | null | undefined, allowedColumns?: Iterable<string> | null, side = ""): Rule | null {
  if (!src || !src.trim()) return null;
  if (src.length > MAX_RULE_LEN) throw new RuleError(`rule longer than ${MAX_RULE_LEN} characters`);
  const text = normalise(src, side);
  if (!text) return null;
  let tree: Node;
  try {
    tree = new Parser(tokenize(text)).parse();
  } catch (e) {
    if (e instanceof RuleError) throw new RuleError(`cannot parse rule ${JSON.stringify(src)}: ${e.message}`);
    throw e;
  }
  const cols = new Set<string>();
  const pvars = new Set<string>();
  walk(tree, (n) => {
    if (n.t !== "name") return;
    const low = n.id.toLowerCase();
    if (low in POSITION_VARS) pvars.add(POSITION_VARS[low]);
    else cols.add(baseName(n.id));
  });
  if (!cols.size && !pvars.size) throw new RuleError(`rule ${JSON.stringify(src)} references no indicator or price column`);
  if (allowedColumns) {
    const lower = new Set([...allowedColumns].map((c) => c.toLowerCase()));
    const unknown = [...cols].filter((c) => !lower.has(c.toLowerCase()) && !lower.has(COLUMN_ALIASES[c.toLowerCase()] ?? "")).sort();
    if (unknown.length) throw new RuleError(`unknown indicator column(s): ${unknown.join(", ")}`);
  }
  return { source: src, tree, columns: cols, positionVars: pvars, usesEntryPrice: pvars.has("entry_price") };
}

// ---------------------------------------------------------------------------------------------
// Evaluation over a column frame. Every series is a Float64Array (NaN = missing, booleans 0/1),
// matching pandas: comparisons with NaN are False, boolean ops treat NaN as False.
// ---------------------------------------------------------------------------------------------
export type Frame = { n: number; cols: Record<string, ArrayLike<number | null>> };
type Val = number | Float64Array;

function resolver(frame: Frame): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of Object.keys(frame.cols)) if (!m.has(c.toLowerCase())) m.set(c.toLowerCase(), c);
  return m;
}

function toF64(a: ArrayLike<number | null>): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    out[i] = v === null || v === undefined ? NaN : Number(v);
  }
  return out;
}

function column(frame: Frame, name: string, res: Map<string, string>, cache: Map<string, Float64Array>): Float64Array {
  const hit = cache.get(name);
  if (hit) return hit;
  const real = name in frame.cols ? name : res.get(name.toLowerCase()) ?? res.get(COLUMN_ALIASES[name.toLowerCase()] ?? "");
  let out: Float64Array;
  if (real !== undefined) {
    out = toF64(frame.cols[real]);
  } else {
    const m = PREV.exec(name);
    if (!m) throw new RuleError(`column '${name}' not in data`);
    const k = parseInt(m[2] || "1", 10);
    const base = column(frame, m[1], res, cache);
    out = new Float64Array(frame.n).fill(NaN);
    for (let i = k; i < frame.n; i++) out[i] = base[i - k];
  }
  cache.set(name, out);
  return out;
}

function map1(a: Val, f: (x: number) => number, n: number): Val {
  if (typeof a === "number") return f(a);
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = f(a[i]);
  return o;
}

function map2(a: Val, b: Val, f: (x: number, y: number) => number, n: number): Val {
  if (typeof a === "number" && typeof b === "number") return f(a, b);
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = f(typeof a === "number" ? a : a[i], typeof b === "number" ? b : b[i]);
  return o;
}

const truthy = (x: number) => (x === x && x !== 0 ? 1 : 0);
const CMP: Record<string, (x: number, y: number) => number> = {
  "<": (x, y) => (x < y ? 1 : 0), "<=": (x, y) => (x <= y ? 1 : 0),
  ">": (x, y) => (x > y ? 1 : 0), ">=": (x, y) => (x >= y ? 1 : 0),
  "==": (x, y) => (x === y ? 1 : 0), "!=": (x, y) => (x !== y ? 1 : 0), // NaN != NaN is True, as in pandas
};

function evalNode(node: Node, frame: Frame, res: Map<string, string>, cache: Map<string, Float64Array>, env: Record<string, number | null>): Val {
  const n = frame.n;
  switch (node.t) {
    case "bool": {
      const vals = node.values.map((v) => map1(evalNode(v, frame, res, cache, env), truthy, n));
      let acc = vals[0];
      for (const v of vals.slice(1)) acc = map2(acc, v, node.op === "and" ? (x, y) => x & y : (x, y) => x | y, n);
      return acc;
    }
    case "not":
      return map1(evalNode(node.operand, frame, res, cache, env), (x) => 1 - truthy(x), n);
    case "neg":
      return map1(evalNode(node.operand, frame, res, cache, env), (x) => -x, n);
    case "cmp": {
      let left = evalNode(node.left, frame, res, cache, env);
      let acc: Val | null = null;
      node.ops.forEach((op, k) => {
        const right = evalNode(node.comparators[k], frame, res, cache, env);
        const r = map2(left, right, CMP[op], n);
        acc = acc === null ? r : map2(acc, r, (x, y) => x & y, n);
        left = right;
      });
      return acc as unknown as Val;
    }
    case "bin": {
      const l = evalNode(node.left, frame, res, cache, env);
      const r = evalNode(node.right, frame, res, cache, env);
      const f = node.op === "+" ? (x: number, y: number) => x + y : node.op === "-" ? (x: number, y: number) => x - y
        : node.op === "*" ? (x: number, y: number) => x * y : (x: number, y: number) => x / y;
      return map2(l, r, f, n);
    }
    case "call": {
      const a = node.args.map((x) => evalNode(x, frame, res, cache, env));
      if (node.fn === "abs") return map1(a[0], Math.abs, n);
      return map2(a[0], a[1], node.fn === "min" ? (x, y) => (x !== x || y !== y ? NaN : Math.min(x, y)) : (x, y) => (x !== x || y !== y ? NaN : Math.max(x, y)), n);
    }
    case "name": {
      const low = node.id.toLowerCase();
      if (low in POSITION_VARS) {
        const v = env[POSITION_VARS[low]];
        return v === null || v === undefined ? NaN : Number(v);
      }
      return column(frame, node.id, res, cache);
    }
    case "num":
      return node.value;
  }
}

/** Boolean signal per bar (Uint8Array of 0/1). */
export function evaluateRule(rule: Rule, frame: Frame, env: Record<string, number | null> = {}, cache?: Map<string, Float64Array>): Uint8Array {
  const v = evalNode(rule.tree, frame, resolver(frame), cache ?? new Map(), env);
  const out = new Uint8Array(frame.n);
  if (typeof v === "number") { out.fill(truthy(v)); return out; }
  for (let i = 0; i < frame.n; i++) out[i] = truthy(v[i]);
  return out;
}
