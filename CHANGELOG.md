# Changelog

Riff의 주요 변경사항을 기록합니다. 최상단 섹션은
`.github/workflows/release.yml`에 의해 GitHub Release 본문으로 사용됩니다.

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
