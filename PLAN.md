# Riff — Git Diff Viewer 기획 문서 (초안)

> 두 브랜치 간 변경사항을 가볍게, 가독성 높게, 자동 업데이트되는 데스크톱 앱.
> 본 문서는 grill-me 인터뷰를 통해 합의된 의사결정의 결과물입니다.

---

## 1. 프로젝트 개요

**이름**: Riff (작업 폴더 `C:\DiffViewer`)
**한 줄 설명**: Windows용 경량 Git diff 뷰어. start branch와 target branch를 입력받아 PR 스타일로 전체 파일 변경사항을 보여준다.
**배포 대상**: 개인 프로젝트 + 지인 배포 (~수십 명 규모)
**개발자 환경**: Windows 11

---

## 2. 요구사항 정리

| # | 원본 요구 | 확정된 해석 |
|---|---|---|
| 1 | 가벼운 앱 | 바이너리 ~10MB 이하 목표, 메모리 풋프린트 최소화 |
| 2 | 확장성을 염두, 당장은 diff만 | 내부 **모듈러 아키텍처**(Git / Diff / Render / UI shell layer 분리). 외부 plugin API는 보류 |
| 3 | 언어 선택 syntax highlighting | **자동 감지 + 수동 override** (드롭다운). Shiki 사용, grammar lazy load |
| 4 | 배포 및 버전 업데이트 | **Public GitHub Releases + tauri-plugin-updater**, 인앱 업데이트 체크 |

---

## 3. 기술 스택 결정

| 영역 | 선택 | 핵심 근거 |
|---|---|---|
| **App framework** | **Tauri 2** (Rust + WebView2) | 바이너리 ~5-10MB, 웹 생태계 활용, updater 내장 |
| **Frontend** | **Svelte 5** | 작은 런타임, Tauri 공식 템플릿 지원, 컴포넌트화 깔끔 |
| **Diff 엔진 (UI)** | **CodeMirror 6 + @codemirror/merge** | 모듈러, ~200KB, decoration으로 확장 자유 |
| **Syntax highlighting** | **Shiki** | VSCode 동급 TextMate grammar, 200+ 언어, lazy load 가능 |
| **Git 접근** | **git CLI shell out** (std::process::Command) | 사용자 git 환경/credential/LFS/submodule 그대로 사용, 단순 |
| **비교 모드** | **Three-dot 기본**, Two-dot 토글 | GitHub PR 스타일이 사용자 멘탈모델 일치 |
| **배포 호스팅** | **Public GitHub Releases** | 무료, Tauri updater 공식 지원, 인증 이슈 없음 |
| **자동 업데이트** | **tauri-plugin-updater** + ed25519 서명 | 변조 방지, in-app 체크/설치 |
| **CI/CD** | **GitHub Actions + tauri-action** | tag push (`v*`) → 빌드 → release 자동 |
| **코드 서명** | **MVP는 비서명**, 사용자 가이드로 SmartScreen 우회 안내 | 비용 0, 지인 배포에는 충분 |

---

## 4. 아키텍처 설계

### 4.1 레이어 분리

```
┌─────────────────────────────────────────────┐
│  Svelte UI Shell                            │
│  - 입력바 (repo path, branch combobox)       │
│  - 좌측 파일 리스트 (트리/플랫 토글)         │
│  - 메인 diff 패널 (CodeMirror MergeView)    │
│  - 상태바 (option toggles, theme)            │
└─────────────────────────────────────────────┘
            ▲ IPC (Tauri commands)
┌─────────────────────────────────────────────┐
│  Rust Backend                               │
│  ┌─────────────┐  ┌─────────────┐           │
│  │  GitLayer   │  │ DiffParser  │           │
│  │  (CLI wrap) │  │ (unified →   │           │
│  │             │  │  structured) │           │
│  └─────────────┘  └─────────────┘           │
│  ┌─────────────┐  ┌─────────────┐           │
│  │  Recent     │  │  Updater    │           │
│  │  store      │  │  glue       │           │
│  └─────────────┘  └─────────────┘           │
└─────────────────────────────────────────────┘
```

### 4.2 모듈 인터페이스 (확장성 핵심)

- **`GitLayer` trait**: `list_branches()`, `diff_files(spec)`, `file_diff(spec, path)`, `blame_file(file, rev, use_contents)` (v0.2.x, §12)
  - 현재 구현: `GitCli`. 향후 `LibGit2`, `MockGit` 추가 가능
