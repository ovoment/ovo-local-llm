<p align="center">
  <img src="docs/images/logo.jpg" alt="OVO — ovo-local-llm" width="480">
</p>

<p align="center">
  <a href="https://github.com/ovoment/ovo-local-llm/stargazers"><img src="https://img.shields.io/github/stars/ovoment/ovo-local-llm?style=flat&logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/ovoment/ovo-local-llm/releases"><img src="https://img.shields.io/github/downloads/ovoment/ovo-local-llm/total?logo=github&color=brightgreen" alt="Downloads"></a>
  <a href="https://github.com/ovoment/ovo-local-llm/releases/latest"><img src="https://img.shields.io/github/v/release/ovoment/ovo-local-llm?logo=github&color=blue" alt="Release"></a>
  <a href="https://github.com/ovoment/ovo-local-llm/issues"><img src="https://img.shields.io/github/issues/ovoment/ovo-local-llm?logo=github" alt="Issues"></a>
  <a href="https://ko-fi.com/ovoment"><img src="https://img.shields.io/badge/Ko--fi로%20응원하기-ff5e5b?logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/macOS-13%2B-black?logo=apple&logoColor=white" alt="macOS 13+">
  <img src="https://img.shields.io/badge/Apple%20Silicon-M1%20%E2%86%92%20M4-orange" alt="Apple Silicon">
</p>

<h3 align="center">🦉 Apple Silicon 전용 프라이빗 코딩 에이전트</h3>

<p align="center">
  내 코드를 클라우드에 보내지 않고, 내 Mac에서 직접 채팅·코딩·로컬 모델 워크플로를 실행.<br>
  MLX 네이티브. Ollama/OpenAI API 호환. API 키 불필요.
</p>

<p align="center">
  <a href="README.md">🇺🇸 English README</a>
</p>

---

<p align="center">
  <img src="docs/images/chat.png" alt="OVO 채팅" width="860">
</p>

## v0.0.6 변경사항

**문서 파싱 & RAG** — PPTX, HWP, HWPX 파싱 (kordoc 기반). 스캔 PDF OCR 지원. Knowledge Base에서 관련 문서를 채팅 컨텍스트에 자동 주입.

**LoRA 파인튜닝** — 데이터셋 생성, 학습, 어댑터 머지까지 `mlx-lm` 전체 파이프라인. rank/layers/epochs 설정 가능.

**모델 블렌딩** — 같은 아키텍처 모델 2개를 SLERP, Linear, TIES, DARE 방식으로 합성. 진행률 GUI 포함.

**핑퐁 강화** — 파일/코드/URL 첨부, 편집기 스타일 코드블록 (다크 배경 + 라인넘버), 긴 응답 자동 분할, 입력중 표시, thinking 자동 제거.

**기타** — 웹 검색은 명시적 요청 시에만 호출. 설정 페이지 카드 그룹핑. 파일 추출 한도 200 KB로 확대. Mac 칩 이름 하드웨어 카드에 표시.

---

## 기능

### Chat — 모든 로컬 LLM을 하나의 인터페이스로

Ollama / OpenAI API 완전 호환, 스트리밍 응답, 세션 최근 목록, 페르소나 전환, 파일 첨부 (PDF · Excel · Word · 이미지), 음성 입력 + TTS 자동 언어 감지 (ko / en / ja / zh).

### Code IDE — 손을 가진 에이전트

<p align="center">
  <img src="docs/images/code.png" alt="OVO Code IDE" width="860">
</p>

Monaco 에디터 + 파일 탐색기 + Git 패널 + PTY 터미널 + AI 인라인 자동완성. 오른쪽의 Agent Chat은 **파일 읽기/쓰기/검색/실행** 도구와 MCP 서버 통합을 갖춘 에이전트 — 말로만 설명하는 게 아니라 실제로 작업을 수행합니다.

### 이미지 생성 — 내 노트북 위의 Diffusion

<p align="center">
  <img src="docs/images/image.png" alt="OVO 이미지 생성" width="860">
</p>

`diffusers` 기반 로컬 text-to-image. 샘플러 / 스텝 / CFG / LoRA 조절. 90 % 케이스를 위한 스타일 프리셋 제공.

### Wiki — 세션을 넘어 이어지는 지식

<p align="center">
  <img src="docs/images/wiki.png" alt="OVO 위키" width="860">
</p>

큐레이션 노트 + 자동 캡처 세션 로그, BM25 + 시맨틱 검색. 로컬 모델이 위키를 조회해서 재시작 후에도 컨텍스트를 유지합니다.

### Models — HuggingFace 네이티브, 중복 다운로드 제로

<p align="center">
  <img src="docs/images/models.png" alt="OVO 모델 탭" width="860">
</p>

`~/.cache/huggingface/hub/` + LM Studio 캐시를 자동 감지. 이미 받아둔 모델은 그대로 목록에 뜸. Tier 뱃지 (Supported / Experimental), tok/s 벤치마크, vision / audio 능력 플래그 표시.

### Hardware Fit — 내 맥에 진짜로 돌아가는 모델

<p align="center">
  <img src="docs/images/hardwarefit.png" alt="OVO 하드웨어 적합도" width="860">
</p>

RAM / GPU / 컨텍스트 여유도에 맞춰 모든 모델을 점수화. 마케팅 문구가 아니라 **내 기기에서의 실제 성능**으로 정렬된 추천.

### 데스크톱 마스코트

<p align="center">
  <img src="docs/images/pet1.png" alt="부엉이 — 생각 중" width="320">
  &nbsp;&nbsp;
  <img src="docs/images/pet2.png" alt="부엉이 — 대기" width="320">
</p>

