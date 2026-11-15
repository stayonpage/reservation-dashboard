# 네이버 날짜 변경 — 직원 수동 접수 + 이중예약 경고 강화 (설계)

작성일: 2026-11-15 · 상태: 승인 대기

## 배경 / 문제

2026-11-14 은*은(page 8) 건. 손님이 네이버에서 11/20 → 12/18 로 날짜를 바꿨지만 대시보드는 11/20 그대로였고,
그 날짜에 다른 손님(최*연)이 들어와 이중예약이 됐다.

- 네이버는 예약 **변경**에 대해 대시보드가 읽는 메일함으로 메일을 보내지 않는다(접수·확정·취소 메일만 옴, 10/24 이후 129통 확인).
- 변경 알림은 **스마트플레이스 앱 푸시**로만 온다 → 서버가 자동 수집할 방법이 없다(네이버 예약은 외부 공개 API 없음).
- 따라서 "직원이 푸시를 보고 대시보드에 알려주는" 경로를 최대한 쉽게 만들고, 놓쳐도 시스템이 잡게 한다.

## 범위

**포함**
1. 예약 카드의 **"날짜 변경 접수"** 버튼 — 새 체크인/체크아웃만 입력하면 즉시 반영.
2. **이중예약 경고 강화** — 같은 방·같은 채널(네이버끼리) 겹침이면 "이 예약 날짜 변경" 선택지 추가.

**제외 (YAGNI, 필요해지면 후속)**
- "변경 대기 (11/20 → 12/18)" 상태 표시.
- 네이버 자동 수집(푸시/스크래핑).
- 객실·옵션 변경 접수(날짜만).

## 설계

### 1) DB: RPC `staff_change_dates(p_reservation_id uuid, p_new_check_in date, p_new_check_out date)`

기존 큐 v2 인프라를 재사용한다(새 로직을 만들지 않는다).

1. 예약 조회. 없으면 에러. `p_new_check_out <= p_new_check_in` 이면 에러. 날짜가 현재와 같으면 에러.
2. 예약 상태가 `cancelled` 이면 `kind='uncancel'`, 아니면 `kind='change'` 로 `reservation_changes` 에 pending 행 삽입
   (prev_* = 현재 예약값, new_* = 현재값 + 새 날짜; payment_method/status 는 현재값 유지).
   이미 열린 pending 행이 있으면(유니크 인덱스) 그 행의 new_check_in/out 를 갱신해 재사용.
3. 같은 트랜잭션에서 `confirm_reservation_change` / `confirm_uncancel_review` 호출 →
   예약 갱신, 옛 날짜 unblock·새 날짜 block 태스크 생성, prev_check_in/out 기록, 이벤트(`source: staff_change`) 남김.
4. 입금확인 초기화는 기존 RPC 동작 그대로(입금 대기 상태로 복귀 → 직원이 재확인).

권한: `security invoker`, `grant execute ... to authenticated` (기존 RPC 와 동일).
마이그레이션: `0032_staff_change_dates.sql`. **앱 배포 전에 먼저 적용**(없는 RPC 호출 시 버튼만 실패, 대시보드 렌더에는 영향 없음).

### 2) 서버 액션 `changeReservationDates(reservationId, checkIn, checkOut)` (`lib/actions.ts`)

RPC 호출 → 오류는 `{ error }` 반환, 성공 시 `revalidatePath('/')` + 기존 `notifyTodayPageAfterChange` 와 같은 후처리.

### 3) UI

- 예약 카드: "날짜 변경" 버튼 → 작은 폼(새 체크인, 새 체크아웃, 기본값=현재 날짜, 박수 표시) → 확인 창에
  "11/20~11/21 → 12/18~12/19 로 변경하고 다른 채널 막기/풀기 작업을 만듭니다" 문구.
- `DoubleBookingAlert`: 겹치는 두 예약이 **같은 채널(네이버)** 이면 각 행에 "날짜 변경" 버튼 추가
  (같은 폼 재사용). 채널이 다르면(교차 채널 이중예약) 기존 "이 예약 취소"만 유지.
- 체크아웃 기본값: 기존 박수 유지(체크인 + 기존 박수).

### 4) 오류 처리

- RPC 실패 → 폼 아래 오류 메시지, 데이터 변경 없음(트랜잭션).
- 두 직원 동시 조작 → 기존 RPC 의 원자적 claim 으로 한쪽만 성공.
- 새 날짜가 다른 예약과 또 겹치면 변경은 허용하되 변경 후 이중예약 경고가 즉시 뜬다(차단하지 않음 — 현장 판단 우선).

## 테스트 (TDD, vitest)

- `lib/actions` 단위: 성공/오류 전달, 날짜 검증.
- `findRoomConflicts` 확장 헬퍼(같은 채널 겹침 판별) 단위 테스트.
- `DoubleBookingAlert`: 같은 채널이면 "날짜 변경" 버튼 노출, 다른 채널이면 미노출.
- RPC 는 마이그레이션 적용 후 실DB 에서 스모크(은*은 케이스 재현: 취소된 예약 → uncancel 경로, 정상 예약 → change 경로).

게이트: `tsc --noEmit`, `vitest run`, `npm run build` → 브랜치 + PR, 머지는 사용자 확인 후.

## 미결정

없음. (날짜만 변경, 입금확인 초기화는 기존 동작 유지.)
