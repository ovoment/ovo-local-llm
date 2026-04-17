# OVO MLX — 남은 작업

**마지막 업데이트:** 2026-04-18 (Phase R 설계 기반)  
**현재 상태:** R.0~R.2 완료 + R.3~R.7 미작업  
**앞의 3단계는 생략됨** (DB 스키마, 사이드카 보강, 프론트 리팩토링 완료)

---

## 현재 상태 (한줄 요약)

Phase R (멀티 세션 + 컨텍스트 관리) 개발 중. DB 스키마 및 사이드카 보강 완료. 나머지는 UI 계층 4단계 (Recents 섹션, 하단 바 인디케이터, auto-compact 엔진, Settings 확장).

---

## R.3 Sidebar Recents

**작업 범위:** Chat 탭 활성 시 Sidebar 하단에 세션 목록 표시. 고정/최근 그룹, 새 세션 버튼, 우클릭 메뉴.

**파일 경로:**
- `src/components/RecentsPanel.tsx` (신규)
- `src/components/SessionItem.tsx` (신규)
- `src/components/Sidebar.tsx` (수정 — `active === 'chat'` 조건부 렌더)

**핵심 동작:**
- RecentsPanel: 접기/펼치기 (상태 localStorage `ovo:recents_expanded`), 새 세션 버튼 `+`, 검색 input, 고정된 항목들 / 최근 항목들 (collapse 가능)
- SessionItem: 세션 제목 + 모델 배지(옅은 색) + 컨텍스트 사용률 마이크로 도트 (4px, 색: 녹/노/빨), 우클릭 메뉴 (이름변경/핀토글/복제/삭제)
- 클릭 시 세션 전환: `useSessionsStore.setCurrentSession(id)` → ChatPane 자동 메시지 재로드
- i18n 키: `recents.title`, `recents.new_session`, `recents.pinned`, `recents.recent`, `recents.search`, `session_menu.*`

**검증 기준:**
- 세션 생성 후 Recents에 즉시 표시
- 고정/최근 그룹 정렬 정상 (pinned desc, 이후 updated_at desc)
- 우클릭 메뉴 모두 동작 (이름변경 → DB + UI 반영, 핀 토글, 복제 → 새 id 생성, 삭제 → 세션 제거)

---

## R.4 ContextIndicator

**작업 범위:** 하단 바 (AppShell footer) — 원형 ring 프로그레스 + 호버 툴팁 + Reset 드롭다운.

**파일 경로:**
- `src/components/ContextIndicator.tsx` (신규)
- `src/components/AppShell.tsx` (수정 — footer에 vertical separator + ContextIndicator 추가)

**핵심 동작:**
- SVG 도넛 ring: `context_tokens / max_context` 백분율 시각화 (0~100%)
- 색상 단계:
  - 🟢 녹색: 0~50% (안전)
  - 🟡 노랑: 50~75% (주의 구간 시작)
  - 🟠 주황: 75~85% (경고 임박)
  - 🔴 빨강: ≥ 85% (warn_threshold 기본값, 모델별 override 가능)
- 호버 툴팁 (Claude 스타일):
  ```
  38% of context remaining until auto-compact.
  12,450 / 32,768 tokens used
  Click ring to compact now.
  ```
- 텍스트: 원 옆에 `12,450 / 32,768 (38%)` 작게 표시 (i18n)
- Reset 드롭다운 (버튼):
  - 🆕 새 세션으로 탈출 — 현재 세션 그대로 보존 + 같은 모델로 새 session_id 생성 + 전환
  - 🧹 메시지 지우기 — session_id 유지, messages 전체 삭제, context_tokens = 0
- ring 자체 클릭 = 수동 compact 실행 (드롭다운 아님)

**검증 기준:**
- 짧은 대화: ring 초록색 (50% 이하)
- 긴 대화: 색 단계 전환 (50% → 75% → 85%)
- 호버 시 툴팁 표시, 벗어나면 숨김
- ring 클릭 → compact 즉시 실행
- Reset 드롭다운 → "새 세션으로 탈출" 클릭 → 새 session_id 활성, Recents에 이전 세션 그대로
- Reset 드롭다운 → "메시지 지우기" 클릭 → messages 비움, context_tokens = 0, UI 즉시 반영

---

## R.5 Auto-compact 엔진

**작업 범위:** 스트리밍 종료 시 context_tokens 체크, 임계치 도달 시 백그라운드 요약 + 메시지 압축.

