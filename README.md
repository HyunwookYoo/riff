# Riff

Windows 데스크톱용 경량 Git 브라우저. 커밋 히스토리와 두 ref 비교를 PR처럼 읽고, 라인별 blame과 파일 타임랩스로 코드의 내력을 추적합니다. 브랜치를 만들고 옮겨 다니고, pull·push 하고, 리베이스하는 것까지가 riff가 저장소에 손대는 전부입니다 — 커밋은 Fork에서.

[Tauri 2](https://tauri.app) + Svelte 5 + [CodeMirror 6](https://codemirror.net) (`@codemirror/merge`) + [Shiki](https://shiki.style) 기반.

---

## 설치

1. [Releases](https://github.com/HyunwookYoo/riff/releases/latest)에서 최신 `Riff_x.y.z_x64-setup.exe`를 다운로드.
2. 실행. 코드 서명 인증서가 없어 Windows SmartScreen 경고가 뜹니다 — **추가 정보 → 실행**을 선택합니다.
3. WebView2가 없으면 인스톨러가 자동 설치합니다.

업데이트가 있으면 앱 상단에 배너가 뜹니다 → **Install and restart** 클릭으로 갱신됩니다.

---

## riff와 Fork

riff는 **읽는 도구**입니다. 저장소를 바꾸는 경우는 일곱 가지뿐입니다 — 브랜치 생성, 이름 변경, 삭제, checkout, fetch/pull, rebase, push. 여기에 예외가 하나 있는데, riff의 pull이나 rebase가 충돌을 만들면 riff가 3-way 해결기로 치웁니다.

커밋과 reset은 riff에 없습니다. Fork(또는 다른 클라이언트)에서 하세요. 기능이 모자란 게 아니라 의도된 분업입니다 — riff는 코드를 읽는 일을 잘하는 데 집중합니다. stash도 riff의 기능은 아닙니다 — rebase가 시작 전에 로컬 변경을 치웠다가 끝나면 되돌리는 것(`git rebase --autostash`)이 전부입니다. rebase가 예외인 이유와 쓰는 법은 [§3c](#3c-rebase--브랜치-옮겨-쌓기)에 있습니다.

---

## 워크스페이스 모드

상단 좌측의 토글에서 모드를 전환합니다. **`Ctrl+Shift+W`** 로 순환 전환할 수 있고, 입력 필드에 포커스가 있어도 동작합니다.

| 모드 | 용도 |
|---|---|
| **Branch** | 두 ref를 골라 PR 스타일 비교 (브랜치 ↔ 브랜치 / 태그 / 커밋 해시) |
| **Working Copy** | 작업 트리 변경을 읽기 전용으로 확인 (HEAD ↔ 작업 트리) |
| **Graph** | 커밋 그래프 + 브랜치/태그 배지 + 커밋별 액션 + fetch/pull |
| **Blame** | 파일 한 개를 골라 라인별 작성자/커밋 추적 + 파일 타임랩스 |

Working Copy와 Graph는 좌측 사이드바의 **Working Copy / Graph** 네비(Fork식)로도 오갈 수 있습니다. 커맨드 팔레트(**`Ctrl+Shift+P`**)로도 어디서든 빠르게 전환·실행할 수 있습니다.

---

## 1. 시작하기

### 저장소 열기 (Repo chip)
좌측 상단 모드 토글 옆 **📁 chip** 클릭으로 팝오버가 열립니다:
- 최근에 연 저장소 검색 (위쪽 입력란에 타이핑) → Enter 또는 클릭으로 전환
- **📂 Browse folder…** — 폴더 선택 다이얼로그
- 폴더를 창에 **드래그 앤 드롭** 해도 됩니다 (chip 없이 즉시 로드)

저장소를 열면 Working Copy 모드에서는 바로 변경 파일이 로드되고, Branch 모드에서는 ref 자동완성 목록(로컬/리모트/태그)을 채웁니다.

### 멀티 루트 워크스페이스 (submodule + 수동 추가 repo)
저장소가 submodule을 포함하면 `.gitmodules` 가 자동으로 읽혀 워크스페이스에 추가됩니다. chip의 "+N" 뱃지로 추가 repo 개수가 표시되고, 팝오버의 **Workspace repos** 섹션에서 전체 목록을 확인할 수 있습니다.

- **+ Add manual repo** — submodule이 아닌 관련 repo(공유 라이브러리 등)를 워크스페이스에 추가. main repo 단위로 저장되어 다음 실행에서도 복원됩니다.
- 수동 추가 항목은 `×` 버튼으로 제거할 수 있습니다.

#### 멀티 루트에서의 비교 의미
| Repo 종류 | Branch 모드 | Working Copy 모드 |
|---|---|---|
| **main** | 툴바의 base ← compare 그대로 | `git diff HEAD` |
| **submodule** | main의 base / compare가 고정한 gitlink SHA 두 개를 비교 (GitHub PR과 동일 의미). 그룹 헤더에 `pinned by <main>: <sha> ← <sha>` 로 표시 | submodule 자체의 `git diff HEAD` |
| **manual** | main과 같은 이름의 branch를 자동 매칭 (`same names: …`). 없으면 그 그룹에 오류 표시 | 해당 repo의 `git diff HEAD` |

파일 리스트와 blame 피커는 모두 **repo별 collapsible 그룹 헤더**로 묶여 표시됩니다. 그룹 헤더의:
- **caret(▾/▸)** 클릭 → 그 그룹만 접고 펴기 (`↑`/`↓` 이동에서 접힌 그룹은 건너뜀)
- **이름 부분** 클릭 → **Focus 모드** 진입. 그 repo만 보이게 되고, `Esc` 또는 같은 헤더 재클릭으로 해제.

Blame 모드에서도 동일한 그룹 헤더가 나옵니다. 클릭한 파일이 속한 repo에서 blame이 수행되고, drill-in으로 들어간 커밋도 자동으로 해당 repo로 Focus됩니다 (`Esc` 로 원래 멀티 루트 뷰 복원).

#### Tabs 레이아웃 (Fork식, 선택지)
기본은 위에 설명한 **Unified** 레이아웃(그룹 헤더 + Focus)이지만, Fork/GitKraken 스타일 탭 UI가 익숙하다면 chip 팝오버 하단의 **Layout: Tabs** 를 선택할 수 있습니다.

- 상단에 repo별 탭바가 나타나고, 한 번에 한 repo의 파일만 평면 리스트로 표시됩니다.
- 툴바의 base / compare는 **항상 main의 쌍**입니다. submodule·manual 탭이 active면 툴바 아래 **scope 줄**이 그 repo가 무엇을 따라가는지 보여주고, **Compare own branches…** 로 그 repo만의 base / compare를 고를 수 있습니다.
- 탭 전환 시 **마지막 보던 파일과 스크롤 위치 복원** — 빠른 컨텍스트 스위치.
- compareMode(Branch / Working Copy)는 글로벌입니다 — 한 번 정한 모드가 모든 탭에 일관 적용.
- 탭 키바인드: **`Ctrl+Tab` / `Ctrl+Shift+Tab`** (다음/이전), **`Ctrl+1~9`** (직접 점프).
- manual repo는 탭 우측 `×` 로 워크스페이스에서 제거. main과 submodule은 닫기 없음.
- **모드 전환 시**: Unified→Tabs는 현재 선택 파일의 repo 탭이 활성화됩니다. Tabs→Unified는 Focus가 풀려 전체 multi-root 뷰로 돌아갑니다. selectedFile, drill-in 히스토리, blame 상태 모두 보존.

설정은 글로벌이며 다음 실행에도 유지됩니다.

---

## 2. Branch 모드 — 두 ref 비교

### 사용 흐름
1. 좌측 모드 토글에서 **Branch** 선택.
2. **base** (기준, 머지될 쪽 — diff 왼쪽) 와 **compare** (리뷰할 브랜치 — diff 오른쪽) 선택. 브랜치명/태그/커밋 해시 모두 가능. `base ← compare` 는 "compare가 base로 들어간다"는 뜻입니다.
3. **since fork (...)** vs **direct (..)** 선택:
    - `since fork`: GitHub PR과 동일. `merge-base(base, compare)` 부터 `compare` 까지의 변경 (= compare가 갈라진 뒤 바꾼 것).
    - `direct`: `base..compare` 직접 diff.
4. **`ws`** 체크박스로 공백 무시(`-w`) 토글.
5. **Compare** 클릭.

툴바의 두 피커는 항상 **super(main) repo의 쌍**입니다. 멀티 루트에서 한 repo에 Focus해도 피커의 의미는 바뀌지 않고, 툴바 아래 scope 줄에 그 repo의 범위가 표시됩니다.

### 커밋 표 (상단)
- **compare에만 있는 커밋**을 repo별로 묶어 보여줍니다: ● base에 없음 · ◐ 다른 방식으로 들어감 (rebase / cherry-pick / squash) · ✓ 이미 들어감(**Show merged commits** 켰을 때).
- 맨 위 요약 줄이 답을 한 문장으로 말합니다 (예: `main ← feature/x: ● 8 not merged · ◐ 1 applied as patch`). 전부 들어갔으면 **어떤 머지로 들어왔는지**를 보여줍니다.
- **squash merge 감지**: squash로 합친 브랜치의 커밋도 `squashed into <sha>` 로 표시합니다. 내용 비교(`merge-tree --write-tree`)는 **git 2.38 이상**에서 동작하고, 그보다 낮으면 patch-id 일치만 찾습니다.
- 커밋을 클릭하면 아래 파일 목록과 diff가 그 커밋(`parent..commit`)만 보여주고, 파일 목록 위 줄에 그 커밋이 base에 들어갔는지가 나옵니다. 같은 행을 다시 누르거나 **× All changes** 로 전체 변경으로 돌아갑니다.
- 경계선을 드래그해 높이 조절, `▴` 로 요약 줄만 남기고 접기.

### 좌측 파일 리스트
- 파일별 상태 뱃지: `added` / `modified` / `deleted` / `renamed` / `copied` / `typechanged`.
- **Flat / Tree** 토글 버튼으로 평면 ↔ 트리 뷰 전환.
- **`↑` / `↓`** 로 다음/이전 파일 이동.

### 우측 Diff 패널
- 헤더에 파일이 속한 **repo와 비교 범위**, 창 위에 **각 창이 무엇인지**(`base · main (merge-base)` / `compare · feature/x`) 표시.
- **Split** (CodeMirror MergeView 좌우 분할) ↔ **Unified** 토글.
- 자동 언어 감지 + 드롭다운에서 **수동 override** 가능 (Shiki 200+ 언어).
- 라인 번호 표시.
- 큰 변경 사이의 **변경 없는 라인은 자동 축소**(`collapseUnchanged`); 클릭으로 펼침.
- **이미지 파일**: side-by-side / swipe / onion 모드 + 줌·팬으로 시각 비교.
- **이진 파일**: 메타(크기 변화)만 표시, diff 생략.
- **너무 큰 파일**: 자동 축소 + **Load anyway** 버튼으로 강제 로드.
- 단축키:
    - **`n` / `p`** — 다음/이전 변경 청크
    - **`Ctrl+F`** — 파일 내 검색
    - **`Ctrl+G`** — 라인 번호로 점프

---

## 3. Working Copy 모드 — 작업 트리 확인

`git status --porcelain=v2` 기반의 작업 트리 변경 화면입니다.

- 파일별 상태 뱃지(`added` / `modified` / `deleted` / `renamed` / `copied` / `typechanged`)와 함께 변경 파일 목록을 표시. Untracked 파일도 표시됩니다.
- 파일 클릭 → diff(HEAD ↔ 작업 트리). Unreal `.uasset`/`.umap` 은 번들된 UAssetGUI로 파싱한 **속성 뷰**로 표시.
- **창 포커스 복귀 시 자동 새로고침** + **`F5`/`Ctrl+R`**.
- 충돌 파일은 **`Conflicts (N)`** 헤더로 그룹돼 `!` 배지가 붙고, 클릭하면 **인앱 3-way 충돌 해결기**(ours/base/theirs + 편집 결과)가 열립니다.

이 화면은 읽기 전용입니다 — 스테이징·커밋·되돌리기는 Fork에서 합니다. 예외는 충돌 해결뿐으로, riff의 pull이 만든 충돌은 riff에서 해결합니다.

---

## 3b. Graph 모드 — 커밋 그래프 & 동기화

GitKraken/Fork식 커밋 그래프 워크스페이스입니다.

- **그래프**: 레인 + 커밋 노드 + 브랜치/태그 배지. 같은 위치의 로컬+리모트 브랜치는 하나의 배지로 합쳐지고, 미커밋 변경은 HEAD 위 **WIP 노드**로 표시됩니다. 행 높이 조절 + all-branches 리셋 버튼 제공.
- **커밋별 액션**: 커밋을 클릭하면 그 커밋의 변경 전체를 봅니다. 우클릭 메뉴는 New branch here… / Checkout (detached) / Rebase 두 가지(§3c). 브랜치 배지 더블클릭으로 checkout, 드래그로 rebase.
- **브랜치 사이드바**: checkout, 생성/이름변경/삭제, rebase. 리모트 더블클릭은 checkout + fast-forward.
- **동기화 툴바**: fetch / pull / push (ahead/behind 카운트 표시, §3d).

---

## 3c. Rebase — 브랜치 옮겨 쌓기

riff에서 히스토리를 다시 쓰는 유일한 기능입니다. 읽다가 "이 브랜치는 main 위에 있어야 하는데"를 발견하는 자리가 곧 브랜치 사이드바와 그래프이기 때문에, 그 자리에서 바로 하도록 넣었습니다.

**진입점은 두 개, 규칙은 하나 — 가리킨 쪽이 목적지입니다.**

| 어디서 | 드래그 드롭 | 우클릭 |
|---|---|---|
| 브랜치 사이드바 | 로컬 브랜치 행을 다른 ref(로컬/리모트/태그) 위로 → **끌어온 브랜치**를 그 ref 위로 | 그 ref 위로 **현재 브랜치**를 |
| 그래프 | 브랜치 배지를 커밋 행 위로 → **그 배지의 브랜치**를 그 커밋 위로 | 그 커밋 위로 **현재 브랜치**를 |

드래그는 양쪽 끝을 다 지목하므로 아무 브랜치나 옮길 수 있고, 우클릭은 목적지만 지목하므로 현재 브랜치가 움직입니다.

메뉴 항목은 두 줄입니다:

- **`Rebase <branch> onto <target>`** — 확인 다이얼로그(몇 개 커밋이 다시 쓰이는지)만 거치고 바로 실행.
- **`Rebase <branch> onto <target>… (plan)`** — **플랜 에디터**를 엽니다.

### 플랜 에디터 (interactive rebase)

`git rebase -i` 의 todo를 그대로 편집합니다. **위에 있는 커밋이 먼저** replay 됩니다.

- 행을 **드래그**하거나 **↑ ↓** 버튼으로 순서 변경.
- 커밋마다 액션 선택: **pick**(그대로) / **squash**(위 커밋에 합치고 메시지 둘 다 유지) / **fixup**(합치고 이 메시지는 버림) / **edit**(여기서 멈춤) / **drop**(빼기).
- 목록은 git이 실제로 만드는 todo와 같습니다 — 머지 커밋은 빠지고, 이미 목적지에 같은 패치로 들어간 커밋도 빠집니다.
- **reword는 없습니다.** 메시지 편집기가 riff에 없기 때문입니다(squash는 git 기본 결합 메시지를 씁니다). 메시지를 고칠 일은 Fork에서.

### 멈췄을 때

충돌이 나거나 `edit` 에서 멈추면 기존 **충돌 배너**가 그대로 받습니다 — **Resolve** → 인앱 3-way 해결 → **Continue**, 이 커밋을 버리고 넘어가려면 **Skip**, 되돌리려면 **Abort**.

### 로컬 변경은 자동으로 치웠다가 되돌립니다

작업 트리가 더러워도 rebase가 막히지 않습니다. `git rebase --autostash` 로 돌기 때문에 git이 시작 전에 변경을 stash 하고, rebase가 끝나는 시점 — 마지막 커밋을 얹었을 때, 또는 멈춘 rebase를 **Continue / Skip / Abort** 로 끝냈을 때 — 에 되돌립니다. stash 항목이 남지 않습니다.

단, autostash는 **추적 중인 파일의 변경만** 치웁니다. untracked 파일이 rebase가 써야 할 파일과 겹치면 git이 거부하고, riff가 그 메시지에 "정리한 뒤 다시 시도하세요" 안내를 붙여 보여줍니다.

되돌리다 충돌하는 경우가 하나 있습니다: rebase가 방금 쓴 내용과 치워 둔 변경이 같은 줄을 건드릴 때입니다. 이때 git은 **rebase 자체는 성공으로 끝내고**(그래서 다른 화면은 아무 말도 하지 않습니다) 변경을 stash에 그대로 남깁니다. riff가 이 경우를 알아채서 배너로 알려줍니다 — 작업 트리의 충돌 표시를 정리한 뒤 Fork에서 stash를 pop 하거나 drop 하면 됩니다.

### 안전장치

- rebase 전 tip은 **reflog**에 남습니다. **`Ctrl+Shift+R`** → 해당 항목에서 브랜치를 만들면 그대로 복구됩니다.
- 이미 올린 브랜치를 rebase 했다면 원격과 히스토리가 갈라집니다 — 다시 올릴 때는 **Force push (with lease)**(§3d).

---

## 3d. Push — 올리기

커밋은 Fork에서 하지만, 올리는 건 riff에서 합니다 — rebase를 riff에서 하고 나면 그 브랜치를 올리는 것까지가 한 동작이기 때문입니다.

| 어디서 | 무엇을 |
|---|---|
| 동기화 툴바 | **`↑ Push N`** — 현재 브랜치, N은 upstream보다 앞선 커밋 수. 오른쪽 **`▾`** 를 누르면 **Push** / **Force push (with lease)…** 중에서 고를 수 있습니다 |
| 브랜치 사이드바 우클릭 (로컬 브랜치) | **Push** / **Force push (with lease)…** — 체크아웃하지 않은 브랜치도 그대로 |

툴바 버튼 자체를 누르면 항상 일반 push입니다 — force는 `▾` 안에만 있어서 오클릭으로 원격을 다시 쓸 일이 없습니다. 아직 원격에 없는 브랜치면 force 항목은 비활성입니다(덮어쓸 대상이 없으니).

- **아직 원격에 없는 브랜치**는 툴바 버튼이 **`↑ Publish`** 로 바뀝니다. 누르면 remote에 올리면서 upstream까지 설정합니다(`push -u`). remote가 여러 개면 riff가 고르지 않고 어느 것들이 있는지 알려줍니다 — `origin` 이 있으면 `origin`, 없고 remote가 하나면 그것.
- 로컬 이름과 원격 이름이 다른 브랜치도 원격 이름 그대로 올라갑니다.

### force는 항상 lease

riff의 force push는 `--force-with-lease --force-if-includes` 하나뿐입니다. **그냥 `--force` 는 riff에 없습니다.**

- 원격이 riff가 마지막으로 본 위치에서 움직였으면 git이 **거부**합니다 — 남의 커밋을 덮어쓸 수 없습니다.
- fetch는 했지만 그 커밋을 이 브랜치에 반영하지 않았어도 거부합니다(`--force-if-includes`).
- 거부당하면 riff가 이유별로 다른 안내를 붙입니다: *원격에 없는 커밋이 있음 → Pull*, *원격이 움직임 → Fetch 후 확인*, *받아둔 커밋이 브랜치에 없음 → 그 위로 다시 rebase*.

> git 2.30 이상이 필요합니다(`--force-if-includes`).

---

## 4. Blame 모드 — 라인별 작성자 추적

Blame 모드는 독립된 3-pane 워크스페이스입니다:

```
┌───────────────────────────────────────────────────┐
│  파일 피커  │   에디터 + Blame 거터    │  커밋 목록  │
└───────────────────────────────────────────────────┘
```

### 파일 피커 (좌측)
- **검색창**: 퍼지 파일 검색 (fuzzysort). 첫 진입 시 자동 포커스.
- 검색어가 비어 있으면 **저장소 전체 파일 트리** 표시 (top-level 폴더 + 현재 blame 중인 파일의 조상 폴더만 펼침).
- 검색 중에는 매칭 결과만 보여주는 **필터링된 트리**로 전환되고, 키보드 포커스가 있는 항목의 폴더만 펼쳐 시각적 노이즈를 줄임.
- **매칭 규칙**: basename(파일명 부분)을 건드리는 매치만 살림. 예: `src/lib` 라고 쳤을 때 `src/lib/` 하위 모든 파일이 다 뜨지 않도록.
- **C/C++ 동반 파일 자동 펼침**: 검색 결과에 `.h` 와 `.cpp` 같은 짝이 모두 있으면 함께 펼침.
- **방향키/Enter** 로 키보드 탐색, **Esc** 로 검색어 클리어.

### 에디터 패널 (가운데)
- 파일 본문 (`HEAD` 기준) + Shiki 신택스 하이라이팅.
- **인라인 blame 거터**: 줄마다 컬러 스트라이프 + short SHA + 작성자 + 상대 시간 (예: `1234abcd  Hyunw…  3d`).
    - 색상은 commit SHA를 hash해서 HSL로 산출 (테마별 다른 채도/명도).
    - 미커밋 라인은 회색 점선 패턴 + `—` + `uncommitted`.
- **라인 호버 시 팝오버**: 작성자, 상대 날짜, 커밋 제목, short SHA, `View commit →` 액션.
    - SHA 클릭 → 클립보드 복사 + 토스트.
    - `View commit →` 클릭 → 그 커밋의 변경 전체로 **drill-in** (`<sha>^..<sha>` 비교 화면으로 전환).
- **같은 커밋의 동료 라인 자동 하이라이트**: 한 줄에 호버하면 같은 커밋의 모든 라인이 부드럽게 강조.
- **라인 클릭** → 우측 커밋 패널에서 해당 커밋을 선택(sticky 하이라이트로 고정).

### 커밋 패널 (우측)
파일에 기여한 모든 커밋 목록.

- 각 행: 컬러 닷, short SHA, 작성자, 커밋 제목, 상대 시간, 기여 라인 수.
- 정렬 옵션 (드롭다운):
    - **Recent first** — 최신 커밋 먼저 (기본)
    - **By first line** — 파일 내 첫 등장 라인 순
    - **Most lines** — 기여 라인 수 내림차순
- **클릭** → 에디터에서 해당 커밋의 첫 라인으로 스크롤 + 모든 해당 라인을 진하게 하이라이트(sticky).
- **`→` 버튼** (호버 시 노출) → 그 커밋으로 drill-in.

### 미커밋 라인 처리
Worktree 편집은 `git blame --contents <fs_path> HEAD` 로 처리되어 `00000000` SHA로 표기됩니다 → 팝오버에 `Not Committed Yet (uncommitted edits — not yet in HEAD)` 표시.

### 파일 타임랩스 (🎞 Timelapse)
툴바의 **🎞 Timelapse** 버튼으로 그 파일의 모든 리비전을 영상처럼 재생/스크럽합니다.

- **하이브리드 표시**: 각 리비전의 내용을 제자리에 고정하고, 직전 대비 **변경 줄만 강조**(추가=녹색, 삭제=빨강) → 재생이 출렁임 없이 흐릅니다.
- **VS식 미니맵**: 파일 전체를 우측 strip에 축소 렌더 + 추가/삭제 막대 + 뷰포트 박스(클릭·드래그로 스크롤). 변경이 여러 곳에 흩어져도 한눈에.
- **구문 색**: 프레임이 멈출 때(settle)만 Shiki 적용 — 빠른 재생은 매끄럽게, 머무를 땐 풀 컬러.
- 컨트롤: ⏮ ▶/⏸ ⏭ · 타임라인 슬라이더 · 1×~8× 속도. 키보드: Space 재생/정지, ←/→ 스텝, Esc 닫기.

---

## 5. Commit Drill-in & 히스토리

Blame 팝오버 또는 커밋 패널에서 **View commit →** / **`→`** 를 클릭하면 메인 화면이 그 커밋의 변경 전체(`<sha>^..<sha>`)로 일시 전환됩니다.

- 상단에 **breadcrumb** 가 표시되어 이전 컨텍스트를 알려줍니다.
- **무한 깊이**: drill-in 안에서 또 blame을 켜서 또 drill 가능 (history stack 누적).
- **돌아가기**:
    - **`Esc`** 키
    - breadcrumb의 **← Back** 버튼
- 돌아가면 직전에 보던 파일까지 자동 복원됩니다 (`CompareCtx` 스냅샷에 selectedFilePath 포함).
- 히스토리는 **세션 한정** — 앱 재시작 시 비워집니다.

---

## 6. 단축키 전체 목록

### 전역
| 키 | 동작 |
|---|---|
| `Ctrl+Shift+W` | 워크스페이스 순환 전환 |
| `Ctrl+Shift+P` | 커맨드 팔레트 (모드 전환 / 테마 / fetch·pull / 브랜치 checkout 등) |
| `Ctrl` + `+` / `-` / `0` | 에디터 폰트 크기 증가 / 감소 / 기본값 복귀 |
| `Esc` | drill-in 히스토리 pop → Focus 모드 해제 → 검색 패널 닫기 순으로 처리 |

### Compare 모드 (Branch / Working Copy)
| 키 | 동작 |
|---|---|
| `↑` / `↓` | 다음 / 이전 파일 |
| `n` / `p` | 다음 / 이전 변경 청크 |
| `Ctrl+F` | 현재 파일에서 검색 |
| `Ctrl+G` | 라인 번호로 점프 |
| `F5` / `Ctrl+R` | Working Copy 새로고침 (Branch 모드에선 무동작) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | (Tabs 레이아웃) 다음 / 이전 탭 |
| `Ctrl+1` ~ `Ctrl+9` | (Tabs 레이아웃) 해당 인덱스 탭으로 직접 점프 |

### Blame 모드
| 키 | 동작 |
|---|---|
| 파일 피커에서 `↑` / `↓` | 매칭 결과 탐색 |
| 파일 피커에서 `Enter` | 선택한 파일 열기 |
| 파일 피커에서 `Esc` | 검색어 클리어 (비어 있으면 drill-in pop) |
| `Ctrl+F` | 에디터에서 본문 검색 |
| `Ctrl+G` | 라인 번호로 점프 |

> ref 입력란이나 검색창에 포커스가 있을 때 일반 키(`n/p` 등)와 화살표 키는 입력으로 흡수됩니다. `Ctrl+Shift+W` 와 `Ctrl±` 만 포커스 무시하고 동작합니다.

---

## 7. 옵션 / 토글

| 위치 | 옵션 | 의미 |
|---|---|---|
| InputBar | **since fork (...) / direct (..)** | merge-base 기준(PR style) ↔ 직접 비교 |
| InputBar | **ws** 체크박스 | `-w` 공백 변화 무시 |
| InputBar | **Theme** | System(OS 따라감) / Light / Dark |
| FileList | **Tree / Flat** | 파일 리스트 표시 모드 |
| DiffView | **Split / Unified** | 좌우 분할 vs 단일 컬럼 |
| DiffView | **Language** 드롭다운 | 자동 감지 override |
| DiffView/BlameView | **A− / 숫자 / A+** | 폰트 크기 (Ctrl+/-/0 동일) |
| BlameView | 정렬 드롭다운 | Recent / First line / Most lines |

`compare_mode`, `theme`, `font_size`, `recent_repos`는 영속화됩니다 (앱 재시작 후 복원).
`appMode`, `blameFilePath`, drill-in 히스토리는 **세션 한정**.

---

## 8. 시각 디테일

- **Diff 색상**: 변경된 토큰은 underline이 아닌 GitHub 스타일 **filled background** (add: 녹색 톤, del: 빨강 톤). 단순 추가/삭제 라인에는 토큰 배경 생략 — 라인 전체 배경만으로 충분히 표시.
- **컬러 스트라이프**: blame 거터와 커밋 패널 닷의 색상은 커밋 SHA 해시 → HSL 360°.
- **모드 토글 액티브 상태**: Rider 스타일 — 같은 색계열의 soft fill + 하단 accent underline.

---

## 9. 개발

### 요구사항
- Node.js 22+
- Rust stable + Visual Studio Build Tools (Windows MSVC)
- `git` 이 PATH에 있어야 함 (Riff는 git CLI를 shell out 호출)

### 셋업
```sh
npm install
npm run tauri dev
```

### 검증
```sh
npm run check                                       # Svelte + TS 타입체크
cargo check --manifest-path src-tauri/Cargo.toml    # Rust 컴파일 체크
cargo test  --manifest-path src-tauri/Cargo.toml    # 유닛 테스트 (blame porcelain 파서 등)
```

### 프로젝트 구조
```
src/                            SvelteKit 프론트엔드
  routes/+page.svelte           최상위 레이아웃 + 전역 키 핸들러
  lib/
    ui/
      InputBar.svelte           워크스페이스 토글 + ref/경로 입력
      BranchModeFields.svelte   Branch 모드 ref 입력
      WorkTreeFields.svelte     Working Tree 모드 라벨
      FileList.svelte           좌측 변경 파일 리스트 (Flat/Tree)
      DiffView.svelte           CodeMirror MergeView 통합
      BlameView.svelte          파일 피커 + blame 에디터 + 커밋 패널
      Breadcrumb.svelte         drill-in 히스토리 네비
      TitleBar.svelte           커스텀 타이틀바 (decorations: false)
      Dropdown.svelte           재사용 드롭다운
      PathTreeNode / TreeNode   재귀 트리 노드
      pathTree.ts / tree.ts     트리 빌더
    diff/                       Shiki + 언어 감지 + 활성 view ref
    git.ts                      Tauri command 래퍼
    history.ts                  drill-in 히스토리 스택
    compare.ts                  compare() / setMode() / cycleAppMode()
    store.svelte.ts             AppState (Svelte 5 runes)
    theme.ts                    테마 적용 + matchMedia 구독
    font.ts                     폰트 크기 영속화
    updater.ts                  업데이트 체크
src-tauri/
  src/
    git/                        GitLayer trait + GitCli (git shell out)
      blame.rs                  --porcelain 파서 + 단위 테스트
      cli.rs                    diff_files / file_diff / worktree_files / blame_file
    store/                      PersistedState (recent / theme / font / mode)
    lib.rs                      Tauri command + plugin 초기화
  capabilities/                 Tauri 2 permissions
  tauri.conf.json               번들 + updater 설정
.github/workflows/
  ci.yml                        PR/push 시 lint + 타입체크
  release.yml                   tag push (v*) → 빌드 + 서명 + draft release
PLAN.md                         설계 문서 (의사결정 트레이스 포함)
```

---

## 10. 릴리스 절차

`v*` 태그를 push하면 `.github/workflows/release.yml` 가 Windows 러너에서 빌드 → 자동 업데이터용 ed25519 서명 → **draft** GitHub Release 생성 → 인스톨러 + `latest.json` 업로드까지 자동 수행합니다.

### 최초 1회 셋업 (첫 릴리스 전)

1. **updater 서명 키 생성** — 로컬에서 안전하게 보관할 것.
    ```sh
    npx @tauri-apps/cli signer generate -w riff-updater.key
    ```
    패스워드는 GitHub Secret에 등록할 값이라 기억 필수.

2. **private key 백업**. `riff-updater.key` 를 패스워드 매니저(1Password / Bitwarden 등)에 별도 저장. **GitHub Secrets는 백업이 아닙니다** — 이 키를 잃으면 모든 사용자의 자동 업데이트가 영구적으로 끊깁니다 (수동 재설치만이 복구).

3. **GitHub repo secrets 등록** (Settings → Secrets and variables → Actions):
    - `TAURI_SIGNING_PRIVATE_KEY` — `riff-updater.key` 의 전체 내용
    - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — 1단계 패스워드

4. `signer generate` 가 출력한 **public key** 를 `src-tauri/tauri.conf.json` 의 `plugins.updater.pubkey` 에 붙여넣기. 커밋 & push.

### 릴리스 컷
```sh
# 1) CHANGELOG.md 최상단에 새 ## vX.Y.Z 섹션 추가 (릴리스 본문으로 자동 사용됨)
# 2) 버전을 5곳에서 동일하게 bump: package.json, package-lock.json,
#    src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

워크플로가 `CHANGELOG.md` 최상단 섹션을 릴리스 본문으로 추출해 **draft** Release를 생성합니다. 노트를 검토/편집 후 **Publish** 누르면 설치된 클라이언트들이 다음 시작 시 새 `latest.json` 을 감지해 업데이트 배너를 띄웁니다.

---

## 11. 라이선스

MIT — `LICENSE` 파일 참조.
