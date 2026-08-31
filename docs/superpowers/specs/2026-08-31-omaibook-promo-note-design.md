# 설계 — 오마이북 상품권 프로모션 자동 비고 기입

작성 2026-08-31. 배포 목표: **9월 1일 전** (프로모션 신청 시작일).

## 배경

스테이폴리오에 직원추천으로 신청한 두 프로모션. 대상 예약이 들어오면 대시보드
비고란(`reservations.notes`)에 안내 문구를 자동으로 남겨 직원이 상품권 증정 대상임을
바로 알 수 있게 한다.

- **직원추천 스테이 프로모션**: 확정메일 도착이 9/1~9/30, 체크인 11/30까지, 오마이북 3만원 상품권.
  단 체크인 날짜가 토요일이거나 공휴일 바로 전날이면 제외.
- **웰니스 프로모션**: 확정메일 도착이 9/14~10/18, 체크인 11/30까지, 객실이 page26 또는 page452,
  오마이북 3만원 상품권. 요일·공휴일 제외 없음.
- 둘 다 해당해도 문구는 한 번만. 문구는 통일: `오마이북 3만원 상품권 증정`.

## 범위

- **채널**: 스테이폴리오만.
- **시점**: 수신(ingest) 시점에 판정. 오늘이 8/31이라 소급 대상 없음 — 9/1 전 배포로 충분.
- DB 마이그레이션 없음. `ingest_reservation` 시그니처/본문 불변.

## 구성 요소

### 1. `lib/promo.ts` (신규) — 순수 판정 + 상수

```ts
export const OMAIBOOK_PROMO_NOTE = '오마이북 3만원 상품권 증정';

// 2026년 9~11월 한국 공휴일 (대체공휴일 포함). 프로모션 범위 밖은 불필요.
// 추석 연휴 9/24(목)·9/25(금)·9/26(토) + 대체 9/28(월),
// 개천절 10/3(토) + 대체 10/5(월), 한글날 10/9(금). 11월 공휴일 없음.
export const PROMO_HOLIDAYS_2026 = new Set([
  '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28',
  '2026-10-03', '2026-10-05', '2026-10-09',
]);

export function omaibookPromoEligible(input: {
  channel: string;
  roomName: string | null;
  checkIn: string;          // 'YYYY-MM-DD'
  cancelled: boolean;
  confirmedMailAt: Date;     // 스테이폴리오 확정메일 Date 헤더
}): boolean;

// 비고 이어붙이기(순수) — 재기입 방지 포함.
export function appendPromoNote(existing: string | null): string | null;
//   existing 이 이미 문구 포함 → null (변경 없음)
//   existing 비어있음 → OMAIBOOK_PROMO_NOTE
//   그 외 → `${existing}\n${OMAIBOOK_PROMO_NOTE}`
```

**`omaibookPromoEligible` 로직**

1. `channel !== 'stayfolio'` 또는 `cancelled` → `false`
2. `checkIn > '2026-11-30'` → `false`
3. `applyDate = kstDateString(confirmedMailAt)` (KST 'YYYY-MM-DD')
4. **웰니스**: `applyDate` in `['2026-09-14','2026-10-18']` 범위 그리고
   `roomCodeOf(roomName)` in `{'page26','page452'}` → `true`
5. **직원추천**: `applyDate` in `['2026-09-01','2026-09-30']` 범위 그리고
   `!isSaturday(checkIn)` 그리고 `!PROMO_HOLIDAYS_2026.has(nextDay(checkIn))` → `true`
6. 그 외 → `false`

**헬퍼**
- `kstDateString(d: Date)`: `new Date(d.getTime() + 9*3600_000).toISOString().slice(0,10)`. `lib/format.ts` 의 `kstNow` 패턴과 일치 — 거기 추가하거나 promo.ts 내부.
- `nextDay(iso)`: `new Date(iso + 'T00:00:00Z')` +1일 → `slice(0,10)`.
- `isSaturday(iso)`: `new Date(iso + 'T00:00:00Z').getUTCDay() === 6`.
- `roomCodeOf`: 기존 `lib/rooms.ts` (테스트됨). 스테이폴리오 `room_name` 은
  `'page26 - 시가 내려앉는 순간'` 형태라 코드 추출 필요.

