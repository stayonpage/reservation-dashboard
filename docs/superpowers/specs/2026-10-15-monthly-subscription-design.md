# 월간구독 관리 설계 (2026-10-15)

## 목적
아임웹 "월간구독N개월 신청" 입력폼 응답을 앱이 자동 수집해, 숙박 예약과 별도 카테고리로
입금확인·발송 이력·종료를 관리하고 통계 매출에 반영한다.

## 확정된 결정
- 상품: 4개월 100,000원 / 8개월 200,000원 (고정, 기간으로 금액 자동 결정).
- 상태: `pending`(입금대기) → `confirmed`(확정, 입금확인) → `ended`(종료). 확정 메일은 없다
  (입력폼에 이메일 칸이 없고 알림은 관리자에게만 간다). 고객 안내는 앱 밖 수동.
- 시작달: 신청 다음 달 자동 입력, 마치는 달 = 시작달 + (기간−1)개월 자동 계산. 둘 다 수정 가능.
- 통계 매출: **입금확인일이 속한 달**에 전액 귀속. 입금대기·취소 제외.
- 테스트 신청 2건(김벼리 2026-10-15, 김인식 2026-10-13)은 수집 제외·삭제.
- 종료 체크 시 목록 맨 뒤로. 정렬: pending → confirmed → ended, 같은 상태 내 접수 최신순.

## 데이터 (`supabase/migrations/0029_subscriptions.sql`)
`subscriptions`: id, name, phone, address, address_detail, plan_months(4|8), amount,
status(pending|confirmed|ended), start_month('YYYY-MM'), end_month, applied_at, confirmed_at,
ended_at, notes, source_external_id(unique, 메일 Message-ID), created_at.
`subscription_shipments`: id, subscription_id(fk, cascade), month('YYYY-MM'), memo,
unique(subscription_id, month) — 달별 책·특산물 기록.
RLS: `authenticated using (true)` (기존 예약과 동일). realtime 구독 대상에 추가.
RPC(전부 security invoker — 0003 방식, definer 아님): `confirm_subscription(id)`,
`unconfirm_subscription(id)`, `end_subscription(id, ended)`. 수집(insert)은 RPC 없이
service_role 클라이언트의 `upsert ... on conflict (source_external_id) do nothing`.

## 수집
- `lib/parsers/subscription-email.ts`: 제목 `월간구독(\d+)개월 신청` 판별 + 본문 라벨(이름/연락처/주소/
  등록시각) 파싱. 상세주소는 주소 블록의 마지막 줄들을 합쳐 보관. 지원하지 않는 개월 수면 null.
- `pollGmailImwebInbox`에서 제목이 구독이면 `handleSubscription`으로 분기(예약 파서로 안 보냄 →
  parse_failed 소음 제거). 멱등/재시도는 `ingest_log` 방식 그대로(parsed 일 때만 duplicate).
  source 는 기존 `imweb_email` 을 재사용하고 external_id 에 `subscription:` 접두어를 붙인다
  (enum 추가 불필요, 과거에 parse_failed 로 남은 같은 메일 행과도 충돌하지 않음).
- 수동 추가 폼: 이름·연락처·주소·4/8개월·시작달.
- 첫 배포 시 테스트 2건은 external_id 목록으로 `ingest_log`만 `parsed`로 막아 수집 제외.

## 화면
- `components/SubscriptionList.tsx`(신규): 카드 = 이름·연락처·주소·"시작달 ~ 마치는 달"·금액·상태 배지.
  펼치면 시작~마치는 달 각각 메모 입력(저장 시 `subscription_shipments` upsert), 일반 메모,
  입금확인/되돌리기, 종료 체크(확정 상태에서만), 삭제.
- 순수 함수 `lib/subscription.ts`: `planAmount`, `defaultStartMonth`, `endMonthOf`, `sortSubscriptions`.
- 헤더에 "구독 입금대기 N" 배지. `DashboardRealtime`에 구독 상태·realtime·`syncAll` 재조회 포함.

## 통계
- `lib/stats.ts`에 `computeSubscriptionStats(subs, range)` 추가(순수 함수):
  신규 입금확인 건수, 매출(= `confirmed_at`(KST 날짜)이 range 안인 confirmed·ended 합), 활성 구독자 수.
  `computeStats` 기존 결과는 변경하지 않고, `Statistics.tsx`에 "월간구독" 카드 + 총합계(숙박+구독, 각각 병기).

## 테스트
vitest: 이메일 파서(4/8개월, 상세주소, 다른 제목 null), subscription.ts(금액·월 계산·연도 넘김·정렬),
통계(월 경계, KST), handleSubscription 멱등/재시도. `verify-0029.sql`(DO 블록+raise).
게이트: `npx tsc --noEmit`, `TZ=UTC npx vitest run`, `npm run build`.

## 범위 밖
고객 대상 메일/문자 발송, 월별 균등 분할 매출, 구독 갱신 자동화.
