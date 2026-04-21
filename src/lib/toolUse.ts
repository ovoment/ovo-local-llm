// [START] Phase 6.2c — Tool-use helpers for prompt-engineered MCP tool calls.
// Pure functions — no side effects, no store access.

import type { McpTool } from "./mcp";
// [START] Phase 8.4 — JSON auto-repair.
// Local models routinely emit JSON with unescaped quotes, missing braces,
// or trailing commas inside tool_use blocks. `jsonrepair` recovers from
// most of these mistakes before we fall back to the YAML / Python / XML
// shape parsers, cutting the malformed-call rate dramatically.
import { jsonrepair } from "jsonrepair";
// [END]

// [START] Phase 6.4 — OVO built-in tools.
// These are hosted by the Python sidecar (/ovo/*) and are always available
// regardless of whether any MCP server is registered. The server_id namespace
// 'ovo:builtin' is reserved so the chat dispatcher can route them internally
// instead of through the MCP pool.
export const BUILTIN_SERVER_ID = "ovo:builtin";

export const BUILTIN_TOOLS: McpTool[] = [
  {
    name: "web_search",
    description:
      "OVO 내장 인터넷 검색 (DuckDuckGo 기반). 사용자가 명시적으로 웹 검색을 요청하거나, 최신 뉴스·실시간 정보·URL 조회가 필요한 경우에만 사용. 일반 질문에는 사용하지 말 것.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어" },
        limit: {
          type: "integer",
          description: "최대 결과 수 (기본 8, 최대 20)",
          default: 8,
        },
      },
      required: ["query"],
    },
  },
  // [START] Phase 6.4 — Memory bridge: the four tools below replace the
  // `@modelcontextprotocol/server-memory` preset by backing every op with the
  // local Wiki SQLite + FTS5 store. Persistent across sessions, local-only,
  // shares data with the Wiki UI so the user can curate what the model sees.
  {
    name: "memory_search",
    description:
      "OVO Wiki FTS 검색 — 제목/본문/태그를 BM25로 조회. 과거 대화나 프로젝트 사실을 다시 불러올 때 사용.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "FTS5 검색어 (공백 구분 여러 단어 허용)" },
        limit: {
          type: "integer",
          description: "최대 결과 수 (기본 5, 최대 20)",
          default: 5,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_add",
    description:
      "OVO Wiki에 새 메모 추가 — 나중에 기억해야 할 사실/결정/맥락을 저장. 기본 tier='note'.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "페이지 제목 (짧을수록 좋음)" },
        content: { type: "string", description: "본문 (markdown 허용)" },
        tier: {
          type: "string",
          enum: ["note", "casebook", "canonical"],
          description: "지식 계층. 기본 'note' (원시 기록).",
          default: "note",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "선택적 태그 목록",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "memory_list",
    description:
      "OVO Wiki 페이지를 최신순으로 나열 — 최근에 무엇을 기록했는지 훑어볼 때 사용. 기본은 현재 프로젝트 + 글로벌 페이지, 아카이브 제외.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "최대 결과 수 (기본 20, 최대 100)",
          default: 20,
        },
        include_archived: {
          type: "boolean",
          description: "true면 아카이브된 페이지까지 포함 (기본 false)",
          default: false,
        },
      },
    },
  },
  {
    name: "memory_delete",
    description:
      "OVO Wiki 페이지 삭제 — memory_search/list로 얻은 id를 사용. 되돌릴 수 없으니 일시적으로 숨기려면 memory_archive_page를 써.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "페이지 id (memory_search 결과의 id 필드)" },
      },
      required: ["id"],
    },
  },
  // [END] Phase 6.4
  // [START] Phase 8 — Archive (soft hide). Archived pages stay in the DB but
  // are filtered out of memory_search / memory_list / chat retrieval until
  // explicitly unarchived. Cheaper than delete + reversible.
  {
    name: "memory_archive_page",
    description:
      "OVO Wiki 페이지 아카이브 — 검색/리스트/채팅 주입에서 제외하지만 데이터는 보존. archived=false로 호출하면 복원.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "페이지 id" },
        archived: {
          type: "boolean",
          description: "true(기본)면 아카이브, false면 복원",
          default: true,
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_lint_wiki",
    description:
      "OVO Wiki 위생 점검 — orphan(백링크 없음) / stale(180일+ 미업데이트) / oversized(8000자+) / duplicate(제목 중복) 이슈를 묶어서 반환. 프로젝트 메모리 정리할 때 호출.",
    input_schema: {
      type: "object",
      properties: {
        stale_days: {
          type: "integer",
          description: "stale 임계 일수 (기본 180)",
          default: 180,
        },
        oversized_chars: {
          type: "integer",
          description: "oversized 임계 글자 수 (기본 8000)",
          default: 8000,
        },
      },
    },
  },
  {
    name: "memory_backlinks",
    description:
      "OVO Wiki 백링크 조회 — `[[slug]]` 또는 `[[Title]]` 표기로 특정 페이지를 참조하는 모든 페이지를 찾음. 어떤 노트와 연결되는지 확인할 때 사용.",
    input_schema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "타깃 페이지 slug 또는 title",
        },
      },
      required: ["target"],
    },
  },
  // [END] Phase 8
];

