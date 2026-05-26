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
| **v0.3.x** | Multi-root workspace — submodule 및 수동 추가 repo 통합 (§13), search across files |
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
19. **Submodule / multi-repo** → v0.3 분리 (상세 §13). Unified multi-root + Focus 토글로 결정 (탭 안 / embed 안 모두 기각)

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

---

## 13. v0.3.x — Multi-root workspace (submodule + 수동 추가 repo) 상세 설계

> grill-me 인터뷰(2026-05-26)를 통해 합의된 v0.3.x 핵심 기능 설계.
> 동기: submodule을 쓰는 프로젝트에서 main repo 한 곳만 보면 PR 전체 변경점을 한번에 보기 어렵다.

### 13.1 방향 비교 및 선택

| 안 | 요약 | 평가 |
|---|---|---|
| 1. Embed | main이 submodule을 traverse하여 한 picker에 융합 | 모드 매트릭스 폭발 (main worktree + submodule branch 등 의미 모호). blame 개념과 잘 안 맞음. **기각** |
| 2. Tabs | Fork/GitKraken식. repo마다 탭, 탭마다 독립 모드 | 멘탈 모델 단순. 하지만 "변경점 한번에"라는 원래 동기 미충족 — 탭을 일일이 돌아야 함. **기각** |
| **3. Unified multi-root + Focus 토글** | VSCode/JetBrains식. 한 트리에 repo별 그룹, 한 repo 집중은 *필터*로 처리 | 두 안의 장점을 비용 1배에 흡수. user-config로 두 패러다임 모두 만드는 안도 검토했으나 dual-architecture 부담 대비 효용 낮음. **채택** |

### 13.2 요구사항

| # | 원본 요구 | 확정된 해석 |
|---|---|---|
| 1 | submodule까지 PR 변경점을 한번에 | Unified 파일 picker에 모든 repo 변경 노출. Submodule은 main의 gitlink old/new SHA를 따라 자동 비교 |
| 2 | submodule 코드 탐색/blame | 단일 fuzzy picker에서 전 repo 파일 검색 → 클릭한 파일의 repo 컨텍스트로 blame 수행 |
| 3 | 가끔은 한 repo에만 집중 | Focus 토글로 트리에서 한 repo만 펼침. 진짜 탭 UI 안 만듦 |
| 4 | submodule 아닌 별개 repo도 같이 보고 싶음 | 수동 "Add repo" UI 제공 (Multi-root 일반화) |

### 13.3 결정 사항

#### A. Workspace 모델

| # | 항목 | 결정 |
|---|---|---|
| 1 | Workspace 단위 | `main repo + repos[]`. main이 트리거. |
| 2 | Repo 발견 | (a) main 열면 `.gitmodules` 파싱 → 초기화된 submodule 자동 포함. (b) "Add repo" 버튼으로 수동 추가. |
| 3 | 재귀 깊이 | 1단계 (submodule 내부의 .gitmodules는 무시) |
| 4 | Repo kind | `"main" | "submodule" | "manual"`. submodule은 parent gitlink path 보관. |
| 5 | Persistence | `PersistedState`에 `manualReposByMain: Record<mainPath, string[]>` 추가. submodule list는 매번 .gitmodules에서 다시 읽음 (자동) |

#### B. Branch compare 시멘틱

| # | 항목 | 결정 |
|---|---|---|
| 6 | main의 start/target | InputBar의 기존 한 쌍 (변경 없음) |
| 7 | Submodule 기본 | **gitlink-follow**. main의 start tree의 gitlink SHA → submodule의 start. target tree도 동일하게. `git diff <oldSha>..<newSha>` 가 그 repo의 변경. GitHub 웹 PR 의미와 일치 |
| 8 | 수동 repo 기본 | 동명 branch (main이 dev→feature이면 그 repo도 dev→feature). 없으면 "diff 없음" |
| 9 | Per-repo override | 가능. UI는 InputBar에 작은 "Per-repo overrides" disclosure (평소 숨김) |
| 10 | Worktree mode | 트리비얼 — 각 repo가 자기 `git diff` (working tree vs HEAD). submodule도 자기 HEAD 기준 |
| 11 | "submodule pointer만 바뀜" 표시 | 해당 repo 그룹 헤더에 `<oldSha> → <newSha>` 한 줄 표기. 내용 변경이 0이어도 그룹은 노출 |

#### C. UI 표현

