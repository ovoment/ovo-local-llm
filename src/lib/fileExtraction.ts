// [START] Phase 5 — file-content extraction for chat attachments.
// Converts non-image attachments (text / PDF / xlsx / docx …) into plain
// text blobs the LLM can reason about via the regular message content.
// Parsers are dynamic-imported so their bundles (pdfjs ~1 MB, xlsx ~500 KB)
// only load when the user actually drops a relevant file.
//
// Called from chat.ts' `messageToWire`. The text block is wrapped in a
// `<attached_file>` tag so the model can see the filename and treat the
// content as a reference block rather than user prose.

export interface ExtractedFile {
  filename: string;
  mime: string;
  kind: "text" | "pdf" | "excel" | "docx" | "hwp" | "kordoc" | "skipped";
  text: string;
  /** True when the extracted text was truncated due to size. */
  truncated?: boolean;
  /** Human-readable note appended when extraction was skipped or partial. */
  note?: string;
}

// Cap per-file text so a multi-MB CSV doesn't blow the model's context.
// Most local MLX models top out at 32k context — 80 KB of UTF-8 text is
// roughly 20 k tokens, which leaves comfortable headroom for the system
// prompt, chat history, and the model's own answer. Users with 128 k+
// context windows can pump this up via `setExtractionLimit()` later.
const MAX_TEXT_BYTES = 200_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "csv", "tsv", "json", "jsonl", "ndjson",
  "xml", "html", "htm", "css", "scss", "sass", "less",
  "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "py", "rs", "go", "java", "kt", "swift", "rb", "php", "c", "cpp", "cc",
  "h", "hpp", "cs", "m", "mm",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "yml", "yaml", "toml", "ini", "conf", "cfg", "properties", "env",
  "log", "lock", "gitignore", "dockerfile", "makefile",
  "sql", "graphql", "proto", "svg",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function isTextMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  if (mime === "application/xml") return true;
  if (mime === "application/x-yaml" || mime === "application/yaml") return true;
  if (mime === "application/toml") return true;
  if (mime === "application/javascript" || mime === "application/typescript") return true;
  if (mime === "application/x-sh") return true;
  return false;
}

