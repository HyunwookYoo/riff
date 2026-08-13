> **SUPERSEDED (2026-08-12)** — 이 문서는 riff를 풀 Git 클라이언트로 확장하는 방향이었고, 그 방향은 폐기되었습니다. 현재 설계는 `docs/superpowers/specs/2026-08-12-vcs-scope-reduction-design.md` 를 보세요. 이 문서는 그 시도가 있었다는 기록으로 남겨둡니다.

# Riff — Version Control 기능 설계 문서

> Riff를 "안전한 읽기전용 diff 뷰어"에서 **본격 Git 클라이언트**로 확장하는 설계.
> 현재 서비스 중인 VCS(Fork / Tower / SourceTree / GitKraken / Sublime Merge / Perforce)의
> 호평받은 UX를 추려 구현하되, **뷰어 구현 코드를 최대한 재사용**한다.
> 본 문서는 grill-me 인터뷰를 통해 합의된 의사결정의 결과물이다. (PLAN.md 후속)

---

## 1. 목표와 정체성 전환

| 항목 | 내용 |
|---|---|
| **무엇을** | branch 생성·commit·push 만이 아니라, 호평받은 VCS UX를 추려 **풀 클라이언트** 구현 |
| **어떻게** | 뷰어 자산(word-level diff, syntax, blame, 그래프, 서브모듈, uasset) **최대 재사용** |
| **정체성 전환** | riff는 "읽기전용 보장 뷰어"를 **포기**하고 write 동작을 항상 손 닿는 거리에 두는 통합 클라이언트가 된다 |
| **범위 전략** | **Tier 1 코어 루프부터** 구현하되, 레이아웃·백엔드는 **Tier 2/3까지 수용**하도록 설계 |

---

## 2. 핵심 결정 누적

| 가지 | 결정 | 근거 |
|---|---|---|
| **아키텍처** | 통합 클라이언트 (상위 스위치 없음, viewer 흡수) | 재사용 극대화. 풀스펙(rebase·충돌·changelist)을 viewer에 ambient하게 욱여넣는 것은 불가 → 전용 워크스페이스가 자연스러우나, 별도 앱이 아니라 한 클라이언트로 통합 |
| **범위** | Tier 1 코어부터, 구조는 풀스펙 대비 | 각 단계 독립 릴리스. 동작하는 제품을 매 단계 유지 |
| **레이아웃** | 별개 화면(Changes/History/Compare/Blame) + **토글** refs 사이드바, **모드바=화면 전환** | Fork/Tower의 별개-화면(재사용 극대) + Sublime Merge의 토글 사이드바(넓은 화면·키보드 친화). 사이드바가 숨겨지므로 화면 전환은 기존 모드바가 담당 |
| **백엔드** | git CLI 유지 + **네트워크만** Channel 스트리밍 + credential helper 위임 | 성능 차이는 이 표면(write=인간속도, 네트워크=네트워크속도, 핫 read는 이미 캐시)에서 체감 0. 구속 조건은 호환성(인증·hooks·LFS·서브모듈) → CLI 압승. 현 코드 패턴과 일관 |
| **Staging** | porcelain=v2 / 2-리스트(Unstaged·Staged) / 파일+hunk / **Rust 서브패치 + git apply --cached** | 3-tree 모델 분리. hunk는 `git add -p` 금지, 서브패치 방식. 렌더(Change[])와 stage 액션(텍스트 패치) 평행 공존 |
| **Commit** | subject+body 분리 / amend+sign-off+co-author / "Commit to \<branch\>" | Tower/Fork/GHD 호평 패턴. GPG·hook은 git config·자동(UI 없음) |
| **refs/네트워크** | 사이드바=활성(포커스) 레포 / pull ▾[merge|rebase] / push + **force-with-lease는 명시 확인 뒤에만** | 멀티루트는 compare와 동일 Focus 모델. 생 `--force` 절대 없음 — 전역 안전 지침 준수 |

---

## 3. 화면 구성 (통합 클라이언트)

