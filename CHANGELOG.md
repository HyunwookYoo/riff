# Changelog

Riff의 주요 변경사항을 기록합니다. 최상단 섹션은
`.github/workflows/release.yml`에 의해 GitHub Release 본문으로 사용됩니다.

## v1.1.6

소스 컨트롤·그래프 사용성 개선 묶음.

### ✨ 개선

- **Hunk 단위 discard** — Working 뷰 diff에서 hunk에 마우스를 올리면 **↩ Discard**가 떠서
  그 hunk만 되돌립니다(스테이지/커밋 상태로 복원, 확인 후). 파일 전체를 되돌릴 필요 없이 일부만
  버릴 수 있습니다.
- **브랜치 배지에서 바로 필터** — 그래프의 브랜치/현재/리모트 배지에 마우스를 올리면 **깔때기
  버튼**이 떠서 그래프를 그 브랜치로 좁힙니다(`git log <branch>`). 다시 누르면 전체로 돌아오고,
  필터 중인 배지는 깔때기가 켜진 채 표시됩니다.
- **선택한 뷰 기억** — Changes에서 Working / Graph 중 마지막으로 본 서브뷰를 기억해 Branch·Blame에
  갔다 와도 그 화면으로 돌아옵니다(이전엔 항상 Working). 세션 한정.
- **Delete 키로 파일 discard** — Changes에서 변경 파일을 선택하고 **Delete**를 누르면 그 파일의
  변경을 폐기합니다(행의 ↩ 버튼과 동일, 확인 후). 입력 중(커밋 메시지 등)에는 동작하지 않습니다.

### 🐛 수정

- **그래프에서 서브모듈 변경이 안 보이던 문제** — 서브모듈 포인터를 올린(bump) 커밋을 그래프에서
  보면 그 변경이 통째로 숨겨졌습니다. 이제 `Subproject commit 옛→새`로 표시됩니다.

### 📦 설치 / 업그레이드

- **기존 1.1.x 사용자**: 자동 업데이터가 다음 실행 시 배너를 띄웁니다 → **Install and restart**.
- **신규 설치**: 아래 assets에서 `Riff_1.1.6_x64-setup.exe` 다운로드 → 실행.

## v1.1.5

작은 버그 수정.

### 🐛 수정

- **에러 메시지가 바로 사라지던 문제** — push·commit·merge·stash 등이 실패하면 에러가 떴다가
  직후 새로고침에 덮여 곧바로 사라졌습니다(예: rebase 후 push의 non-fast-forward 거부). 이제
  실패 메시지가 그대로 남고, 다음 작업이 성공하면 깨끗이 사라집니다.

### 📦 설치 / 업그레이드

- **기존 1.1.x 사용자**: 자동 업데이터가 다음 실행 시 배너를 띄웁니다 → **Install and restart**.
- **신규 설치**: 아래 assets에서 `Riff_1.1.5_x64-setup.exe` 다운로드 → 실행.

## v1.1.4

rebase·sync 등 긴 작업의 진행 표시와 UI 안정화.

### ✨ 개선

- **긴 작업 진행 표시 + 깜빡임 제거** — rebase처럼 커밋을 여러 개 재생하는 작업 중에 그래프가
  매 커밋마다 갱신되며 깜빡이던 문제를 없앴습니다(작업이 끝나거나 충돌로 멈출 때 한 번만 반영).
  진행 중에는 상단에 **Rebasing…/Merging…/Pulling…** 진행 배너로 "작업 중이니 기다리라"고
  안내합니다.
- **충돌 배너 구분** — 실제로 해결 안 된 충돌이 있을 때만 빨간 배너로 경고하고, 다 해결해서
  stage하면 차분한 색으로 "Continue로 마무리"를 안내합니다. (충돌 없는 rebase는 배너 없이
  끝까지 자동 진행)
- **fetch/push 스핀** — 동기화 중 버튼 전체가 돌던 것을 새로고침 아이콘만 회전하도록 정리.

### 📦 설치 / 업그레이드

- **기존 1.1.x 사용자**: 자동 업데이터가 다음 실행 시 배너를 띄웁니다 → **Install and restart**.
- **신규 설치**: 아래 assets에서 `Riff_1.1.4_x64-setup.exe` 다운로드 → 실행.

## v1.1.3

UI 반응성 개선.

### ✨ 개선