| # | 항목 | 결정 |
|---|---|---|
| 12 | 파일 picker | Repo별 collapsible 그룹 헤더 + 그룹 안에서는 기존 flat/tree 동작 그대로 |
| 13 | 그룹 헤더 내용 | repo display name + kind 뱃지 + 파일 개수 + (submodule) `<oldSha>→<newSha>` + 수동 repo "×" 제거 버튼 |
| 14 | j/k 이동 | 접힌 그룹은 건너뜀. 펼친 그룹 안에서 파일 단위 이동 |
| 15 | Focus 토글 | repo 그룹 헤더 클릭 시 그 repo만 펼치고 나머지 collapse. 그룹 헤더 다시 클릭 또는 Esc로 해제 |
| 16 | Focus 키바인드 | 추후 결정 (잠정 미정) — 일단 헤더 클릭만 |

#### D. Drill-in과 Focus의 통합

| # | 항목 | 결정 |
|---|---|---|
| 17 | Drill-in 시 다른 repo | **자동 Focus** — drill 대상 repo만 노출. Esc/Back으로 multi-root 전체 복원 |
| 18 | Drill-in 메커니즘 | Focus와 동일. drill-in은 "Focus + ref pair 교체 + history push" |
| 19 | `CompareCtx` 확장 | `activeRepoIdx: number | null` 추가 (null = multi-root) |

#### E. Blame 통합

| # | 항목 | 결정 |
|---|---|---|
| 20 | Blame 파일 picker | 단일 fuzzy picker, 전 repo 파일 union. repo 그룹 헤더 포함 (compare와 동형) |
| 21 | Blame 실행 컨텍스트 | 클릭한 파일의 repo에서만 수행. commit panel, drill-in도 그 repo에 한정 |
| 22 | C/C++ companion (`.h↔.cpp`) | **same-repo 조건 추가**. 다른 repo에 같은 basename이 있어도 cross-repo 자동 열기는 안 함 |
| 23 | `blameFilePath` | 그대로 유지하되 의미상 "repo-qualified path" — `{ repoIdx, path }`로 확장 |

### 13.4 모델 변화 요약

**`types.ts`:**

```ts
export type RepoKind = "main" | "submodule" | "manual";

export interface RepoEntry {
  path: string;                    // 절대 경로
  kind: RepoKind;
  displayName: string;             // submodule은 main 기준 상대 경로, manual은 basename
  parentGitlinkPath?: string;      // submodule인 경우 main 안에서의 경로
  override?: {                     // per-repo branch override
    startBranch: string;
    targetBranch: string;
  };
}

export interface ChangedFile {
  path: string;
  old_path: string | null;
  status: FileStatus;
  repoIdx: number;                 // ← 추가
}

export interface CompareCtx {
  appMode: AppMode;
  compareMode: CompareMode;
  mode: DiffMode;
  startBranch: string;
  targetBranch: string;
  selectedFilePath: string | null;
  activeRepoIdx: number | null;    // ← 추가. null = multi-root
}

export interface PersistedState {
  recent_repos: string[];
  theme: ThemeChoice;
  font_size: number;
  compare_mode: CompareMode;
  manual_repos_by_main: Record<string, string[]>;  // ← 추가
}
```

**`store.svelte.ts`:**

- `repoPath: string` → 유지 (main 의미). 새로 `repos: RepoEntry[]` 추가 (main이 `repos[0]`)
- `activeRepoIdx: number | null` 추가 (Focus + drill-in 상태)
- `repoFiles: string[]` → 제거, repo별 캐시로 대체 (`repoFilesByIdx: string[][]`)
- `blameFilePath: string | null` → `blameTarget: { repoIdx: number; path: string } | null`

### 13.5 UI mockup (compare 모드, branch sub-mode, multi-root)

```
┌──────────────────────────────────────────────────────────────────────┐
│ [main repo path] [start: dev▼] [target: feature▼]  [+ Add repo]      │
│ ▸ Per-repo overrides (1)                                             │
├────────────────────────────┬─────────────────────────────────────────┤
│ ▾ riff (main)         3   │                                         │
│    src/lib/foo.ts          │                                         │
│    src/lib/bar.ts          │                                         │
│    README.md               │     CodeMirror MergeView                │
│ ▾ vendor/sub (submodule) 2│                                         │
│    a1b2c3 → d4e5f6        │                                         │
│    lib/x.ts                │                                         │
│    lib/y.ts                │                                         │
│ ▾ shared-lib (manual)  1   ×                                        │
│    (matching dev→feature) │                                         │
│    src/index.ts            │                                         │
└────────────────────────────┴─────────────────────────────────────────┘
```