export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOLS.some((tool) => tool.name === name);
}
// [END]

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Raw text block including tags so caller can splice it out of the output. */
  raw: string;
}

// ── parseToolUseBlock ─────────────────────────────────────────────────────────

// [START] Phase 8.4 — accept multiple tool-call tag variants.
// Different open-source models were trained on different conventions:
//   - Claude / Anthropic style: <tool_use>...</tool_use>  (our default)
//   - Qwen3, some Llama tunes: <tool_call>...</tool_call>
//   - GPT/OpenAI-flavoured tunes: <function_call>...</function_call>
// We try each pair in order and keep the first complete block we find. The
// system prompt still requests <tool_use> explicitly so the canonical form
// stays preferred — these aliases are forgiveness, not encouragement.
const TOOL_TAG_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["<tool_use>", "</tool_use>"],
  ["<tool_call>", "</tool_call>"],
  ["<function_call>", "</function_call>"],
];

export const TOOL_OPEN_TAGS: ReadonlyArray<string> = TOOL_TAG_VARIANTS.map((v) => v[0]);
export const TOOL_CLOSE_TAGS: ReadonlyArray<string> = TOOL_TAG_VARIANTS.map((v) => v[1]);
// [END]

// [START] Phase 5 — name-as-tag rescue.
// Small models sometimes skip the canonical tool_use wrapper and instead
// emit the tool name itself as a tag, e.g. memory_search wrapping the JSON
// arguments. The JSON inside is fine; only the wrapper is wrong. We allow
// this form when the tag name matches a known OVO built-in tool (or a name
// the caller passes in via knownToolNames).
const RESERVED_DIRECT_TAGS: ReadonlySet<string> = new Set([
  "tool_use",
  "tool_call",
  "function_call",
  "tool_result",
  "think",
  "thinking",
  "editor_selection",
  "function",
]);

export const BUILTIN_TOOL_NAMES: ReadonlyArray<string> = BUILTIN_TOOLS.map((t) => t.name);

// [START] Phase 5 — raw-JSON tool call rescue.
// Small models occasionally drop the wrapper entirely and emit the tool
// call as a bare JSON object. We scan for `{"name":"<tool>",...}` objects
// by balanced-brace matching (regex alone can't parse nested braces),
// validate the result against the allowlist, and pull out arguments.
function tryParseRawToolJson(
  text: string,
  allowlist: ReadonlySet<string>,
): ParsedToolCall | null {
  // Cheap pre-filter — if there's no quoted `name` key referencing a known
  // tool, skip the expensive balanced-brace scan.
  const nameHit = text.match(/"name"\s*:\s*"([a-z_][a-z0-9_]*)"/i);
  if (!nameHit) return null;
  const candidate = nameHit[1].toLowerCase();
  if (!allowlist.has(candidate)) return null;

  // Balanced-brace scan starting from the earliest `{` before the name key.
  const nameIdx = text.indexOf(nameHit[0]);
  let openBrace = -1;
  for (let i = nameIdx; i >= 0; i--) {
    if (text[i] === "{") {
      openBrace = i;
      break;
    }
  }
  if (openBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let closeBrace = -1;
  for (let i = openBrace; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace === -1) return null;

  const raw = text.slice(openBrace, closeBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(raw));
    } catch {
      return null;
    }
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).name !== "string"
  ) {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  const name = (p.name as string).toLowerCase();
  if (!allowlist.has(name)) return null;
  const args = p.arguments;
  const safeArgs: Record<string, unknown> =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  return {
    name: p.name as string,
    arguments: safeArgs,
    raw,
  };
}
// [END]