- **스캔 중에도 멈추지 않는 UI** — 파일 탐색·변경점 스캔(`git status`/`log`/`diff` 등)을
  백그라운드로 옮겨, 큰 레포에서 스캔이 도는 동안에도 창 드래그·스크롤 등 UI 조작이 그대로
  됩니다. 이전엔 스캔이 끝날 때까지 앱 전체가 멈춘 것처럼 느껴졌습니다. 동시에 들어오는
  새로고침은 최신 결과만 반영하고, git 쓰기 작업은 서로 충돌하지 않도록 직렬화했습니다.

### 📦 설치 / 업그레이드

- **기존 1.1.x 사용자**: 자동 업데이터가 다음 실행 시 배너를 띄웁니다 → **Install and restart**.
- **신규 설치**: 아래 assets에서 `Riff_1.1.3_x64-setup.exe` 다운로드 → 실행.

## v1.1.2

성능 개선과 작은 기능 추가.

### ✨ 개선

- **변경 자동 감지 (파일 워처)** — 외부 git 작업이나 파일 편집을 백엔드 파일시스템 워처로
  감지해, 창을 다시 포커스하지 않아도 Working·Graph가 자동 갱신됩니다. 포커스할 때마다 전체를
  다시 스캔하던 방식을 대체 — 특히 커밋이 많은 큰 레포에서 빠릿합니다. 빌드 산출물 churn은
  gitignore로 무시하고, 변경은 묶어서(debounce) 한 번에 반영합니다.
- **사이드바 브랜치 → 그래프에서 보기** — Graph가 열려 있을 때 사이드바의 브랜치를 한 번
  클릭하면 그 브랜치가 그래프에서 선택됩니다(더블 클릭은 기존처럼 checkout). tip이 이미 로드돼
  있으면 그 자리에서, 아니면 "Showing"을 그 브랜치로 좁혀 tip을 선택합니다.

### 📦 설치 / 업그레이드

- **기존 1.1.x 사용자**: 자동 업데이터가 다음 실행 시 배너를 띄웁니다 → **Install and restart**.
- **신규 설치**: 아래 assets에서 `Riff_1.1.2_x64-setup.exe` 다운로드 → 실행.

## v1.1.1

작은 개선과 버그 수정.

### ✨ 개선

- **Submodule 탭 재정렬** — Changes·History 모드의 repo 탭을 드래그해서 순서를 바꿀 수
  있습니다(main 탭은 맨 앞 고정). 현재는 세션 한정.

### 🐛 수정

- Branch 모드에서 비교할 ref를 아직 고르지 않았는데, Changes 모드에서 자동 선택된 파일이
  남아 코드 영역에 "no refs to compare for this file" 오류가 뜨던 문제 수정.

### 📦 설치 / 업그레이드

- **기존 1.1.x 사용자**: 자동 업데이터가 다음 실행 시 배너를 띄웁니다 → **Install and restart**.
- **신규 설치**: 아래 assets에서 `Riff_1.1.1_x64-setup.exe` 다운로드 → 실행.

## v1.1.0

소스 컨트롤(Changes)과 Branch 모드를 다듬은 업데이트입니다. hunk 단위 changelist,
충돌 해결 UX, 그리고 "내 브랜치가 타깃에 들어갔나"를 한눈에 보는 컨테인먼트 뷰가
더해졌습니다.

### ✨ 하이라이트

- **Branch 컨테인먼트** — Branch 모드에서 `start → target` 커밋들이 타깃에 들어갔는지
  표시합니다: ✓ 초록(그대로 포함) · ✓ 파랑(rebase/cherry-pick로 적용됨) · ● 빨강(미반영)
  \+ ahead/behind 요약. 커밋을 누르면 그 커밋의 변경점과 "어떤 머지로 들어왔는지"를 봅니다.
- **hunk 단위 changelist** — diff에서 hunk에 마우스를 올리면 **Assign** 버튼이 떠서 그
  hunk를 원하는 changelist에 배정합니다. 분할된 파일은 `k/n` 배지로 표시되고, 커밋하면
  해당 hunk만 들어갑니다(changelist가 2개 이상일 때).
- **충돌 해결** — Working 최상단에 **Conflicts** 그룹, 충돌 배너의 **Resolve** 버튼,
  3-way 해결기에 이전/다음 충돌 이동 · 첫 충돌 자동 스크롤 · 강조 강화.
- **파일 트리 뷰 & discard** — changelist 안 파일을 디렉터리 트리로 보고(Flat/Tree 토글),
  파일별로 변경을 되돌릴(discard) 수 있습니다.
- **시작 화면을 Changes(Working)로** — 가장 많이 쓰는 화면이 앱을 열 때 바로 뜹니다.