Drill-in / Focus 진입 후 (vendor/sub의 commit 클릭):

```
┌──────────────────────────────────────────────────────────────────────┐
│ ← Back │ Viewing d4e5f6 in vendor/sub (was: riff dev→feature)        │
├────────────────────────────┬─────────────────────────────────────────┤
│ ▾ vendor/sub          2   │                                         │
│    lib/x.ts                │     diff                                │
│    lib/y.ts                │                                         │
│                            │                                         │
│ (다른 repo는 숨김 — Focus)  │                                         │
└────────────────────────────┴─────────────────────────────────────────┘
Esc → multi-root 복원
```

### 13.6 Backend (`src-tauri/src/git/`)

**`GitLayer` trait 확장:**

```rust
/// 한 repo에서 한 ref pair의 변경 파일 리스트. 기존 `diff_files`와 본질 동일.
fn diff_files_in(
    &self,
    repo_path: &Path,
    start: &str,
    target: &str,
    mode: DiffMode,
    ignore_whitespace: bool,
) -> Result<Vec<ChangedFile>, GitError>;

/// 주어진 tree에서 한 submodule path의 gitlink SHA를 추출.
/// 예: `git ls-tree <tree> <submodulePath>` → `160000 commit <sha> ...`
fn submodule_sha_at(
    &self,
    main_repo: &Path,
    tree_ish: &str,
    submodule_path: &str,
) -> Result<Option<String>, GitError>;

/// `.gitmodules` 파싱 + 초기화 여부 확인.
fn list_submodules(
    &self,
    main_repo: &Path,
) -> Result<Vec<SubmoduleInfo>, GitError>;
```

```rust
pub struct SubmoduleInfo {
    pub path: String,              // main 기준 상대 경로
    pub absolute_path: PathBuf,    // 실제 fs 위치 (초기화 안 됐으면 None)
    pub initialized: bool,
}
```

**기존 명령 확장:**

- `diff_files` (Tauri command) → repo_path 인자 추가, 호출자(JS)가 repo별로 N번 호출. Rust 측은 별 변화 없음.
- `worktree_files` → 동일하게 repo_path 인자만 받음.
- `blame_file` → 이미 `path` 인자 받음. 변경 없음.

**새 Tauri command:**

```rust
#[tauri::command]
fn list_submodules(state: tauri::State<GitCli>, main_repo: String)
    -> Result<Vec<SubmoduleInfo>, GitError>;

#[tauri::command]
fn submodule_sha_at(
    state: tauri::State<GitCli>,
    main_repo: String,
    tree_ish: String,
    submodule_path: String,
) -> Result<Option<String>, GitError>;
```

**캐시/취소 정책:**

- compare session id (기존 `compareSession`)을 그대로 사용. N repo 병렬 fetch를 같은 session으로 묶음.
- repo별 `git diff` 자식 프로세스는 기존 kill_slot 패턴을 repo별로 확장 (`HashMap<repoIdx, ChildHandle>`).

### 13.7 Frontend (`src/lib/`)

**`compare.ts` 확장 — 핵심 의사 코드:**

```ts
async function compare(opts: CompareOptions = {}): Promise<void> {
  const session = ++compareSession;
  appState.files = [];

  // 1. main 변경 fetch (gitlink 변화 포함)
  await fetchRepoFiles(appState.repos[0], session, onFile);

  // 2. 각 submodule: gitlink SHA 추출 → old..new diff
  for (const repo of appState.repos.slice(1)) {
    if (repo.kind === "submodule") {
      const oldSha = await submoduleShaAt(mainPath, startBranch, repo.parentGitlinkPath!);
      const newSha = await submoduleShaAt(mainPath, targetBranch, repo.parentGitlinkPath!);
      // pointer-only 변화면 oldSha != newSha지만 내용 변경 없을 수 있음 — 그래도 UI에 그룹 노출
      if (oldSha && newSha) {
        await fetchRepoFilesAtRefs(repo, oldSha, newSha, session, onFile);
      }
    } else if (repo.kind === "manual") {
      // 동명 branch 또는 override
      const { start, target } = resolveRefs(repo, startBranch, targetBranch);
      if (start && target) {
        await fetchRepoFilesAtRefs(repo, start, target, session, onFile);
      }
    }
  }
}
```