function tryParseNameAsTag(
  text: string,
  allowlist: ReadonlySet<string>,
): ParsedToolCall | null {
  const re = /<([a-z][a-z0-9_]*)>\s*([\s\S]*?)\s*<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].toLowerCase();
    if (RESERVED_DIRECT_TAGS.has(tag)) continue;
    if (!allowlist.has(tag)) continue;
    const body = m[2].trim();
    if (!body.startsWith("{")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      try {
        parsed = JSON.parse(jsonrepair(body));
      } catch {
        continue;
      }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      continue;
    }

    // Two common payload shapes: args directly, or {"arguments": {...}}.
    const obj = parsed as Record<string, unknown>;
    const args =
      obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments)
        ? (obj.arguments as Record<string, unknown>)
        : obj;

    return {
      name: tag,
      arguments: args,
      raw: m[0],
    };
  }
  return null;
}
// [END]

/**
 * Scan model output for a complete <tool_use>{JSON}</tool_use> block.
 * Also accepts <tool_call> and <function_call> variants for open-source
 * models trained on those conventions.
 * Returns null if no complete block is found (e.g. during mid-stream partial).
 *
 * Edge cases handled:
 * - Partial open tag without closing tag → returns null (safe during streaming).
 * - Block inside a <think> section → skipped; caller should strip think blocks
 *   before passing, or we detect the tag is inside a think region (see below).
 * - Multiple blocks → returns the first complete one only (caller recurses).
 * - Nested quotes in JSON → handled by JSON.parse naturally.
 */
export function parseToolUseBlock(
  text: string,
  knownToolNames?: ReadonlyArray<string>,
): ParsedToolCall | null {
  // Find the earliest opening tag across all known variants.
  let openIdx = -1;
  let toolOpen = "";
  let toolClose = "";
  for (const [open, close] of TOOL_TAG_VARIANTS) {
    const idx = text.indexOf(open);
    if (idx !== -1 && (openIdx === -1 || idx < openIdx)) {
      openIdx = idx;
      toolOpen = open;
      toolClose = close;
    }
  }
  if (openIdx === -1) {
    // [START] Phase 5 — name-as-tag + raw-JSON fallback.
    // No canonical <tool_use>. Try the direct-name form first, then a
    // last-resort raw-JSON scan for models that drop the wrapper entirely
    // and emit just `{"name":"tool","arguments":{...}}`.
    const allow = new Set<string>(BUILTIN_TOOL_NAMES.map((n) => n.toLowerCase()));
    if (knownToolNames) {
      for (const n of knownToolNames) allow.add(n.toLowerCase());
    }
    const named = tryParseNameAsTag(text, allow);
    if (named) return named;
    return tryParseRawToolJson(text, allow);
    // [END]
  }

  // Guard: if the tool tag appears inside a <think> block, ignore it.
  // We check if there is an unclosed <think> before the openIdx.
  const THINK_OPEN = "<think>";
  const THINK_CLOSE = "</think>";
  const textBefore = text.slice(0, openIdx);
  const lastThinkOpen = textBefore.lastIndexOf(THINK_OPEN);
  const lastThinkClose = textBefore.lastIndexOf(THINK_CLOSE);
  if (lastThinkOpen !== -1 && lastThinkOpen > lastThinkClose) {
    // Inside an unclosed <think> — ignore
    return null;
  }

  const contentStart = openIdx + toolOpen.length;
  const closeIdx = text.indexOf(toolClose, contentStart);
  if (closeIdx === -1) return null; // incomplete — wait for more tokens

  const raw = text.slice(openIdx, closeIdx + toolClose.length);
  const jsonText = text.slice(contentStart, closeIdx).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // [START] Phase 8.4 — jsonrepair first.
    // Recovers from the common local-model mistakes: unescaped inner
    // quotes, trailing commas, missing braces, single-quoted keys.
    // Try this before the structural fallbacks so we still get a JSON
    // object out when the input was "almost JSON".
    try {
      const repaired = jsonrepair(jsonText);
      parsed = JSON.parse(repaired);
    } catch {
      parsed = null;
    }
    // [END]
    // [START] Phase 8.3 — YAML-style fallback for models that output:
    //   <tool_use>
    //   name: tool_name
    //   arguments:
    //     key: value
    //   </tool_use>
    // instead of JSON. This is common with open-source models (Qwen, MiniMax, etc.)
    if (!parsed) {
      try {
        parsed = parseYamlLikeToolUse(jsonText);
      } catch {
        parsed = null;
      }
    }
    // [END]
    // [START] Phase 8.4 — Python/XML function-call fallbacks.
    // Qwen3-Coder's native training emits either of:
    //   list_dir(".")
    //   list_dir(path=".")
    // or the XML tool-call convention:
    //   <function=list_dir><parameter=path>.</parameter></function>
    // Neither parses as JSON or YAML. Without a fallback the malformed
    // handler gives up after 3 strikes. Try the two shapes in order.
    if (!parsed) parsed = parsePythonLikeToolCall(jsonText);
    if (!parsed) parsed = parseXmlFunctionToolCall(jsonText);
    if (!parsed) return null;
    // [END]
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    typeof (parsed as Record<string, unknown>).name !== "string"
  ) {
    return null;
  }

  const p = parsed as Record<string, unknown>;
  const args = p.arguments;
  const safeArgs: Record<string, unknown> =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  return {
    name: p.name as string,
    arguments: safeArgs,
    raw,
  };
}