### 🐛 수정

- 파괴적 확인창(discard · hard reset · rebase · 브랜치 force-delete · force-push)이
  WebView2에서 뜨지 않아 동작이 조용히 취소되던 문제 — Tauri 네이티브 다이얼로그로 교체.

### 📦 설치 / 업그레이드

- **기존 1.0.x 사용자**: 자동 업데이터가 다음 실행 시 배너를 띄웁니다 → **Install and restart**.
- **신규 설치**: 아래 assets에서 `Riff_1.1.0_x64-setup.exe` 다운로드 → 실행. 코드 서명
  인증서가 없어 SmartScreen 경고가 뜨면 **추가 정보 → 실행**.

## v1.0.0

Riff가 **2-브랜치 diff 뷰어**에서 **완전한 Git 클라이언트**로 도약했습니다.
기존 브랜치 비교·blame은 그대로, 여기에 소스 컨트롤·커밋 그래프·동기화·
머지/충돌 해결·stash·파일 타임랩스가 더해졌습니다.

### ✨ 하이라이트

- **소스 컨트롤 (Changes)** — 변경 파일을 *changelist*(Perforce/JetBrains식
  명명 버킷)로 묶어 버킷 단위로 커밋. 드래그·우클릭으로 파일 분류, repo별 영속.
- **커밋 그래프 (Graph)** — 브랜치/태그 배지, 커밋별 액션, 배지 **드래그&드롭
  머지/리베이스**, 미커밋을 표시하는 WIP 노드.
- **동기화 & 머지** — fetch / pull / push, 인앱 **3-way 충돌 해결기**, stash.
- **파일 타임랩스** — blame에서 파일의 전 리비전을 영상처럼 재생. 변경 줄 강조 +
  VS식 미니맵 + (정지 시) 구문 색.
- **이미지 diff** — side-by-side / swipe / onion + 줌·팬.
- **커맨드 팔레트** (`Ctrl+Shift+P`).

### 소스 컨트롤 (Changes)
- `git status --porcelain=v2` 기반 변경 화면
- Changelist: 명명 버킷 + 드래그/우클릭 이동 + repo별 영속(`.git/riff-changelists.json`)
- 버킷 단위 커밋(subject/body, sign-off, co-author)
- Unreal `.uasset`/`.umap` 속성 뷰(번들 UAssetGUI)

### 브랜치 & 그래프
- 커밋 그래프 + 브랜치/태그 배지 + 커밋별 액션
- refs 사이드바: checkout / 생성 / 이름변경 / 삭제, Fork식 Working Copy / Graph 네비
- 로컬+리모트 동일 위치 배지 통합, 행 높이 조절, all-branches 리셋
- 배지 드래그&드롭 머지/리베이스, WIP 노드, 포커스 복귀 시 그래프 새로고침

### 동기화 · 머지 · stash
- fetch / pull / push (ahead/behind 카운트)
- 머지 + 인앱 3-way 충돌 해결기 (abort / continue)
- 로컬 변경 보유 시 checkout(stash-reapply / 유지 / 폐기), 리모트 checkout + fast-forward
- stash save / apply / pop / drop

### diff & 탐색
- 이미지 diff (side-by-side / swipe / onion + 줌·팬)
- 좁은 패널에선 인라인 diff로 폴백
- 커맨드 팔레트(`Ctrl+Shift+P`), 파일 피커 필터 박스

### blame
- 파일 타임랩스: 하이브리드 표시(내용 고정 + 변경 줄 강조), VS식 미니맵,
  settle 시 구문 색

### 패키징
- 셀프컨테인 단일 파일 **UAssetGUI** 번들 → Unreal 에셋 프리뷰 제로 설정

### 📦 설치 / 업그레이드
- **신규 설치**: 아래 assets에서 `Riff_1.0.0_x64-setup.exe` 다운로드 → 실행.
  코드 서명 인증서가 없어 SmartScreen 경고가 뜨면 **추가 정보 → 실행**.
- **기존 0.x 사용자**: 자동 업데이터가 다음 실행 시 배너를 띄웁니다 →
  **Install and restart** 클릭으로 갱신.

### ⚠️ 알려진 제한
- 파일 타임랩스는 v1에서 **리네임 추적 안 함** — 현재 경로가 도입된 지점에서
  히스토리가 멈춥니다.
- Windows 전용 빌드입니다.

---

이전 릴리스(0.x)는
[GitHub releases](https://github.com/HyunwookYoo/riff/releases) 기록을 참고하세요.