- **`DiffParser`**: git unified diff → 파일별 hunk 구조체 변환
- **`RecentRepoStore`**: Tauri config dir에 JSON 저장
- **Frontend `diff/`**: CodeMirror MergeView를 감싸는 Svelte 컴포넌트. 언어 감지/Shiki 어댑터 분리

### 4.3 데이터 흐름 (한 비교 세션)

1. 사용자가 repo path 선택 → `GitLayer.open(path)` → `list_branches()` 호출 → combobox 채움
2. start/target 입력 + "비교" 클릭 → `GitLayer.diff_files("A...B")` 호출 (이름/상태/+- 수)
3. 좌측 파일 리스트 렌더
4. 파일 클릭 → `GitLayer.file_diff("A...B", path)` 호출 → 두 버전 텍스트 + hunk 정보 반환
5. Frontend: 확장자로 언어 감지 → Shiki grammar lazy load → MergeView에 전달

---

## 5. MVP Scope (v0.1.0)

### 포함

- [x] Repo path 선택 (파일 picker + 텍스트 입력)
- [x] Start / Target branch combobox (자동완성 + 자유 입력으로 commit hash/tag 지원)
- [x] 좌측 변경 파일 리스트 (**플랫 + 폴더 트리 토글**)
- [x] Side-by-side diff (CodeMirror MergeView)
- [x] Unified / Side-by-side 토글
- [x] Three-dot / Two-dot 토글
- [x] 자동 언어 감지 + 수동 override 드롭다운
- [x] 공백 무시 토글, rename detection 기본 ON
- [x] 대용량 파일 collapse + "Load anyway"
- [x] 바이너리 파일은 메타정보만 표시
- [x] **파일내 검색 (Ctrl+F)**
- [x] **키보드 단축키**: j/k (다음/이전 파일), n/p (다음/이전 hunk), Ctrl+F (검색)
- [x] Recent repos (~10개) 기억
- [x] 테마 system follow + 수동 override
- [x] 인앱 자동 업데이트 체크 + 설치
- [x] 첫 실행시 git 감지 → 없으면 안내

### 제외 (v0.2+ 로드맵)

- git blame + commit drill-in (상세 §12)
- 다중 탭 비교
- 인라인 코멘트/리뷰
- viewed/unviewed 체크박스
- 설정 전용 페이지 (현재는 상단 토글로 충분)
- search across files
- export (HTML/PDF)
- 다른 VCS

---

## 6. 로드맵

| 버전 | 핵심 추가 |
|---|---|
| **v0.1.0** | 위 MVP scope |
| **v0.2.x** | git blame + commit drill-in (§12), viewed/unviewed 체크박스 |
| **v0.3.x** | 다중 탭, search across files |
| **v0.4.x** | 인라인 코멘트 + export |
| **v1.0** | 안정화, 코드 서명 검토 |

---

## 7. 배포 전략

### 7.1 릴리스 파이프라인