**파일 경로:**
- `src/lib/compact.ts` (신규)
- `src/store/chat.ts` (수정 — 스트리밍 종료 hook에서 `maybeAutoCompact()` 호출)
- `src/panes/ChatPane.tsx` (수정 — UI 차단 플래그 렌더)

**핵심 동작:**
- `shouldCompact(context_tokens, max_context, warn_threshold, compact_strategy)` → boolean
  - strategy 확인: `'auto'`만 자동 실행 (manual/warn_only는 UI 표시만)
- `pickCompactionSlice(messages)` → 오래된 메시지 절반 선정 (첫 user 이후 ~ 현재 길이의 50% 지점까지)
- `runCompact(sessionId)` — 백그라운드, non-blocking:
  1. 선정된 메시지 목록 추출
  2. `POST /ovo/summarize {session_id, message_ids: [...]}` 호출 (같은 모델로 "Summarize the following conversation turns..." 프롬프트)
  3. 결과를 새 `role='summary'` 메시지로 삽입 (timestamp: 선정 범위 마지막 메시지 직후)
  4. 선정된 원본들은 `compacted = 1`로 마킹 (삭제 X — UI에서 "[압축됨] 이전 대화 요약" 아코디언으로 볼 수 있음)
  5. 다음 턴 전송 시 `compacted = 0`인 메시지만 포함
- compact 진행 중 `compacting: true` 플래그 → ChatInput disabled + toast "컨텍스트 최적화 중..."
- 성공 toast: "자동 요약으로 컨텍스트 45% 확보 ✨"
- 실패 toast: "요약 실패. 수동으로 압축하세요."

**검증 기준:**
- threshold 도달 후 백그라운드 compact 자동 시작 (사용자 액션 불필요)
- compact 진행 중 ChatInput 비활성화
- 결과 메시지(role='summary') DB 저장 확인
- 다음 턴 전송 시 compacted=1 제외, summary 포함 확인
- 메시지 휴지통 같은 아코디언으로 "[압축됨] 이전 대화" 팽창 가능
- Context ring이 즉시 내려감 (context_tokens 감소)

---

## R.6 Settings 확장 + 모델별 override

**작업 범위:** SettingsPane에 컨텍스트 관리 섹션 추가. 모델별 max_context + warn_threshold override.

**파일 경로:**
- `src/panes/SettingsPane.tsx` (수정)
- `src/db/model_overrides.ts` (신규 — model_context_overrides CRUD)

**핵심 동작:**
- 언어 + 포트 섹션 이하 "컨텍스트 관리 ★ 신규" 섹션 추가:
  - 라디오 선택: Auto-compact (기본) / 수동 compact만 / 경고만 (compact 없음)
  - 경고 임계치 슬라이더: 0~100%, 기본값 75%
  - 모델별 max_context override 테이블:
    - 컬럼: 모델명 | max_context | 작업(✏️ 수정/❌ 삭제)
    - 자동 감지된 값 옆에 "(자동 감지)" 라벨
    - "+ 모델 override 추가" 버튼 → 모달: 모델 선택 드롭다운 + 수치 입력
- 저장: localStorage (compact_strategy, warn_threshold 전역 기본값) + SQLite (model_context_overrides 테이블)
- 세션 생성 시 설정값이 세션의 기본값으로 복사됨

**검증 기준:**
- 라디오 선택 → localStorage에 저장 → 앱 재시작 후 유지
- 슬라이더 조정 → ContextIndicator 색 즉시 변경
- 모델 override 추가 → 테이블에 행 추가, ContextIndicator 기준값 변경 (모델 스왑 시)
- override 삭제 → 테이블에서 제거, 자동 감지값으로 복구
- 새 세션 생성 시 현재 설정값 적용

---

## R.7 i18n + 빌드 검증

**작업 범위:** 남은 i18n 키 추가 + 전체 빌드/타입체크 통과 + 수동 테스트 체크리스트.

**파일 경로:**
- `src/locales/ko.json` (수정)
- `src/locales/en.json` (수정)