```
┌─ [Changes] [History] [Compare] [Blame] ───── ⎇main ↑3 ↓1  ⟳Fetch ↓Pull▾ ↑Push ─┐  ← 모드바=화면 전환 + 네트워크 툴바
├──────┬──────────────────────────────────────────────────────────────────────────┤
│ refs │  선택된 화면                                                               │
│ 사이드│   Changes → 좌:[Unstaged↑ / Staged↓ / 커밋박스]  우:DiffView                │
│ 바    │   History → 좌:[그래프+커밋목록 / 커밋 파일목록]  우:DiffView (기존 그대로)  │
│(토글  │   Compare → 기존 2-ref 비교 (기존 그대로)                                   │
│ Ctrl+B│   Blame   → 기존 Blame (기존 그대로)                                        │
│ 숨김) │                                                                            │
│       │  사이드바: 활성 레포의 Local / Remotes / Tags / Stashes 트리                │
│       │  우클릭 → checkout / new branch / rename / delete / set-upstream            │
└──────┴──────────────────────────────────────────────────────────────────────────┘
```

- **모드바**: 기존 `InputBar` 모드 토글 재사용. `AppMode`는 *별개 앱*이 아니라 한 클라이언트 안의 **패널 전환**이 된다.
- **"Working Tree" 모드 → "Changes"로 흡수**: 읽기전용 worktree 뷰는 staged/unstaged 분리 + staging/commit을 가진 Changes의 부분집합이므로 대체.
- **refs 사이드바**: 신규. 기본 숨김, `Ctrl+B`류 토글. 활성 레포(`activeRepoIdx`, 없으면 main) 하나의 refs만. Focus 전환 시 사이드바도 전환(compare와 동일 모델).

---

## 4. 백엔드 실행 모델

| 동작 유형 | 실행 | 비고 |
|---|---|---|
| 로컬 write (commit/branch/stage/add/restore) | `GitCli::run(path, &[args])` 일회성 | 기존 `list_refs`·`commit_log`와 동일 패턴 (`cli.rs:293`) |
| 네트워크 (fetch/pull/push) | spawn + `tauri::ipc::Channel`(진행률) + 취소 | 기존 `diff_files`의 child-kill 슬롯 패턴 재사용 (`Session.*_child`) |
| 인증 | git credential helper(Windows=Git Credential Manager)에 위임 | 앱 내 비밀번호 UI 없음 |
| GPG 서명 / hooks / LFS / 서브모듈 | git이 자동 처리 | CLI라서 재구현 표면 0 |
| 에러 | `GitError::CommandFailed(stderr)` | hook 실패 stderr 전문 노출. **`--no-verify` 금지** |

> 라이브러리(libgit2/gitoxide)는 비채택: perf 이득이 이 표면에서 체감되지 않고, 인증·hooks·LFS·서브모듈을 직접 재구현해야 해 호환성 리스크가 크며, 현 100% CLI 코드와 이질적.

---

## 5. Staging 설계 (3-tree)

Git은 트리가 셋(HEAD / index=스테이징 / 작업트리). 현재 riff는 HEAD↔worktree 2-tree로 합쳐 본다. Staging은 이를 분리한다:

```
        git diff --cached         git diff
HEAD  ◀───── Staged ──────▶ index ◀──── Unstaged ────▶ 작업트리
       (HEAD blob↔index)          (index blob↔디스크)
```

| 요소 | 설계 |
|---|---|
| 상태 엔진 | `git status --porcelain=v2 -z` 한 패스 → `{path, old_path, X(index), Y(worktree)}` + `# branch.ab +A -B`(ahead/behind)·upstream. **파서 단위테스트** |
| 분류 | X≠'.' → Staged, Y≠'.' → Unstaged. **한 파일이 양쪽 동시 가능**(부분 스테이징) |
| Unstaged diff | old=`:path`(index blob), new=디스크 |
| Staged diff | old=`HEAD:path`, new=`:path`(index blob) |
| 렌더링 | 기존 DiffView + `compute_changes`(UTF-16 Change[]) **그대로** 재사용 |
| 파일 stage | `git add -- <path>` / unstage: `git restore --staged -- <path>` / [Stage all] |
| **hunk stage** | 프론트→`{path, side, hunkIdx[]}`→ Rust: `git diff[--cached] -- path` → hunk 파싱 → 선택 hunk 서브패치 → `git apply --cached [--reverse]`. **파서 단위테스트** |
| 표현 분리 | 렌더=Change[], stage 액션=git 텍스트 패치 — **평행 공존** (`git apply`엔 텍스트 패치만 가능) |
| 재사용 | cat-file batch(스펙 `:path`·`HEAD:path` 추가), uasset derive, too-large 가드, EOL 정규화, FS watcher(`.git/` 감시→index 쓰기 자동 무효화) |

