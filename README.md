<p align="center">
  <img src="docs/images/logo.jpg" alt="OVO — ovo-local-llm" width="480">
</p>

<p align="center">
  <a href="https://github.com/ovoment/ovo-local-llm/stargazers"><img src="https://img.shields.io/github/stars/ovoment/ovo-local-llm?style=flat&logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/ovoment/ovo-local-llm/releases"><img src="https://img.shields.io/github/downloads/ovoment/ovo-local-llm/total?logo=github&color=brightgreen" alt="Downloads"></a>
  <a href="https://github.com/ovoment/ovo-local-llm/releases/latest"><img src="https://img.shields.io/github/v/release/ovoment/ovo-local-llm?logo=github&color=blue" alt="Release"></a>
  <a href="https://github.com/ovoment/ovo-local-llm/issues"><img src="https://img.shields.io/github/issues/ovoment/ovo-local-llm?logo=github" alt="Issues"></a>
  <a href="https://ko-fi.com/ovoment"><img src="https://img.shields.io/badge/Support%20on-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/macOS-13%2B-black?logo=apple&logoColor=white" alt="macOS 13+">
  <img src="https://img.shields.io/badge/Apple%20Silicon-M1%20%E2%86%92%20M4-orange" alt="Apple Silicon">
</p>

<h3 align="center">🦉 A private Claude-Code-style coding agent for Apple Silicon</h3>

<p align="center">
  Run chat, code, and local model workflows on-device — without shipping your work to the cloud.<br>
  MLX-native. Ollama/OpenAI API compatible. Zero API keys.
</p>

<p align="center">
  <a href="README.ko.md">🇰🇷 한국어 README</a>
</p>

---

<p align="center">
  <video src="https://github.com/user-attachments/assets/ff9f97cc-7a5c-4627-a547-d060ae1f2b86" width="860" controls autoplay muted loop>
    Your browser does not support the video tag.
  </video>
</p>

<p align="center">
  <img src="docs/images/chat.png" alt="OVO chat" width="860">
</p>

## What's New in v0.0.6

**Document parsing & RAG** — PPTX, HWP, HWPX parsing via kordoc. OCR for scanned PDFs. Knowledge Base auto-injects relevant docs into chat context.

**LoRA fine-tuning** — Dataset creation, training, adapter merge. Full `mlx-lm` pipeline with configurable rank/layers/epochs.

**Model blending** — Merge two same-architecture models via SLERP, Linear, TIES, or DARE. Progress tracking GUI included.

**Ping Pong upgrades** — File/code/URL attachments, editor-style code blocks (dark bg + line numbers), auto-split long responses into multiple bubbles, typing indicator, thinking content stripped from output.

**Other changes** — Web search only fires on explicit request. Settings page grouped into card sections. File extraction limit raised to 200 KB. Mac chip name shown in hardware cards.

---

## Code — a local coding agent with hands

<p align="center">
  <img src="docs/images/code.png" alt="OVO Code IDE" width="860">
</p>

Monaco editor + file explorer + Git panel + PTY terminal + AI inline completion. The Agent Chat on the right gets file read/write/search/exec tools and MCP server integration — it can actually do the work, not just describe it. Like Claude Code, but running on your Mac with any open LLM.

## Also included

### Chat — every open LLM, one interface

Native Ollama/OpenAI API compatibility, streaming responses, persona switching, file attachments (PDF / Excel / Word / images), voice input + TTS.

### Image generation — diffusion on your laptop

<p align="center">
  <img src="docs/images/image.png" alt="OVO image generation" width="860">
</p>

Local text-to-image via `diffusers`. Sampler / steps / CFG / LoRA controls.

### Wiki — persistent knowledge across sessions

<p align="center">
  <img src="docs/images/wiki.png" alt="OVO wiki" width="860">
</p>

Curated notes + auto-captured session logs with BM25 + semantic search. Context that survives restarts.

### Models — HuggingFace-native, zero re-downloads

<p align="center">
  <img src="docs/images/models.png" alt="OVO models tab" width="860">
</p>

Auto-detects `~/.cache/huggingface/hub/` + LM Studio cache — models you already have just show up. Download from URL or search HuggingFace directly.

OVO is model-agnostic. Recommended by origin:
- **US** — Llama (Meta), Gemma (Google), Phi (Microsoft)
- **EU** — Mistral / Mixtral (Mistral AI, France)
- **Asia** — Qwen (Alibaba), DeepSeek, GLM

All models run fully local — no data leaves your machine.

### Hardware fit — pick a model that actually runs

<p align="center">
  <img src="docs/images/hardwarefit.png" alt="OVO hardware fit" width="860">
</p>

Scores every model against your RAM / GPU / context headroom. Know before you download.

### Desktop mascot

<p align="center">
  <img src="docs/images/pet1.png" alt="Owl — thinking" width="320">
  &nbsp;&nbsp;
  <img src="docs/images/pet2.png" alt="Owl — idle" width="320">
</p>

