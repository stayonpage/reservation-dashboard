# 인수인계 — 예약 확인 큐 v2 (새 세션에서 이어서 진행)

작성 2026-08-31. 이 문서만 읽으면 이어서 진행 가능.

## 업데이트 2026-08-31 (2차 세션)

- **1~2단계 DB 검증 통과.** Supabase 브랜칭이 Pro 전용이라, `scripts/verify-0023-standalone.sql`
  (0023 전체 + 시나리오 22개를 하나의 `begin … rollback` DO 블록으로 감싼 자동생성본)을
  운영 프로젝트 SQL Editor 에서 실행 → `ALL 67 CHECKS PASSED — 0023 OK`. 전부 롤백돼 운영 스키마 무변경.
  → 0023 이 클린 적용되고 RPC 시나리오 assert 67개 전부 통과함을 확인.
- 로컬 게이트 재확인: `TZ=UTC npx vitest run` 135/135 · `tsc --noEmit` 0 · `npm run build` OK.
- **남은 것: 4단계(앱 스모크) + 5단계(배포).** 5단계 순서 반드시 지킬 것 — 0023 **실제 커밋 적용**을
  앱 배포/머지보다 먼저.
- SQL Editor 팁: 멀티스테이트먼트 실행 시 **마지막 SELECT 결과만** 보임. 여러 assert 는 DO 블록+raise 로
  모아야 함. `create temp table … on commit drop` 은 에디터가 문장 사이에서 드롭시킴 → `on commit drop` 빼기.

## 현재 상태

- **브랜치:** `feat/reservation-change-review` @ `3bf9313` (merge-base `a7c90a1` 기준 29 커밋)
- **구현:** v1 + v2 전부 완료. 태스크별 리뷰 + opus 전체 리뷰 + 리뷰 수정까지 끝남.
- **로컬 게이트 통과:** `TZ=UTC npx vitest run` 135/135 · `npx tsc --noEmit` 0 · `npm run build` 성공
- **미검증:** DB. 이 개발 환경엔 `supabase` CLI / Docker / `psql` 없음. `.env.local` 은 **운영** 프로젝트(`kolhfqdmnpgviylsmccd`)를 가리킴 → 마이그레이션/시나리오를 여기서 못 돌림.
- **진행 방식 결정(사용자):** Supabase **SQL Editor 에서 직접** `0023` 적용 + `verify-0023.sql` 실행.

관련 문서:
- 설계: `docs/superpowers/specs/2026-08-28-reservation-change-review-design.md` (v1 본문 + "개정 v2" 절 §V2-0..§V2-10, 상충 시 v2 우선)
- 계획: `docs/superpowers/plans/2026-08-29-reservation-review-v2.md` (v2, 15 태스크)
- 진행 원장(git-ignored): `.superpowers/sdd/progress.md` — 태스크별 완료·커밋·미룬 Minor 전부 기록

## 무엇을 지었나 (요약)

`reservation_changes` 큐를 `kind`(change / cancel / uncancel)로 일반화. 예약 변경·취소·되살리기가
전부 이 큐로 들어오고, 직원이 대시보드에서 `[변경 확정]` / `[취소 확정]` / `[예약 되살리기]` /
`[기존 예약 유지]` 를 눌러야 반영된다. 스테이폴리오 ICS 누락 자동취소도 큐로 우회(오취소 사고 방지).
손님 요청사항(`guest_request`)을 파싱해 직원 메모(`notes`)와 분리 표시. 변경 트리거는 날짜·객실·옵션만.
위약금은 `lib/refund.ts` 순수함수 — 표시만, 실제 환불은 직원 수동.

전 기능이 **마이그레이션 한 파일** `supabase/migrations/0023_reservation_change_review.sql` (576줄).
어느 DB에도 적용된 적 없음.

## ▶ 다음에 할 일 (순서대로)

### 1. `0023` 을 비운영 DB(또는 운영 브랜치)에 적용

Supabase 대시보드 → SQL Editor → 새 쿼리 → 아래 파일 **전체** 붙여넣기 → Run:
```
supabase/migrations/0023_reservation_change_review.sql
```
로컬에서 클립보드로:
```bash
pbcopy < "/Users/byeolli/Claude/Projects/숙박통합사이트/supabase/migrations/0023_reservation_change_review.sql"
```
에러 없이 완료돼야 함. (내용: `reservation_changes` 테이블 + `reservations.prev_check_in/out`·`guest_request` 컬럼 +
`block_tasks` unique 제거 + `ingest_reservation` 재정의(구 오버로드 2개 drop 포함) + RPC 5개 +
`enqueue_ics_cancel_review`.)

### 2. `verify-0023.sql` 실행 → `check` 71줄 전부 `t` 확인