**신규 i18n 키 (한글 기준, 영문 대응):**
```json
{
  "recents": {
    "title": "최근 대화",
    "new_session": "새 세션",
    "pinned": "고정됨",
    "recent": "최근",
    "search": "검색…"
  },
  "session_menu": {
    "rename": "이름 변경",
    "pin": "고정",
    "unpin": "고정 해제",
    "duplicate": "복제",
    "delete": "삭제"
  },
  "context": {
    "title": "컨텍스트",
    "remaining": "남은 컨텍스트",
    "until_compact": "자동 요약까지",
    "tokens_used": "토큰 사용",
    "click_to_compact": "클릭하여 지금 압축",
    "reset": "리셋",
    "escape_session": "새 세션으로 탈출",
    "clear_messages": "메시지 지우기"
  },
  "settings_context": {
    "title": "컨텍스트 관리",
    "strategy_auto": "자동 압축 (기본)",
    "strategy_manual": "수동 압축만",
    "strategy_warn": "경고만 (압축 없음)",
    "warn_threshold": "경고 임계치 (%)",
    "model_overrides": "모델별 max_context override",
    "auto_detected": "자동 감지",
    "add_override": "모델 override 추가",
    "edit": "수정",
    "remove": "제거"
  },
  "compact": {
    "in_progress": "컨텍스트 최적화 중…",
    "success": "자동 요약으로 컨텍스트 {percent}% 확보 ✨",
    "failed": "요약 실패. 수동으로 압축하세요.",
    "compacted_label": "[압축됨] 이전 대화 요약"
  }
}
```

**빌드 검증:**
```bash
cd /Volumes/docker/project/ovomlx
npm run build              # 프론트 tsc + vite build
cd src-tauri && cargo check # rust 컴파일 (추가 warnings 없음)
cd ../sidecar && uv run pytest  # (있으면) 사이드카 테스트
```

**수동 테스트 체크리스트:**
1. 세션 생성: "+ 새 세션" 버튼 → 빈 ChatPane, 첫 메시지 전송 → Recents에 즉시 표시 ✓
2. 세션 전환: Recents에서 다른 세션 클릭 → 메시지 히스토리 복원 + 모델 자동 선택 ✓
3. 세션 이름변경/핀/삭제: 우클릭 메뉴 전부 동작 ✓
4. 자동 제목 생성: 첫 메시지 후 즉시 앞 24자 / 3번째 메시지 후 모델 요약으로 업그레이드 ✓
5. 컨텍스트 미터: 긴 대화로 usage 증가 확인, 50/75/90% 임계치마다 색 전환 ✓
6. 호버 툴팁: ring hover 시 "XX% remaining" + "Click to compact" ✓
7. 수동 compact: ring 클릭 → 즉시 compact 실행 (드롭다운 아님) ✓
8. 새 세션 탈출: Reset → "새 세션으로 탈출" → Recents에 이전 세션 그대로 + 새 세션 active ✓
9. 메시지 지우기: Reset → "메시지 지우기" → 같은 session_id 유지, messages 비움 ✓
10. 모델별 override: Settings에서 Qwen3.5-MoE max_context를 32768로 설정 → ContextIndicator 32768 기준으로 % 계산 ✓
11. Auto-compact 트리거: threshold 도달 → 백그라운드 summarize → "[압축됨] 이전 대화 요약" 메시지 + context 사용률 급락 + toast ✓
12. 모델 스왑: 세션 A (모델 X)에서 세션 B (모델 Y)로 전환 시 사이드카 single-slot tenancy로 X unload → Y load ✓

---

## 커밋 순서 (원래 제안에서 R.3 이후만)

1. `feat(ui): Recents sidebar panel` (R.3)
2. `feat(ui): context indicator with ring + tooltip + reset menu` (R.4)
3. `feat(ui): auto-compact engine` (R.5)
4. `feat(ui): settings — context management + model overrides` (R.6)
5. `chore: i18n + build verification` (R.7)

---

## Open Questions / 미확인 항목

1. **torch + torchvision 검증:** Qwen3.6(VLM) 로드 성공하나 다른 모델 스왑 테스트는 미완료. 다음 세션 "빠른 검증 아이디어" 참조.
2. **single-slot tenancy 검증:** 여러 모델 스왑 중 memory 해제 확인 필요.
3. **첨부 파일 영속화:** R에선 base64/메타만. Phase A (백로그)에서 별도 파일 저장소 설계.
4. **compact 품질:** 같은 모델로 요약하면 VRAM 점유 중복. "요약 전용 경량 모델" 설정 추후.
5. **sidecar venv 경로 정정:** 이전 핸드오버 오류 — 진짜 경로는 `$HOME/Library/Caches/ovo-dev/sidecar-venv` (`.venvs/ovomlx-sidecar` 사용 안 함).