### 엣지 룰 (기본값)
1. **hunk drift**: apply 직전 Rust가 `git diff`를 새로 돌려 신선한 diff 기준 적용. hunk 개수 달라지면 거부("파일 변경됨, 새로고침"). 필요 시 hunk 내용 해시 대조.
2. **untracked hunk staging**: untracked는 index 엔트리가 없어 `git diff`에 안 잡힘 → **v1은 통째 stage만**. (v2에서 `git add -N` 옵션)

---

## 6. Commit UX

```
에디터:  Summary(소프트 50자 힌트) + Description 멀티라인(72 가이드)
옵션:    ☑ Amend last commit  (체크 시 git log -1 --format=%B 로 이전 메시지 로드 → git commit --amend)
         ☑ Sign-off (-s)
         [+ Add co-author]  → Co-authored-by 트레일러
         GPG/hook = git config·자동 (UI 없음)
대상:    staged만 커밋(git commit) + [Stage all] 별도 버튼
버튼:    "Commit to <branch>"  /  Ctrl+Enter  /  staged 빔(amend 제외)·subject 빔이면 비활성
경고:    amend 대상이 이미 push됨이면 소프트 경고(차단 X). detached HEAD면 배너
성공 후:  메시지 비움 → status 새로고침(staged 비워짐) → ahead/behind +1
빈 메시지/빈 커밋: 차단 (--allow-empty 미사용)
hook 실패: stderr 전문 에러 패널 표시 (--no-verify 금지)
```

백엔드: `commit(subject, body, amend, signoff, coauthors)` → `git commit` 일회성. (hook 느릴 시 스피너+비활성; 문제되면 스트리밍으로 전환)

---

## 7. refs 사이드바 + branch / 네트워크

| 요소 | 설계 |
|---|---|
| 사이드바 구조 | `Local / Remotes / Tags / Stashes` 섹션. `feature/foo`는 `/`로 폴더 중첩(Fork/Tower식). 현재 브랜치 하이라이트 + `↑3 ↓1` 배지 |
| ahead/behind | porcelain=v2 `# branch.ab` 재사용 (별도 rev-list 불필요) |
| v1 우클릭 액션 | checkout · 새 브랜치(여기서) · rename · delete · set-upstream/push |
| branch 백엔드 | create/checkout/rename/delete/set-upstream — `run()` 일회성 |
| 툴바 | Fetch / Pull ▾[merge|rebase] / Push + ahead/behind 카운트 |
| 첫 push | upstream 없으면 `--set-upstream origin <branch>` 프롬프트 |
| pull 충돌 | v1은 배너("충돌 — 외부 해결 또는 abort"). 인앱 해결은 Tier 2 |
| **force-push** | `--force-with-lease`만, **명시 확인 다이얼로그 뒤에만**. 생 `--force` 절대 없음 |
| Stash | v1은 섹션 표시(읽기)만. save/pop/apply/drop은 Tier 2 |

---

## 8. 재사용 매핑 (뷰어 → 클라이언트)

| 기존 자산 | VCS에서의 재사용 |
|---|---|
| `worktree_files`(diff HEAD + ls-files) | `status --porcelain=v2`로 교체·확장 (staged/unstaged 분리) |
| `worktree_file_diff` | 측별 diff로 일반화 (old/new 스펙만 교체) |
| `compute_changes` + CodeMirror 주입 | staged/unstaged 양쪽 diff 렌더에 그대로 |
| cat-file batch | `:path`(index)·`HEAD:path` 스펙 추가 |
| `diff_files` child-kill 스트리밍 | fetch/pull/push 진행률·취소 |
| `list_refs` / `branchesByRepoIdx` | refs 사이드바 트리 |
| `activeRepoIdx`(Focus) | 사이드바 활성 레포 스코프 |
| History 모드(그래프) | 그대로. 우클릭 액션은 Tier 2 |
| FS watcher + worktree 캐시 | index 변경 자동 무효화 |