SQL Editor 새 쿼리 → 아래 전체 붙여넣기 → Run:
```
scripts/verify-0023.sql
```
```bash
pbcopy < "/Users/byeolli/Claude/Projects/숙박통합사이트/scripts/verify-0023.sql"
```
- `begin; ... rollback;` 로 감싸져 있어 **데이터 안 남김** — 운영에서 돌려도 안전.
- 결과 그리드에서 각 행 두 번째 컬럼(`check` 라벨 옆 boolean)이 전부 `t` 여야 함.
- `f` 가 하나라도 있으면 → 그 시나리오 라벨을 적어서 새 세션에 전달. `0023` 의 해당 함수 로직 수정 →
  SQL Editor 에서 그 함수만 `create or replace` 재적용 → verify 재실행.
- ⚠️ `auth.uid()` 가 SQL Editor 에선 로그인 유저 UUID 로 나옴(로컬 psql 이면 NULL). RPC 시나리오는
  `resolved_by` 에 그 UUID 가 찍혀도 정상 — assert 는 상태/카운트만 봄.

### 3. 제약명 확인

SQL Editor:
```sql
select conname from pg_constraint where conrelid = 'block_tasks'::regclass;
```
- `block_tasks_reservation_id_target_channel_key` → **없어야** 함
- `block_tasks_manual_or_reservation` → **남아야** 함

### 4. 앱을 브랜치로 띄우고 직원 세션으로 실전 검증

```bash
cd "/Users/byeolli/Claude/Projects/숙박통합사이트" && git checkout feat/reservation-change-review && npm run dev
```
(또는 `.claude/launch.json` 의 `sukbak-dashboard` 프리뷰.) `0023` 적용된 DB 를 가리키는 `.env.local` 이어야 함.

로그인 후 각 1회(가능하면 두 탭 동시클릭도):
- **변경 확정** — 예약 날짜/옵션이 새 값으로 바뀌고, "막아야 할 채널"에 새 날짜 "막아라" + 옛 날짜 "다시 열기"
- **취소 확정** — 예약 `취소` 로, 막았던 채널에 "다시 열기" 뜸
- **예약 되살리기** — 취소 예약이 확정/입금대기로 복구, 다른 채널 "막아라" 재생성
- **기존 예약 유지** — 큐에서만 사라지고 예약 그대로
- 대시보드 콘솔 에러 없음

### 5. 배포 & 머지

- **반드시 마이그레이션 먼저, 앱 배포 나중.** (순서 바뀌면 `getPendingReservationChanges` 가
  없는 테이블 조회 → 대시보드 500. 단, `42P01` 폴백을 넣어놔서 이제 빈 큐로 degrade 함 —
  그래도 순서는 지킬 것.)
- 위 1~4 통과 후 `feat/reservation-change-review` → `main` 머지.

## 머지 전 재량 판단 — 미룬 Minor (opus 리뷰)

`.superpowers/sdd/progress.md` 하단에 전체 목록. 요약:
- `confirm_uncancel_review` 가 `prev_check_in/out` 안 채움 → 되살린 예약에 "이전 …에서 변경" 줄 안 뜸
- `security definer` 함수에 `set search_path` 없음 (레포 기존 관행, Supabase 린터가 `enqueue_ics_cancel_review` 플래그할 것)
- `ReservationChangeQueue` 에 `todayISO` prop 안 내려줌 → KST 자정 근처 SSR/hydration 위약금 텍스트 불일치 가능
- `verify-0023.sql` 커버 공백: `confirm_uncancel_review` 게스트하우스 제외, `deposit_confirmed_*` 클리어, uncancel upsert 재전송, 두 신규 RPC 의 wrong-kind no-op
- `poll-naver` 가 UID 오름차순(=도착순) 처리라 접수→취소 순서 보장됨 — 그 블록에 불변식 주석 달면 좋음

이 중 하나라도 지금 처리하려면 새 세션에서 "미룬 Minor 중 X 처리해줘" 로 요청.

## 진행 중 사고 대응 스크립트 (별개, 참고용)

`scripts/fix-gowongyeom-20260829.mjs` — 2026-08-29 스테이폴리오 오취소/유령중복 정정(이미 실행됨).
시나리오 A/B + dry-run + 멱등 가드. 비슷한 재발 시 ID 바꿔 재사용 가능. (커밋 안 됨, git-ignored 아님 —
필요하면 `main` 에 별도 커밋.)

## 새 세션 시작 문구 예시

> 숙박통합사이트 `feat/reservation-change-review` 브랜치 이어서 진행. `docs/superpowers/HANDOFF-reservation-review-v2.md` 읽고, [1단계 완료했고 verify 결과 이렇다 / 2단계부터 봐줘] …
