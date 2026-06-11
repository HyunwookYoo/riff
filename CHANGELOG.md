# Changelog

Riff의 주요 변경사항을 기록합니다. 최상단 섹션은
`.github/workflows/release.yml`에 의해 GitHub Release 본문으로 사용됩니다.

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