---

## 9. Tier 1 빌드 순서 (의존성 정렬, 각 단계 독립 릴리스)

### Phase 0 — 상태 엔진 (모든 게 여기 의존)
- `status()` 백엔드: `git status --porcelain=v2 -z` → 엔트리 + branch 헤더(ahead/behind·upstream). **파서 단위테스트**.
- 프론트 타입 + `git.ts` 바인딩 + store(staged/unstaged/ahead/behind/upstream). 기존 worktree 모드와 공존.

### Phase 1 — Changes 화면 (코어의 심장)
- **1.1** 화면 스캐폴드: 모드바에 Changes, 좌 Unstaged↑/Staged↓/커밋박스, 우 DiffView. 측별 diff. (읽기전용 먼저)
- **1.2** 파일 stage/unstage: `git add` / `git restore --staged` + [Stage all], 후 status 새로고침.
- **1.3** Commit: 백엔드 `commit(...)` + 커밋박스(subject+body·amend·sign-off·co-author·Commit to branch·Ctrl+Enter) + hook 실패 노출 + 후처리 전이.
- **1.4** hunk stage/unstage: 서브패치 빌더(파서 단위테스트) + DiffView 거터 버튼 + drift 가드.

### Phase 2 — Branch + refs 사이드바
- **2.1** 백엔드 branch: create/checkout/rename/delete/set-upstream.
- **2.2** 사이드바(토글 Ctrl+B): 활성 레포 트리 + 하이라이트/배지 + 우클릭→명령.
- **2.3** "New branch" 전역 버튼 + 다이얼로그.

### Phase 3 — 네트워크 fetch/pull/push
- **3.1** 백엔드 스트리밍 fetch/pull/push: Channel + 취소, credential helper.
- **3.2** 툴바 + ahead/behind + set-upstream 프롬프트 + 진행률·취소 + pull 충돌 배너.
- **3.3** Force-push(with-lease) 명시 확인 다이얼로그.

### Phase 4 — viewer 흡수 마무리
- 모드바 최종화(Changes·History·Compare·Blame), Working Tree→Changes 대체, `cycleAppMode`/InputBar 갱신. (0–3 동안 기존 모드 살려두다 마지막 정리 → 리스크 최소)

### 가로지르는 규칙
- 모든 파서(porcelain v2, hunk/서브패치)는 **Rust 단위테스트**.
- 매 PR마다 기존 게이트(**cargo test · vitest · build · svelte-check**) green 유지.

---

## 10. Tier 2 / 3 백로그 (구조만 대비, 구현 보류)

**Tier 2 — 파워 기능**
- 인앱 3-way 충돌 해결 UI (riff diff 뷰 토대)
- 인터랙티브 rebase UI (drag reorder·squash·fixup·drop)
- Stash 관리 (save/pop/apply/drop + 미리보기)
- History 우클릭 액션 (reset/revert/cherry-pick/rebase-onto/tag)
- **Undo last operation** (모든 명령 실행 전 상태 스냅샷)
- line 단위 staging (Phase 1.4와 동일 배관, 서브패치 빌더만 확장)

**Tier 3 — 차별화 쇼케이스**
- Changelists (Perforce식 named 버킷)
- WIP 노드 (GitKraken식 그래프 맨 위 미커밋 노드)
- File 타임랩스/히스토리 슬라이더 (blame+history 결합)
- Drag-and-drop 브랜치 머지/리베이스
- Command palette / 키보드 구동
- 이미지/바이너리 diff (uasset 프리뷰는 이미 보유 — 우위)

---

## 11. 안전 정책 (전역 지침 준수)

- 파괴적 git(`push --force`, `reset --hard`, `checkout .` 등)은 **명시 요청/확인 없이는 실행 금지**. force-push는 `--force-with-lease`만 + 액션별 확인 다이얼로그.
- hook 우회(`--no-verify`)·서명 우회 **금지**.
- 커밋/푸시는 사용자가 명시적으로 트리거할 때만 (자동 커밋 없음).
