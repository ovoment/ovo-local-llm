// [START] Phase 6.4 — Slash command infrastructure.
// Triggered when the chat input starts with '/' on the first line AND the
// cursor has not left that prefix. Commands can either run an imperative
// handler (clear chat, switch profile…) or insert template text for the user
// to continue editing.
//
// Edge-case rules (oppa explicit requirement):
//   - Ignore '/' inside a code fence (```).
//   - Ignore '/' inside quoted inline code (`...`) on the same line.
//   - Ignore '/' in the middle of a word (must be leading char of input or
//     follow a newline).
// The detection helper below encodes these.

export type SlashCommandKind = "action" | "template";

export interface SlashCommandContext {
  // Filled in by the caller — lets handlers touch stores without circular
  // imports. Extended as more commands land.
  clearChat?: () => Promise<void> | void;
  cycleProfile?: () => void;
  openPane?: (pane: "wiki" | "models" | "settings" | "image" | "code" | "chat") => void;
  compact?: () => Promise<void> | void;
  addMemoryNote?: (text: string) => Promise<void> | void;
}

export interface SlashCommand {
  id: string;            // matched against user typed token (after '/')
  aliases?: string[];    // alternate match strings
  name: string;          // user-visible label
  description: string;   // one-line help
  emoji?: string;        // optional visual hint
  kind: SlashCommandKind;
  /** action handler — returns text to replace the slash prefix with,
   *  or null/empty to just clear the prompt. */
  run?: (ctx: SlashCommandContext, args: string) => string | null | void;
  /** template kind — returned string replaces the input so the user
   *  can keep editing. */
  template?: (args: string) => string;
  /** Phase roadmap placeholder — when true the command is registered but
   *  the action is deferred (shows a toast). Used to surface upcoming
   *  Phase 6.4 commands without stub implementations. */
  placeholder?: boolean;
}

// [START] Edge-case guard — decide whether the current input should surface
// the slash menu. We only show the popup when the entire input so far is a
// single slash-led token (with optional args), no backtick inline code, no
// open code fence. Keeps the menu out of inline code like `a/b` and block
// snippets like ```/bin/bash```.
export function shouldShowSlashMenu(value: string): {
  show: boolean;
  token: string;
  args: string;
} {
  // Fast fail — must start with '/' as first printable char (allow leading ws)
  const trimmedLead = value.trimStart();
  if (!trimmedLead.startsWith("/")) return { show: false, token: "", args: "" };

  // Disqualify if any newline already present — slash commands are single-line
  if (value.includes("\n")) return { show: false, token: "", args: "" };

  // Disqualify if any unmatched backtick on the current text — user is in an
  // inline code block and '/' is incidental to that.
  const backticks = (value.match(/`/g) ?? []).length;
  if (backticks % 2 === 1) return { show: false, token: "", args: "" };

  // Split leading '/' + token + optional args
  const afterSlash = trimmedLead.slice(1);
  const spaceIdx = afterSlash.indexOf(" ");
  if (spaceIdx === -1) {
    return { show: true, token: afterSlash, args: "" };
  }
  return {
    show: true,
    token: afterSlash.slice(0, spaceIdx),
    args: afterSlash.slice(spaceIdx + 1),
  };
}
// [END]

// [START] Built-in command registry.
export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    id: "clear",
    name: "/clear",
    emoji: "🧹",
    description: "현재 대화 비우기",
    kind: "action",
    run: (ctx) => {
      if (ctx.clearChat) void ctx.clearChat();
      return null;
    },
  },
  {
    id: "profile",
    aliases: ["프로필"],
    name: "/profile",
    emoji: "👤",
    description: "다음 모델 프로필로 전환",
    kind: "action",
    run: (ctx) => {
      ctx.cycleProfile?.();
      return null;
    },
  },
  {
    id: "wiki",
    name: "/wiki",
    emoji: "📚",
    description: "위키 탭 열기",
    kind: "action",
    run: (ctx) => {
      ctx.openPane?.("wiki");
      return null;
    },
  },
  {
    id: "models",
    name: "/models",
    emoji: "📦",
    description: "모델 탭 열기",
    kind: "action",
    run: (ctx) => {
      ctx.openPane?.("models");
      return null;
    },
  },
  {
    id: "settings",
    name: "/settings",
    emoji: "⚙️",
    description: "설정 탭 열기",
    kind: "action",
    run: (ctx) => {
      ctx.openPane?.("settings");
      return null;
    },
  },
  // [START] Phase 6.4 roadmap placeholders — the slash UI ships now so
  // commands like /compact /memory /skills /translate feel wired even
  // though the full behaviour lands in follow-up commits.
  {
    id: "compact",
    name: "/compact",
    emoji: "🗜",
    description: "현재 세션 수동 축약 (낡은 메시지 → 요약)",
    kind: "action",
    run: (ctx) => {
      if (ctx.compact) void ctx.compact();
      return null;
    },
  },
  {
    id: "memory",
    name: "/memory",
    emoji: "🧠",
    description: "위키에 Note 추가 — `/memory 기록할 텍스트`",
    kind: "action",
    run: (ctx, args) => {
      const text = args.trim();
      if (!text) return null;
      if (ctx.addMemoryNote) void ctx.addMemoryNote(text);
      return null;
    },
  },
  {
    id: "skills",
    name: "/skills",
    emoji: "✨",
    description: ".ovo/skills 카탈로그 (구현 예정)",
    kind: "action",
    placeholder: true,
  },
  {
    id: "translate",
    name: "/translate",
    emoji: "🌐",
    description: "입력한 텍스트 번역 (구현 예정)",
    kind: "template",
    template: (args) => (args ? `다음 문장을 번역해:\n${args}` : "다음 문장을 번역해:\n"),
  },
  // [END]
];
// [END]

// [START] Filter + sort by how well the token prefixes the command id/name
// (fuzzy prefix match, not full fuzzy). Empty token returns the whole list.
export function filterSlashCommands(token: string): SlashCommand[] {
  const needle = token.trim().toLowerCase();
  if (!needle) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter((c) => {
    if (c.id.startsWith(needle)) return true;
    if (c.aliases?.some((a) => a.toLowerCase().startsWith(needle))) return true;
    return false;
  });
}
// [END]