An SVG owl that reacts to your coding state. Double-click to summon the main window.

## Install

1. Download the latest `OVO_x.y.z_aarch64.dmg` from [**Releases**](https://github.com/ovoment/ovo-local-llm/releases).
2. Open the DMG and drag **OVO.app** onto the **Applications** shortcut.
3. Back in the DMG window, double-click **`Install OVO.command`**.
   It shows you exactly the one command it will run, you click **Run**, done.

That's it — no Terminal required.

<details>
<summary>Why the third step? (click to expand)</summary>

OVO's build is not yet signed with an Apple Developer ID (the $99/yr
membership is on the roadmap — see the milestone in [Issues](https://github.com/ovoment/ovo-local-llm/issues)).
Without a signature, macOS flags the app with `com.apple.quarantine` and
refuses to launch it with the classic *"OVO is damaged and can't be opened"*
dialog.

`Install OVO.command` runs a single command to clear that flag:

```bash
xattr -rd com.apple.quarantine /Applications/OVO.app
```

No `sudo`, no network, no background processes. The script is short and
auditable — read it here before running:
[scripts/dmg-templates/Install OVO.command](scripts/dmg-templates/Install%20OVO.command)

</details>

<details>
<summary>Prefer to do it by hand?</summary>

```bash
xattr -rd com.apple.quarantine /Applications/OVO.app
open /Applications/OVO.app
```

If your `/Applications/OVO.app` happens to be owned by `root` (rare on
recent macOS), prefix with `sudo`.

</details>

**First launch** bootstraps a Python runtime into `~/Library/Application Support/com.ovoment.ovo/runtime/` (≈1.5 GB, ~3 min, one-time). Subsequent launches are instant.

### System requirements

- macOS **13+** on Apple Silicon (M1 / M2 / M3 / M4). Intel Macs are not supported.
- **16 GB RAM** minimum (7B Q4 models only); **32 GB+** recommended for 14B and above.
- **10 GB** free disk for runtime + a couple of models.

> **16 GB users:** Only 7B quantized (Q4) models run comfortably. Disable extra features in **Settings → Feature Flags** (Wiki, Skills, MCP) to keep the system prompt lean and maximize response speed. The **Hardware Fit** tab shows which models actually fit your machine.

## Quick start

1. Launch OVO.
2. Go to **Models**, pick a model (Qwen3, Llama 3.3, Gemma, Mistral, DeepSeek, …), click download.
3. Open **Chat** and send a message — the local model answers, no network calls.
4. Open a project folder in **Code** to use the IDE + Agent Chat.

## API compatibility

| Flavor | Port | Use case |
|--------|:----:|----------|
| Ollama | `11435` | Drop-in replacement for Ollama clients (Open WebUI, Page Assist, …) |
| OpenAI | `11436` | Point any OpenAI SDK at `http://localhost:11436/v1` |
| Native | `11437` | OVO-specific endpoints — model management, Wiki, streaming, voice |

## Claude Code integration (opt-in)

OVO can **read** your local Claude Code config so the same context reaches your local model:

- `CLAUDE.md` — injected as system context
- `.claude/settings.json` — preferences honoured
- `.claude/plugins/**` — behaviour hints

Disabled by default. Flip it on in **Settings → Claude Integration**. OVO never touches claude.ai, API keys, session tokens, or anything that could affect your Claude account.

## Development

```bash
git clone https://github.com/ovoment/ovo-local-llm.git
cd ovo-local-llm

# frontend + Rust deps
npm install

# Python sidecar venv (dev uses $HOME cache, avoids SMB locks)
cd sidecar && uv sync && cd ..

# run the full stack in dev mode
npm run tauri dev
```

Release build: `npm run tauri build` — produces `.app` + `.dmg` under your Cargo target dir.

Deeper docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) · [docs/release/BUILD.md](docs/release/BUILD.md) · [docs/release/SECURITY.md](docs/release/SECURITY.md) · [docs/release/PRIVACY.md](docs/release/PRIVACY.md)

## Architecture

- **Shell** — Tauri 2 (Rust)
- **Frontend** — React 18 + TypeScript + Tailwind + shadcn/ui + Monaco
- **Sidecar** — Python 3.12 FastAPI, spawned by Rust, user-cached venv bootstrapped with a bundled `uv`
- **Runtimes** — `mlx-lm`, `mlx-vlm`, `mlx-whisper`, `transformers`, `diffusers`
- **Storage** — SQLite (chats + Wiki), local filesystem (attachments, models)

## Support

OVO is a solo-developer project. Every coffee funds one more model architecture I can patch and support.

<p align="center">
  <a href="https://ko-fi.com/ovoment"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support me on Ko-fi"></a>
</p>

## License

[MIT](LICENSE) — use it, fork it, ship it.

<p align="center">
  <img src="docs/images/info.png" alt="OVO about" width="720">
</p>

<p align="center">
  Made with 🦉 by <a href="https://github.com/ovoment">ben @ ovoment</a>
</p>