// ── buildToolsSystemMessage ───────────────────────────────────────────────────

/**
 * Build a system-prompt section listing available MCP tools and instructing
 * the model to emit <tool_use>{JSON}</tool_use> when it wants to call one.
 *
 * Schema is inlined in compact JSON form from tool.input_schema.
 */
export function buildToolsSystemMessage(tools: McpTool[]): string {
  if (tools.length === 0) return "";

  const toolLines = tools
    .map((tool) => {
      const schemaStr =
        tool.input_schema !== null && tool.input_schema !== undefined
          ? JSON.stringify(tool.input_schema)
          : "{}";
      const desc = tool.description ? ` — ${tool.description}` : "";
      return `- \`${tool.name}\`${desc}. Schema: ${schemaStr}`;
    })
    .join("\n");

  // [START] Phase 5 — small-model friendly tool prompt.
  // Open-source MLX models under 14B drop tool calls unless the format is
  // spelled out in both languages with a worked example they can mimic.
  // We include a concrete worked example, a "do" rule, a "don't" rule,
  // and a Korean mirror because the user may ask in Korean and the model
  // will be tempted to answer in Korean without touching the tool.
  return [
    "## TOOLS",
    "",
    "You have access to these tools. Use them ONLY when appropriate:",
    "- web_search: ONLY when the user explicitly asks to search the web, or asks about real-time/latest news.",
    "- memory_*: when recalling past conversations or stored facts.",
    "Do NOT call tools for general knowledge questions you can answer directly.",
    "",
    "To call a tool, emit EXACTLY this format and nothing else:",
    "",
    "<tool_use>",
    '{"name": "TOOL_NAME", "arguments": {"KEY": "VALUE"}}',
    "</tool_use>",
    "",
    "Worked example — user asks \"포항 날씨 알려줘\":",
    "",
    "<tool_use>",
    '{"name": "web_search", "arguments": {"query": "포항 날씨"}}',
    "</tool_use>",
    "",
    "Rules:",
    "1. Emit the <tool_use> block BEFORE any prose answer — call first, talk after the result.",
    "2. Use DOUBLE QUOTES for all JSON keys and values. Never backticks, never single quotes.",
    "3. After emitting the block, STOP. Wait for the <tool_result> message.",
    "4. If you don't need a tool, just answer the user directly — don't fake a tool call.",
    "5. Never paste the <tool_use> block AS prose; it must be an actual tool invocation.",
    "",
    "한국어로 물어봐도 툴 형식은 영어 JSON 그대로 써. 답변만 한국어로.",
    "",
    "## AVAILABLE TOOLS",
    toolLines,
  ].join("\n");
  // [END]
}
// [START] Phase 8.3 — YAML-like tool_use parser for open-source models.
// Handles the common format:
//   name: tool_name
//   arguments:
//     key1: value1
//     key2: value2
// Also handles single-line arguments like:
//   name: tool_name
//   arguments: {"key": "value"}
function parseYamlLikeToolUse(text: string): Record<string, unknown> | null {
  const lines = text.split("\n").map((l) => l.trimEnd());

  let name: string | null = null;
  const args: Record<string, unknown> = {};
  let inArguments = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match "name: value"
    const nameMatch = trimmed.match(/^name:\s*(.+)/);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      inArguments = false;
      continue;
    }

    // Match "arguments:" header or "arguments: {json}"
    const argsMatch = trimmed.match(/^arguments:\s*(.*)/);
    if (argsMatch) {
      const rest = argsMatch[1].trim();
      if (rest.startsWith("{")) {
        // Inline JSON
        try {
          const parsed = JSON.parse(rest);
          if (typeof parsed === "object" && parsed !== null) {
            Object.assign(args, parsed);
          }
        } catch {
          // ignore parse failure
        }
        inArguments = false;
      } else if (rest) {
        // Single value on same line — treat as a positional hint
        inArguments = true;
      } else {
        inArguments = true;
      }
      continue;
    }

    // Inside arguments block — parse "  key: value" pairs
    if (inArguments) {
      const kvMatch = trimmed.match(/^(\w+):\s*(.*)/);
      if (kvMatch) {
        let val: unknown = kvMatch[2].trim();
        // Try to parse as JSON literal (number, bool, null, string)
        if (val === "true") val = true;
        else if (val === "false") val = false;
        else if (val === "null" || val === "~" || val === "") val = "";
        else if (typeof val === "string" && /^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
        else if (typeof val === "string") val = val.replace(/^["']|["']$/g, "");
        args[kvMatch[1]] = val;
      }
    }
  }

  if (!name) return null;
  return { name, arguments: args };
}
// [END] Phase 8.3

// [START] Phase 8.4 — Python-style function-call parser.
// Accepts shapes Qwen3-Coder trains on natively:
//   list_dir(".")
//   list_dir(path=".", recursive=true)
// Heuristic only — not a full Python parser. Single positional arg maps to
// `path`, which is the common case for our tools.
function parsePythonLikeToolCall(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (!match) return null;
  const name = match[1];
  const inner = match[2].trim();
  const args: Record<string, unknown> = {};
  if (inner.length === 0) return { name, arguments: args };
  const parts: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr !== null) {
      cur += ch;
      if (ch === "\\" && i + 1 < inner.length) {
        cur += inner[i + 1];
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) parts.push(cur.trim());
  let positional = 0;
  for (const raw of parts) {
    const kwMatch = raw.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([\s\S]+)$/);
    if (kwMatch) {
      args[kwMatch[1]] = parseLiteralValue(kwMatch[2].trim());
    } else {
      const key = positional === 0 ? "path" : `arg${positional}`;
      args[key] = parseLiteralValue(raw);
      positional++;
    }
  }
  return { name, arguments: args };
}