**Focus 메커니즘:**

```ts
function enterFocus(repoIdx: number): void {
  appState.activeRepoIdx = repoIdx;
}

function exitFocus(): void {
  appState.activeRepoIdx = null;
}

// 파일 picker 렌더: activeRepoIdx != null이면 그 repo 그룹만 펼침 + 다른 그룹 숨김
// drill-in: cycleAppMode / commit drill 헬퍼가 enterFocus(repoIdx) + history.push
// Esc: history.pop 또는 exitFocus
```

**새 컴포넌트:**

- `RepoGroupHeader.svelte` — collapsible 헤더. kind 뱃지 / 파일 카운트 / submodule SHA / 제거 버튼.
- `AddRepoButton.svelte` — InputBar 안에 dialog open.
- `PerRepoOverrides.svelte` — disclosure 안에 repo별 start/target 입력.

**`InputBar.svelte` 변경:**

- 기존 입력 그대로 + 오른쪽 "+ Add repo" 버튼
- 그 아래 "▸ Per-repo overrides (N)" disclosure (override 있는 repo 수)

**`FileList.svelte` 변경:**

- 평면 `files`를 `repoIdx`로 group_by 한 뒤 RepoGroupHeader 단위로 렌더
- j/k 이동은 펼친 그룹의 파일만 순회

### 13.8 Drill-in 동작 (multi-root)

```
원래 multi-root 비교
   ↓ vendor/sub의 commit d4e5f6 popover에서 "View commit →"

CompareCtx push: { ...현재, activeRepoIdx: null }
appState.activeRepoIdx = (vendor/sub의 idx)
appState.startBranch  = "d4e5f6^"
appState.targetBranch = "d4e5f6"
→ compare() 호출 — Focus 상태라 그 repo만 fetch

   ↓ Esc

CompareCtx pop → 원래 ref pair + activeRepoIdx=null 복원
→ compare() 재호출
```

- 다른 repo로 drill-in 중에 또 다른 repo의 commit으로 drill하는 건 같은 메커니즘 (history depth 증가)
- Focus만 단독으로 진입한 경우(commit drill 없이 헤더 클릭)에는 history push 안 함 — 단순 토글

### 13.9 작업 규모 예상

| 단계 | 작업 | 예상 |
|---|---|---|
| 1 | Backend: `list_submodules` + `submodule_sha_at` + 단위 테스트 | 0.5일 |
| 2 | 데이터 모델 마이그레이션 (`repos[]`, `ChangedFile.repoIdx`, `activeRepoIdx`, persistence 스키마 bump) | 1일 |
| 3 | Discovery + 수동 "Add repo" UI + persistence wiring | 0.5~1일 |
| 4 | `compare.ts` multi-repo fetch + gitlink-follow + 동명 branch 매칭 + per-repo override | 1~1.5일 |
| 5 | 파일 picker repo 그룹 헤더 + j/k 이동 + collapsing | 0.5~1일 |
| 6 | Focus 토글 + drill-in과 Focus 통합 + `CompareCtx.activeRepoIdx` | 0.5~1일 |
| 7 | Blame 통합 picker + per-file repo 컨텍스트 + companion same-repo 조건 | 0.5일 |
| 8 | Polish + README 업데이트 (multi-root 섹션 추가) + 수동 테스트 | 0.5일 |
| | **총** | **~5~6일** |

### 13.10 Skip / Edge cases

- 초기화 안 된 submodule (`git submodule update` 안 함): 그룹 헤더에 "uninitialized" 뱃지, 파일 목록 비움. clickable but disabled.
- 수동 추가한 repo가 git repo가 아님: Add 시 검증 실패 dialog.
- 수동 repo의 동명 branch가 양쪽 다 없음: 그룹 헤더에 "no matching refs" + override 유도.
- Submodule이 nested (.gitmodules 안에 또 .gitmodules): 1단계만 본다 — 깊은 케이스는 미지원, 필요시 v0.4 검토.
- main이 detached HEAD인 경우: submodule 그룹은 gitlink-follow가 그대로 작동 (tree-ish는 ref 이름 아니어도 OK).
- Per-repo override가 있는 repo는 그룹 헤더에 작은 아이콘으로 표시.

### 13.12 Repo 경로 UI — Compact Repo Chip