1. 개발자가 `git tag v0.1.0` + `git push --tags`
2. GitHub Actions (`tauri-action`) 트리거
3. Windows runner에서 빌드 (`tauri build`) → `.msi` + `.exe` (NSIS) + `latest.json`
4. ed25519 private key (GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY`)로 자동 서명
5. GitHub Release 자동 생성 + 자산 업로드
6. updater endpoint: `https://github.com/{user}/riff/releases/latest/download/latest.json`

### 7.2 키 관리 (운영 critical)

- ed25519 키 쌍은 `tauri signer generate`로 1회 생성
- **private key 백업 필수** — 패스워드 매니저에 별도 저장. GitHub Secrets는 백업이 아니다 (영구 손실 가능)
- public key는 `tauri.conf.json`의 `updater.pubkey`에 hardcode → 앱 바이너리에 embed

### 7.3 설치 경험

- 첫 사용자: GitHub Release 페이지에서 `.exe` (NSIS, WebView2 bootstrap 포함) 다운로드
- SmartScreen 경고: README에 "More info → Run anyway" 1줄 안내
- 자동 업데이트: 앱 실행시 백그라운드 체크 + 메뉴에 "Check for updates" 수동 항목

---

## 8. 예상 Blockers & 완화

| Blocker | 영향 | 완화 |
|---|---|---|
| **ed25519 update key 분실** | 모든 사용자 자동 업데이트 영구 끊김 (재설치 필요) | 키 생성 즉시 패스워드 매니저에 백업. 최소 2곳 |
| **WebView2 부재 (Win10 N edition 등)** | 앱 실행 불가 | NSIS installer의 WebView2 bootstrap 옵션 ON. `tauri.conf.json`에서 활성화 |
| **Windows SmartScreen 경고** | 첫 실행 마찰 | README 안내. 사용자 증가시 OV 인증서 ($300/년) 검토 |
| **대용량 repo `git diff` 출력 (수~수십MB)** | 메모리/응답성 | Rust 측 stream 파싱, 파일 단위로 frontend에 chunk 전달. 파일 본문은 클릭시 lazy load |
| **Shiki + MergeView 통합** | 비동기 highlighting decoration 연결 난이도 중간 | `shiki-codemirror` 어댑터 또는 custom Decoration plugin. PoC 우선 |
| **Git 미설치 사용자** | 동작 불가 | 첫 실행시 `git --version` 체크 → 없으면 dialog로 가이드 |
| **Rust 학습 곡선** | 백엔드 속도 | Rust 코드 양 작음 (CLI wrapper + IPC만). 학습 부담 낮음 |
| **CodeMirror 6 MergeView가 기대만큼 가볍지 않을 경우** | 번들 사이즈 | Monaco DiffEditor로 fallback (~+2MB) 또는 직접 구현으로 우회 |

---

## 9. 첫 마일스톤 작업 분해 (제안)

### Sprint 0 — Bootstrap (1~2일)
1. `npm create tauri-app@latest` → Svelte 5 + TS 템플릿
2. 프로젝트 구조 정리 (`src-tauri/src/{git,diff,store}/`, `src/lib/{ui,diff,lang}/`)
3. GitHub repo 생성, 기본 CI (lint + build) 추가
4. ed25519 키 생성 + GitHub Secrets 등록 + 백업

### Sprint 1 — Git 통합 + 파일 리스트 (3~4일)
1. `GitLayer` trait + `GitCli` 구현 (`list_branches`, `diff_files`)
2. Tauri command 노출
3. UI: 입력바 + branch combobox + 비교 버튼
4. 좌측 파일 리스트 (플랫만)

### Sprint 2 — Diff 렌더링 코어 (4~5일)
1. `file_diff` 명령 추가
2. CodeMirror 6 + MergeView 컴포넌트
3. Shiki lazy load 어댑터
4. Side-by-side / Unified 토글
5. 대용량 파일 collapse 처리

### Sprint 3 — UX 마감 (3~4일)
1. 자동 언어 감지 + override 드롭다운
2. 키보드 단축키 (j/k/n/p/Ctrl+F)
3. 파일 트리 토글
4. 테마 (system follow)
5. Recent repos 저장/로드
6. 공백 무시, two-dot 토글

### Sprint 4 — 배포 (2~3일)
1. tauri-action GitHub Actions workflow
2. NSIS installer + WebView2 bootstrap 설정
3. updater endpoint 연결 + 인앱 체크 UI
4. README + 설치 가이드
5. v0.1.0 tag → 첫 release

**총 예상**: ~15일 (개인 프로젝트, 풀타임 아님 가정시 4~6주)

---

## 10. 미결정 / 추후 결정

- 앱 아이콘 디자인 (v0.1.0 전에 결정. 임시는 Tauri 기본)
- SmartScreen 경고 완화를 위한 코드 서명 인증서 도입 시점 (사용자 ~50명 도달시 검토)
- Plugin API 공개 시점 (지금은 보류, v0.5 이후 필요시 재검토)

---

## 11. 결정 트레이스 (감사 추적용)

이 기획서는 다음 결정 트리를 통해 도출됨:

1. **Platform** → Windows 전용
2. **Framework** → Tauri (over WPF/Avalonia/Electron)
3. **Git access** → CLI shell out (over libgit2)
4. **Compare mode** → Three-dot + Two-dot 토글
5. **Diff renderer** → CodeMirror 6 + MergeView + Shiki
6. **Frontend** → Svelte 5
7. **Extensibility** → 내부 모듈러만 (no plugin API)
8. **Audience** → 개인 + 지인, 소스 공개
9. **Hosting** → Public GitHub Releases
10. **Language UX** → 자동 감지 + 수동 override
11. **Layout** → 상단 입력바 + 좌측 파일 + 메인 diff
12. **Display defaults** → Side-by-side, 대용량 collapse
13. **Theme** → System follow
14. **Diff options** → 공백 토글, rename ON
15. **CI/CD** → GH Actions + tauri-action, tag-driven
16. **Name** → Riff
17. **MVP extras** → 파일내 검색 + 파일 트리 + 단축키
18. **Blame** → v0.2 분리 (상세 §12)

---

## 12. v0.2.x — git blame + commit drill-in 상세 설계

> grill-me 인터뷰(2026-05-25)를 통해 합의된 v0.2.x 핵심 기능 설계.

### 12.1 요구사항

| # | 원본 요구 | 확정된 해석 |
|---|---|---|
| 1 | 가능한 가볍게 | Lazy fetch + 모드 OFF가 default + 컬럼 추가 X. 토글이 OFF일 때 현재 UI 100% 유지 |
| 2 | 현재 UI/UX와 크게 틀어지지 않게 | 툴바에 "Blame" 토글 버튼 1개 추가 외 다른 UI 변경 0. Mode ON 시에만 시각 추가 |
| 3 | 커밋한 사람의 이름과 commit 제목 | author + relative date + subject + short SHA(8자) 팝오버 |

### 12.2 결정 사항

#### A. Blame 기본 동작

| # | 항목 | 결정 |
|---|---|---|
| 1 | UI surface | Hover/click 팝오버 (영구 컬럼 없음) |
| 2 | Blame side | New side만 (target ref / worktree에서는 HEAD) |
| 3 | Worktree | `git blame --contents <fs_path> HEAD -- <path>`. 미커밋 라인은 zero SHA → "Not Committed Yet"으로 표시 |
| 4 | Trigger | 단축키 `b`로 모드 토글 (단축키 primary) |
| 5 | Visual state | 툴바에 작은 "Blame" 토글 버튼 (Split/Unified 옆 mode 그룹) |
| 6 | Fetch | Lazy — 토글 ON + 첫 hover 시점에 파일 단위 fetch. 이후 캐시 히트 |
| 7 | Flags | `-w -M --porcelain --abbrev=8` (공백 무시 + 파일 내 코드 이동 추적) |
| 8 | 팝오버 내용 | author + relative date + subject + short SHA |
| 9 | SHA 클릭 | 클립보드 복사 + 짧은 토스트 |

#### B. Visual grouping (Blame mode ON 시에만)

| # | 항목 | 결정 |
|---|---|---|
| 10 | 좌측 컬러 bar | 2-3px gutter, commit SHA hash → HSL 색. light/dark theme별 고정 채도/명도 |
| 11 | Hover highlight | 한 라인 hover 시 동일 commit의 모든 라인이 background highlight |
| 12 | 조건 | Mode OFF 시 100% 원래 UI (gutter, highlight 모두 사라짐) |
| 13 | "Not Committed Yet" 라인 | 회색/점선 bar로 구분 (commit color 안 입힘) |

#### C. Commit drill-in

| # | 항목 | 결정 |
|---|---|---|
| 14 | UI surface | 메인 view를 `<sha>^..<sha>` 비교로 일시 교체 |
| 15 | Scope | 전체 commit (모든 파일) — FileList + DiffView 재사용 |
| 16 | Trigger | 팝오버의 "View commit →" 링크 클릭 |
| 17 | Drill depth | Unlimited (commit view 안에서 또 blame → 또 drill 가능) |
| 18 | Back | 상단 breadcrumb의 ← Back 버튼 + `Esc` 단축키 |
| 19 | History | in-memory stack, 앱 재시작 시 reset (PersistedState 추가 안 함) |

### 12.3 팝오버 layout

```
┌─────────────────────────────────────┐
│ Hyunwook Yoo · 2 days ago           │
│ feat(ui): worktree compare mode     │
│ [18e5299]            View commit →  │
└─────────────────────────────────────┘
```

- `[18e5299]` 클릭 → 클립보드 복사 + 짧은 토스트
- `View commit →` 클릭 → 메인 view drill-in (history stack push)
- 팝오버 자체에 hover하면 sticky (마우스 떼도 안 사라짐) — CodeMirror `hoverTooltip` 표준 동작

### 12.4 Drill-in 동작

```
원래 비교: main...feature  [Split | Unified]  [Blame ON]
   ↓ "View commit →" (18e5299)

┌──────────────────────────────────────────────────────┐
│ ← Back  │  Viewing 18e5299 (was: main...feature)     │
├──────────────────────────────────────────────────────┤
│ files   │ diff (그 commit의 변경 — `<sha>^..<sha>`)   │
└──────────────────────────────────────────────────────┘

Esc → history pop → 원래 비교 복원
```

- Stack entry: `{ mode: 'branch'|'worktree', start, target, diffMode }`
- Esc 충돌 처리: search box가 열려 있으면 search close 우선, 아니면 back
- Commit view 안에서도 blame mode가 ON이면 동일하게 작동 → 또 drill 가능
- Merge commit의 `<sha>^..<sha>`는 first-parent diff (표준 동작)

### 12.5 Backend (`src-tauri/src/git/`)

**`GitLayer` trait 확장:**

```rust
pub struct BlameCommit {
    pub sha: String,         // 8자 short
    pub author: String,
    pub author_time: i64,    // unix timestamp
    pub summary: String,     // commit subject
}

pub struct Blame {
    pub commits: Vec<BlameCommit>,    // dedup
    pub line_commit: Vec<usize>,      // line N → commits 인덱스
}

pub trait GitLayer {
    // ...기존 메서드...
    fn blame_file(
        &self,
        path: &Path,
        file_path: &str,
        rev: &str,
        use_contents: bool,    // worktree: working copy 기준
    ) -> Result<Blame, GitError>;
}
```

**Implementation 핵심:**

- Branch mode: `git blame -w -M --porcelain --abbrev=8 <rev> -- <path>`
- Worktree mode: `git blame -w -M --porcelain --abbrev=8 --contents <fs_path> HEAD -- <path>`
- `--porcelain` 출력은 commit별 grouping이 이미 제공됨 → dedup 자연스러움
- Cancellation: `kill_slot` 패턴 (기존 `diff_files`와 동일하게 session에 in-flight blame child 보관)
- 캐시: branch mode는 (path, file_path, rev) 키로 session 캐시. Worktree는 file mtime 기반 invalidation

**새 Tauri command:**

```rust
#[tauri::command]
fn blame_file(
    state: tauri::State<GitCli>,
    path: String,
    file_path: String,
    rev: String,
    use_contents: bool,
) -> Result<Blame, GitError>
```

### 12.6 Frontend (`src/lib/`)

**새 타입 (`types.ts`):**

```ts
export interface BlameCommit {
  sha: string;
  author: string;
  author_time: number;
  summary: string;
}
export interface Blame {
  commits: BlameCommit[];
  line_commit: number[];
}
```

**새 wrapper (`git.ts`):**

```ts
export function blameFile(
  path: string,
  filePath: string,
  rev: string,
  useContents: boolean,
): Promise<Blame>;
```

**Store (`store.svelte.ts`):**

- `blameMode: boolean` — session only (PersistedState에 추가 안 함)
- `history: CompareCtx[]` — drill-in stack, session only
- `CompareCtx = { compareMode, mode, start, target }` (현재 비교 컨텍스트의 snapshot)

**DiffView.svelte 확장:**

- 툴바 "Blame" 토글 버튼 (Split/Unified 옆 mode 그룹)
- `b` 단축키 → toggle blameMode
- CodeMirror `hoverTooltip` extension — `blameMode === true`일 때만 활성
- 컬러 bar gutter (CodeMirror `gutter()` API) — `blameMode === true`일 때만 활성, `EditorView.compartment`로 dynamic add/remove
- Line hover handler → 같은 commit set lookup + class toggle (background highlight)
- Color hash:

```ts
function commitColor(sha: string, isDark: boolean): string {
  const hue = parseInt(sha.slice(0, 6), 16) % 360;
  return isDark ? `hsl(${hue}, 50%, 55%)` : `hsl(${hue}, 60%, 45%)`;
}
```

**새 컴포넌트:**

- `BlamePopover.svelte` — popover content (author, relative date, subject, SHA, View commit link)
- `Breadcrumb.svelte` — 상단 navigation, `appState.history.length > 0`일 때만 렌더

**README 단축키 표 업데이트:**

| Key | Action |
|---|---|
| `b` | Toggle blame mode |
| `Esc` | (Blame drill-in 시) back to previous compare |

### 12.7 Skip 조건 (toggle ON이어도 무반응)

- Binary 파일 (`FileDiff::Binary`)
- TooLarge 파일 ("Load anyway" 누르기 전)
- Untracked 파일 (worktree mode, HEAD에 없음)
- blame 호출 실패 (예: shallow clone, detached HEAD) → 팝오버에 짧은 에러 메시지 ("Blame unavailable")

### 12.8 작업 규모 예상

| 단계 | 작업 | 예상 |
|---|---|---|
| 1 | Backend: `blame_file` trait + porcelain parser + Tauri command + 단위 테스트 | 0.5~1일 |
| 2 | Frontend blame UI: hoverTooltip + popover + 토글 + 캐싱 + `b` 단축키 | 1~1.5일 |
| 3 | Visual grouping: 컬러 bar gutter + hover highlight + color hash | 0.5~1일 |
| 4 | Commit drill-in: history stack + breadcrumb + Esc 핸들러 + view 트리거 wiring | 0.5~1일 |
| 5 | Polish + README + 수동 테스트 | 0.5일 |
| | **총** | **~3.5~4.5일** |