function parseLiteralValue(raw: string): unknown {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "None") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
// [END]

// [START] Phase 8.4 — XML function-call parser.
// Accepts the Qwen3-Coder / OpenAI-agentic shape:
//   <function=list_dir>
//     <parameter=path>.</parameter>
//   </function>
// and the attribute-style variant.
function parseXmlFunctionToolCall(text: string): Record<string, unknown> | null {
  const fnMatch = text.match(
    /<function(?:\s*=\s*|\s+name\s*=\s*["']?)([a-zA-Z_][a-zA-Z0-9_]*)["']?[^>]*>([\s\S]*?)<\/function>/,
  );
  if (!fnMatch) return null;
  const name = fnMatch[1];
  const body = fnMatch[2];
  const args: Record<string, unknown> = {};
  const paramRegex =
    /<parameter(?:\s*=\s*|\s+name\s*=\s*["']?)([a-zA-Z_][a-zA-Z0-9_]*)["']?[^>]*>([\s\S]*?)<\/parameter>/g;
  let m: RegExpExecArray | null;
  while ((m = paramRegex.exec(body)) !== null) {
    const key = m[1];
    const value = m[2].trim();
    args[key] = parseLiteralValue(value);
  }
  return { name, arguments: args };
}
// [END]

// [END] Phase 6.2c