> 동기: multi-root가 들어오면 InputBar 상단의 큰 path input + Browse 버튼은 의미가 약해진다.
> main repo는 한 번 정하면 잘 안 바뀌고, 나머지 repo는 자동(submodule) 또는 수동 다이얼로그로 추가되니까.

#### 13.12.1 현재 → 제안

**현재 (`InputBar.svelte`):**
```
[─────── path input (flex:1) ───────] [Browse…] [start] [target] [Compare]
```

**제안:**
```
mode-bar:    [Branch | Working Tree | Blame]   📁 riff ▾
main-bar:    [start] [target] [Compare]
```

- `.path` text input과 Browse 버튼이 main-bar에서 사라짐 → branch/target/Compare만 남아 매우 가벼움
- chip은 mode-bar의 오른쪽(또는 가운데)에 배치. 크기 ~120px 고정폭, main repo display name + ▾
- chip hover 시 main repo 풀패스 tooltip
- 드래그-드롭은 window 전체에서 그대로 작동 → main repo 교체

#### 13.12.2 Popover 구성

```
┌────────────────────────────────────┐
│ 🔍 [type to filter recents...]     │  ← 즉시 fuzzy 필터, Enter로 선택
├────────────────────────────────────┤
│ ◉ riff                C:\riff\riff │  ← 현재 main 강조
│   migaloo            C:\dev\...    │
│   sandbox            D:\repos\...  │
│   ...                              │  ← recent_repos persist
├────────────────────────────────────┤
│ 📂 Browse folder…                  │  ← 기존 fs dialog
├────────────────────────────────────┤
│ Workspace repos:                   │
│   vendor/sub  (submodule, auto)    │  ← .gitmodules로 자동 발견
│   shared-lib  (manual)         [×] │  ← 제거 버튼
│ + Add manual repo                  │  ← fs dialog → manual_repos_by_main에 push
├────────────────────────────────────┤
│ ▸ Per-repo overrides (1)           │  ← disclosure, 평소 닫힘
└────────────────────────────────────┘
```

- "Workspace repos" 섹션은 §13.3(A,B,C)의 multi-root UI가 이 popover로 흡수된 결과
- 원래 §13.7에서 InputBar에 두려던 "+ Add repo" 버튼과 "Per-repo overrides" disclosure는 모두 여기로 이동
- popover는 click outside / Esc로 닫힘

#### 13.12.3 동작

- chip 클릭 → popover open. 검색 input에 자동 focus
- recent 항목 클릭 → 즉시 main repo 전환 (현재 `loadRepo` 흐름 재사용)
- 검색 입력 후 Enter → 첫 매칭 항목으로 전환. 매칭 없고 입력이 절대 경로면 그 경로로 시도 (현재 free-form 입력 기능 흡수)
- "Browse folder…" → 기존 `@tauri-apps/plugin-dialog::open({directory:true})`
- "Add manual repo" → 같은 dialog지만 결과를 `appState.repos[]`에 append + persist
- 찾은 repo는 `addRecentRepo`로 자동 persist (현재 동작 그대로)

#### 13.12.4 구현

새 컴포넌트 `RepoChip.svelte`:
- prop 없이 `appState`만 참조
- 내부 상태: `open: boolean`, `filter: string`
- 내부에 `Popover.svelte` (또는 기존 `Dropdown.svelte` 패턴 재사용 검토)

`InputBar.svelte` 변경:
- `.path` input + `<datalist>` + Browse 버튼 제거
- mode-bar에 `<RepoChip />` 추가
- onMount의 drag-drop 핸들러는 그대로 유지

스타일:
- chip은 `.mode-toggle` 버튼들과 시각적으로 같은 레벨 (높이/border-radius 일치)
- 팝오버는 기존 `--input-bg` / `--border` 토큰 사용

#### 13.12.5 작업 규모 (§13.9에 추가)

| 단계 | 작업 | 예상 |
|---|---|---|
| 9 | RepoChip + popover (검색/recent/Browse/manual repos/overrides 통합) | 1일 |

→ §13 총합: **~6~7일**

- Focus 키바인드 (헤더 클릭 외) — 사용해 보고 결정
- 수동 repo 제거 시 confirm dialog 필요 여부 — 단순 토글로 시작
- Submodule pointer만 바뀐 그룹의 시각 처리 톤 — 디자인 단계에서 조정
- `recent_repos` 와 `manual_repos_by_main`의 cleanup 정책 (오래된 main path 만료) — 일단 무한 보관
