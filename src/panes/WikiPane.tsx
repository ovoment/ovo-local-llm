import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Plus, Trash2, Pin, Search } from "lucide-react";
import { useWikiStore } from "../store/wiki";
import type { WikiPage } from "../db/wiki";

// [START] Phase 6.3 — WikiPane
// MVP knowledge library. Two-pane layout: list on the left, editor on the
// right. Search uses FTS5 under the hood (searchWikiPages in db/wiki.ts);
// empty query shows the full catalog, pinned first.

export function WikiPane() {
  const { t } = useTranslation();
  const pages = useWikiStore((s) => s.pages);
  const load = useWikiStore((s) => s.load);
  const create = useWikiStore((s) => s.create);
  const update = useWikiStore((s) => s.update);
  const remove = useWikiStore((s) => s.remove);
  const search = useWikiStore((s) => s.search);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WikiPage[] | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // [START] initial load
  useEffect(() => {
    void load();
  }, [load]);
  // [END]

  // [START] debounced FTS search — empty query clears results
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    const h = setTimeout(() => {
      void search(trimmed, 30).then(setResults);
    }, 200);
    return () => clearTimeout(h);
  }, [query, search]);
  // [END]

  const visible = results ?? pages;
  const selected = useMemo(
    () => visible.find((p) => p.id === selectedId) ?? pages.find((p) => p.id === selectedId) ?? null,
    [visible, pages, selectedId],
  );

  // [START] sync draft when selected page changes
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (selected) {
      setDraftTitle(selected.title);
      setDraftContent(selected.content);
    } else {
      setDraftTitle("");
      setDraftContent("");
    }
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // [END]

  // [START] debounced auto-save of title/content edits
  useEffect(() => {
    if (!selected) return;
    if (draftTitle === selected.title && draftContent === selected.content) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void update(selected.id, { title: draftTitle, content: draftContent });
    }, 600);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [draftTitle, draftContent, selected, update]);
  // [END]

  const titleInputRef = useRef<HTMLInputElement>(null);

  async function handleCreate() {
    // Create a blank page immediately and focus the title input — avoids
    // window.prompt() which is unreliable in the Tauri webview, and matches
    // the Notion / Obsidian / Figma new-item UX.
    const page = await create({ title: t("wiki.untitled") });
    setSelectedId(page.id);
    // Focus the title input on the next paint after state has propagated.
    setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 50);
  }

  async function handleDelete() {
    if (!selected) return;
    const ok = window.confirm(t("wiki.delete_confirm", { title: selected.title }));
    if (!ok) return;
    await remove(selected.id);
    setSelectedId(null);
  }

  async function togglePin() {
    if (!selected) return;
    await update(selected.id, { pinned: !selected.pinned });
  }

  return (
    <div className="h-full flex">
      {/* [START] left column — search + page list */}
      <aside className="w-72 shrink-0 border-r border-ovo-border flex flex-col bg-ovo-surface">
        <div className="p-3 border-b border-ovo-border flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-ovo-muted" aria-hidden />
            <h2 className="text-sm font-semibold text-ovo-text flex-1">{t("wiki.title")}</h2>
            <button
              type="button"
              onClick={() => void handleCreate()}
              title={t("wiki.new")}
              aria-label={t("wiki.new")}
              className="p-1 rounded hover:bg-ovo-surface-solid text-ovo-muted hover:text-ovo-text transition"
            >
              <Plus className="w-4 h-4" aria-hidden />
            </button>
          </div>
          <label className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-ovo-bg border border-ovo-border">
            <Search className="w-3.5 h-3.5 text-ovo-muted" aria-hidden />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("wiki.search_placeholder")}
              className="flex-1 bg-transparent border-0 text-xs text-ovo-text placeholder:text-ovo-muted/60 focus:outline-none"
            />
          </label>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-ovo-muted/70">
              {results !== null ? t("wiki.no_results") : t("wiki.empty")}
            </li>
          ) : (
            visible.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={`w-full text-left px-3 py-2 text-xs border-l-2 transition ${
                    selectedId === p.id
                      ? "bg-ovo-nav-active border-ovo-accent text-ovo-text"
                      : "border-transparent text-ovo-muted hover:bg-ovo-nav-active-hover hover:text-ovo-text"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {p.pinned && <Pin className="w-3 h-3 text-ovo-accent shrink-0" aria-hidden />}
                    <span className="font-medium truncate">{p.title || t("wiki.untitled")}</span>
                  </div>
                  {p.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {p.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="px-1 py-0.5 text-[9px] rounded bg-ovo-surface-solid text-ovo-muted"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>
      {/* [END] */}

      {/* [START] right column — editor */}
      <main className="flex-1 min-w-0 flex flex-col">
        {selected ? (
          <>
            <header className="flex items-center gap-2 px-4 py-3 border-b border-ovo-border">
              <input
                ref={titleInputRef}
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder={t("wiki.untitled")}
                className="flex-1 bg-transparent border-0 text-base font-semibold text-ovo-text placeholder:text-ovo-muted/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void togglePin()}
                title={selected.pinned ? t("wiki.unpin") : t("wiki.pin")}
                aria-label={selected.pinned ? t("wiki.unpin") : t("wiki.pin")}
                className={`p-1.5 rounded transition ${
                  selected.pinned
                    ? "text-ovo-accent bg-ovo-nav-active"
                    : "text-ovo-muted hover:text-ovo-text hover:bg-ovo-surface-solid"
                }`}
              >
                <Pin className="w-4 h-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                title={t("wiki.delete")}
                aria-label={t("wiki.delete")}
                className="p-1.5 rounded text-ovo-muted hover:text-rose-500 hover:bg-rose-500/10 transition"
              >
                <Trash2 className="w-4 h-4" aria-hidden />
              </button>
            </header>
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              placeholder={t("wiki.content_placeholder")}
              spellCheck={false}
              className="flex-1 w-full resize-none px-4 py-4 text-sm font-mono bg-ovo-bg text-ovo-text placeholder:text-ovo-muted/60 focus:outline-none leading-relaxed"
            />
            <footer className="px-4 py-2 border-t border-ovo-border text-[11px] text-ovo-muted">
              {t("wiki.auto_saved", { slug: selected.slug })}
            </footer>
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-ovo-muted">
            <BookOpen className="w-10 h-10" aria-hidden />
            <p className="text-sm">{t("wiki.pick_page")}</p>
          </div>
        )}
      </main>
      {/* [END] */}
    </div>
  );
}
// [END]
