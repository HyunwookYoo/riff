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

- **`GitLayer` trait**: `list_branches()`, `diff_files(spec)`, `file_diff(spec, path)`, `(future) blame(file, rev)`
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

- git blame
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
| **v0.2.x** | git blame (hover & gutter), viewed/unviewed 체크박스 |
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
18. **Blame** → v0.2 분리