데스크톱 위에 앉아서 코딩 상태 (대기 / 생각 / 타이핑 / 기쁨) 에 따라 모션이 바뀌는 SVG 부엉이. 더블클릭하면 메인 창이 올라옵니다.

## 설치

1. [**Releases**](https://github.com/ovoment/ovo-local-llm/releases) 에서 최신 `OVO_x.y.z_aarch64.dmg` 다운로드.
2. DMG 창이 뜨면 **OVO.app** 을 오른쪽의 **Applications** 바로가기로 드래그.
3. 같은 DMG 창 안의 **`Install OVO.command`** 파일을 더블클릭.
   실행할 명령을 먼저 보여주고, **Run** 버튼을 누르면 끝. 터미널 필요 없음.

<details>
<summary>3단계가 왜 필요한가요? (펼치기)</summary>

OVO 빌드는 아직 Apple Developer ID 서명이 없어요 ($99/년 가입은 로드맵에
있고 [Issues](https://github.com/ovoment/ovo-local-llm/issues) 에 마일스톤으로
올라와 있어요). 서명이 없으면 macOS가 `com.apple.quarantine` 플래그를
붙여서 *"OVO is damaged and can't be opened"* 다이얼로그로 실행을 막습니다.

`Install OVO.command` 는 딱 이 한 줄만 실행해서 해당 플래그를 지워줍니다:

```bash
xattr -rd com.apple.quarantine /Applications/OVO.app
```

`sudo` 없음, 네트워크 호출 없음, 백그라운드 프로세스 없음. 실행 전에
스크립트 전체를 읽어보세요:
[scripts/dmg-templates/Install OVO.command](scripts/dmg-templates/Install%20OVO.command)

</details>

<details>
<summary>터미널로 직접 하고 싶으신 분</summary>

```bash
xattr -rd com.apple.quarantine /Applications/OVO.app
open /Applications/OVO.app
```

드문 경우지만 `/Applications/OVO.app` 이 `root` 소유라면 앞에 `sudo` 를
붙여주세요.

</details>

**첫 실행 시** `~/Library/Application Support/com.ovoment.ovo/runtime/` 에 Python 런타임을 설치합니다 (약 1.5 GB, 3분, 1회). 이후 실행은 즉시 가동.

### 시스템 요구사항

- macOS **13+** Apple Silicon (M1 / M2 / M3 / M4). Intel 미지원.
- **16 GB RAM** 최소 (7B 모델 기준), **32 GB+** 권장 (14B 이상).
- 런타임 + 모델 1-2개를 위한 **10 GB** 여유 디스크.

## 빠른 시작

1. OVO 실행.
2. **Models** 탭에서 모델 선택 (Qwen3, Llama 3.3, Gemma, Mistral, DeepSeek, ...) → 다운로드.
3. **Chat** 에서 메시지 전송 — 로컬 모델이 응답, 외부 API 호출 없음.
4. 필요하면 **Code** 탭에서 프로젝트 폴더를 열어 IDE + Agent Chat 사용.

## API 호환성

| 종류 | 포트 | 용도 |
|------|:----:|------|
| Ollama | `11435` | Ollama 클라이언트 대체 (Open WebUI, Page Assist, ...) |
| OpenAI | `11436` | `base_url` 을 `http://localhost:11436/v1` 로 지정 |
| Native | `11437` | OVO 전용 엔드포인트 — 모델 관리, Wiki, 스트리밍, 음성 |

## Claude Code 통합 (선택)

로컬 Claude Code 설정을 **읽기만** 해서 로컬 모델과 컨텍스트를 공유합니다:

- `CLAUDE.md` — 시스템 컨텍스트로 주입
- `.claude/settings.json` — 설정 반영
- `.claude/plugins/**` — 동작 힌트

기본 비활성화. **Settings → Claude Integration** 에서 활성화. OVO는 claude.ai, API 키, 세션 토큰 등 Claude 계정에 영향을 줄 수 있는 어떤 것도 절대 건드리지 않습니다.

## 개발

```bash
git clone https://github.com/ovoment/ovo-local-llm.git
cd ovo-local-llm

# 프론트엔드 + Rust 의존성
npm install

# Python 사이드카 venv (dev는 $HOME 캐시 사용, SMB 락 회피)
cd sidecar && uv sync && cd ..

# 전체 스택 dev 실행
npm run tauri dev
```

릴리스 빌드: `npm run tauri build` — Cargo 타겟 디렉토리에 `.app` + `.dmg` 생성.

자세한 문서: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/release/BUILD.md](docs/release/BUILD.md) · [docs/release/SECURITY.md](docs/release/SECURITY.md) · [docs/release/PRIVACY.md](docs/release/PRIVACY.md)

## 아키텍처

- **쉘** — Tauri 2 (Rust)
- **프론트엔드** — React 18 + TypeScript + Tailwind + shadcn/ui + Monaco
- **사이드카** — Python 3.12 FastAPI, Rust가 생성, 번들된 `uv` 로 첫 실행 시 유저 캐시에 venv 부트스트랩
- **런타임** — `mlx-lm`, `mlx-vlm`, `mlx-whisper`, `transformers`, `diffusers`
- **스토리지** — SQLite (채팅 + Wiki), 로컬 파일시스템 (첨부, 모델)

## 후원

OVO는 1인 개발자 프로젝트입니다. 커피 한 잔 = 지원 가능한 모델 아키텍처 하나 늘어남.

<p align="center">
  <a href="https://ko-fi.com/ovoment"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Ko-fi에서 응원하기"></a>
</p>

## 라이선스

[MIT](LICENSE) — 사용 · 포크 · 배포 자유.

<p align="center">
  <img src="docs/images/info.png" alt="OVO 정보" width="720">
</p>

<p align="center">
  Made with 🦉 by <a href="https://github.com/ovoment">ben @ ovoment</a>
</p>