// Read a Blob as a base64 string (no data-URL prefix). Uses FileReader
// because btoa() chokes on UTF-8 bytes above 0xFF — PDFs / xlsx / docx
// are all binary blobs well outside ASCII.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = typeof fr.result === "string" ? fr.result : "";
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : "");
    };
    fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"));
    fr.readAsDataURL(blob);
  });
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_BYTES) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_TEXT_BYTES)}\n… [truncated at ${MAX_TEXT_BYTES} bytes]`,
    truncated: true,
  };
}

/** Main entry: inspect the file and extract text via the matching parser. */
export async function extractAttachmentText(file: File): Promise<ExtractedFile> {
  const name = file.name || "attachment";
  const mime = file.type || "";
  const ext = extensionOf(name);

  // Images / audio are handled elsewhere as multimodal parts — caller only
  // passes text-target files here, but guard defensively.
  if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")) {
    return {
      filename: name,
      mime,
      kind: "skipped",
      text: "",
      note: "media handled via multimodal parts",
    };
  }

  // HWP / HWPX — route through sidecar kordoc parser (best-in-class Korean doc parsing).
  if (ext === "hwp" || ext === "hwpx") {
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch("http://127.0.0.1:11437/ovo/parse", {
        method: "POST",
        body: form,
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        return {
          filename: name, mime, kind: "skipped", text: "",
          note: `hwp parse failed: sidecar ${resp.status} ${err}`,
        };
      }
      const payload = (await resp.json()) as {
        full_text: string;
        pages: number;
        tokens_estimate: number;
      };
      const { text, truncated } = truncate(payload.full_text);
      return { filename: name, mime, kind: "hwp", text, truncated };
    } catch (e) {
      return {
        filename: name, mime, kind: "skipped", text: "",
        note: `hwp parse failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // PPTX — route through sidecar kordoc parser.
  if (ext === "pptx") {
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch("http://127.0.0.1:11437/ovo/parse", {
        method: "POST",
        body: form,
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        return {
          filename: name, mime, kind: "skipped", text: "",
          note: `pptx parse failed: sidecar ${resp.status} ${err}`,
        };
      }
      const payload = (await resp.json()) as { full_text: string };
      const { text, truncated } = truncate(payload.full_text);
      return { filename: name, mime, kind: "kordoc", text, truncated };
    } catch (e) {
      return {
        filename: name, mime, kind: "skipped", text: "",
        note: `pptx parse failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // Excel — SheetJS — all sheets concatenated as CSV with `### Sheet: NAME` headers.
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    ext === "xlsx" ||
    ext === "xls"
  ) {
    try {
      const xlsx = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = xlsx.read(buf, { type: "array" });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        if (!sheet) continue;
        const csv = xlsx.utils.sheet_to_csv(sheet);
        parts.push(`### Sheet: ${sheetName}\n${csv}`);
      }
      const { text, truncated } = truncate(parts.join("\n\n"));
      return { filename: name, mime, kind: "excel", text, truncated };
    } catch (e) {
      return {
        filename: name,
        mime,
        kind: "skipped",
        text: "",
        note: `excel parse failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // PDF — delegated to the sidecar (PyMuPDF). pdfjs-dist kept tripping
  // on Tauri WebView quirks (worker URL resolution, ReadableStream), so
  // we push the bytes to the Python sidecar which has battle-tested
  // extraction and doesn't care about browser transport layers.
  if (mime === "application/pdf" || ext === "pdf") {
    try {
      const buf = await file.arrayBuffer();
      const b64 = await blobToBase64(new Blob([buf]));
      const resp = await fetch(
        "http://127.0.0.1:11437/ovo/files/extract_pdf",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data_b64: b64,
            filename: name,
            max_bytes: MAX_TEXT_BYTES,
          }),
        },
      );
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        return {
          filename: name,
          mime,
          kind: "skipped",
          text: "",
          note: `pdf parse failed: sidecar ${resp.status} ${err}`,
        };
      }
      const payload = (await resp.json()) as {
        filename: string;
        num_pages: number;
        text: string;
        truncated: boolean;
      };
      return {
        filename: name,
        mime,
        kind: "pdf",
        text: payload.text,
        truncated: payload.truncated,
      };
    } catch (e) {
      return {
        filename: name,
        mime,
        kind: "skipped",
        text: "",
        note: `pdf parse failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // DOCX — mammoth, returns raw text (tables flattened, images dropped).
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    try {
      const mammoth = await import("mammoth");
      const buf = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buf });
      const { text, truncated } = truncate(result.value);
      return { filename: name, mime, kind: "docx", text, truncated };
    } catch (e) {
      return {
        filename: name,
        mime,
        kind: "skipped",
        text: "",
        note: `docx parse failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // Text-like — mime or extension match.
  if (isTextMime(mime) || TEXT_EXTENSIONS.has(ext)) {
    try {
      const raw = await file.text();
      const { text, truncated } = truncate(raw);
      return { filename: name, mime, kind: "text", text, truncated };
    } catch (e) {
      return {
        filename: name,
        mime,
        kind: "skipped",
        text: "",
        note: `read failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return {
    filename: name,
    mime,
    kind: "skipped",
    text: "",
    note: `unsupported file type (mime=${mime || "?"}, ext=.${ext || "?"})`,
  };
}

/** Format an ExtractedFile as a wire-friendly `<attached_file>` block. */
export function formatAttachedFileBlock(ef: ExtractedFile): string {
  if (ef.kind === "skipped") {
    return `<attached_file filename="${ef.filename}" mime="${ef.mime}" skipped="true">${ef.note ?? ""}</attached_file>`;
  }
  const header = `<attached_file filename="${ef.filename}" mime="${ef.mime}" kind="${ef.kind}"${
    ef.truncated ? ' truncated="true"' : ""
  }>`;
  return `${header}\n${ef.text}\n</attached_file>`;
}
// [END] Phase 5