### 2. `lib/ingest.ts` 수정

- `handleIncoming` 인자에 `receivedAt?: Date` 추가.
- `ingest_reservation` 성공(`status: 'parsed'`) 직후, 다음이면 비고 기입:
  ```ts
  if (omaibookPromoEligible({
        channel: parsed.channel, roomName: parsed.room_name,
        checkIn: parsed.check_in, cancelled: parsed.cancelled,
        confirmedMailAt: receivedAt ?? new Date(),
      })) {
    const { data: cur } = await supabase
      .from('reservations').select('notes').eq('id', reservationId).single();
    const next = appendPromoNote(cur?.notes ?? null);
    if (next !== null) {
      await supabase.from('reservations').update({ notes: next }).eq('id', reservationId);
    }
  }
  ```
- 실패해도 ingest 결과에는 영향 없음(best-effort, 에러 로깅). 상품권 안내 누락이
  예약 수신 자체를 실패시키면 안 된다.

### 3. `lib/mail/poll-gmail.ts` 수정

`handleIncoming({ ... })` 호출에 `receivedAt: parsedMail.date` 추가. (`parsedMail` 은 이미 `simpleParser` 결과)

## 데이터 흐름

```
Gmail(스테이폴리오 확정메일) → poll-gmail: simpleParser → handleIncoming(receivedAt=parsedMail.date)
  → ingest_log 멱등 기록 (중복이면 여기서 종료)
  → parseStayfolioEmailWithRealId
  → rpc ingest_reservation → reservationId
  → omaibookPromoEligible? → notes 조회 → appendPromoNote → update reservations.notes
```

## 멱등성

- 같은 메일 재폴링: `ingest_log` unique(source, external_id) 에서 `duplicate` 반환 →
  프로모션 로직 자체가 재실행 안 됨.
- 같은 예약의 다른 메일(재확정 등, 다른 UID): `handleIncoming` 재실행되나
  `appendPromoNote` 가 기존 `notes` 에 문구가 있으면 `null` 반환 → 재기입 안 됨.

## 에러 처리

- 프로모션 판정/기입 실패 → `console.error` 후 삼킴. `IngestResult` 는 `parsed` 유지.
- `roomCodeOf` 가 `null`(방 매칭 실패) → 웰니스 대상 아님으로 처리(보수적).

## 테스트

`lib/promo.test.ts` — `omaibookPromoEligible` / `appendPromoNote` 순수 함수.

| 케이스 | 기대 |
|---|---|
| 직원추천: 메일 9/10, 체크인 평일 11/10(화), page8 | true |
| 직원추천: 체크인 토요일 11/7 | false |
| 직원추천: 체크인 10/8(목) — 다음날 한글날 10/9 | false |
| 직원추천: 체크인 9/27(일) — 다음날 대체공휴일 9/28 | false |
| 직원추천: 메일 8/31 | false |
| 직원추천: 메일 10/1 | false |
| 웰니스: 메일 9/20, page26, 체크인 토요일 11/7 | true (요일 무관) |
| 웰니스: 메일 9/20, page8 | false |
| 웰니스: 메일 10/19 | false |
| 겹침: 메일 9/20, page452, 체크인 평일 | true (한 번) |
| 체크인 12/1 | false |
| channel=naver | false |
| cancelled=true | false |
| `appendPromoNote(null)` | 문구 |
| `appendPromoNote('직원 메모')` | `'직원 메모\n오마이북 3만원 상품권 증정'` |
| `appendPromoNote('...오마이북 3만원 상품권 증정...')` | null |

## 안 하는 것 (한계)

- 판정은 수신 시점 고정. 이후 예약 변경 큐로 체크인이 토요일/공휴일 전날로 바뀌어도
  문구 재평가·철회 안 함.
- 공휴일 목록은 2026년 9~11월 하드코딩. 프로모션 연장 시 `PROMO_HOLIDAYS_2026` 갱신 필요.
- "확정메일 도착 시각" = 메일 `Date` 헤더(스테이폴리오 발신 시각). 폴링 지연(≤5분)과
  무관하게 발신 시각 기준.
