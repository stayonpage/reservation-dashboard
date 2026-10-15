# 월간구독 관리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 아임웹 "월간구독N개월 신청" 메일을 자동 수집해 별도 카테고리로 입금확인·월별 발송 메모·종료를 관리하고, 입금확인 월 기준으로 통계 매출에 반영한다.

**Architecture:** 새 테이블 `subscriptions` / `subscription_shipments`(예약과 분리). 기존 `pollGmailImwebInbox`가 제목으로 구독 메일을 분기해 `handleSubscriptionIncoming`(ingest_log 멱등·재시도 방식 그대로)으로 보낸다. 화면은 `SubscriptionList` 섹션 + 통계 카드 하나. 계산은 순수 함수(`lib/subscription.ts`, `lib/subscription-stats.ts`)로 분리해 테스트한다.

**Tech Stack:** Next.js 15 App Router, Supabase(PostgREST/RLS/realtime), vitest(`TZ=UTC npx vitest run`), imapflow/mailparser/html-to-text.

**Spec:** `docs/superpowers/specs/2026-10-15-monthly-subscription-design.md`

## Global Constraints

- 상품/금액 고정: 4개월 100,000원, 8개월 200,000원. 그 외 개월 수는 파싱 실패(null)로 처리하고 금액을 추측하지 않는다.
- 상태: `pending`(입금대기) → `confirmed`(확정) → `ended`(종료). 정렬: pending → confirmed → ended, 같은 상태 내 접수(`applied_at`) 최신순.
- 시작달 기본값 = 신청일(KST) 다음 달, 마치는 달 = 시작달 + (개월수 − 1). 월 형식은 `'YYYY-MM'`.
- 통계 매출은 **입금확인일(`confirmed_at`, KST 날짜)이 속한 기간**에 전액 귀속. 입금대기·되돌린 건 제외.
- 날짜 문자열은 UTC 파싱(`T00:00:00Z`)+`getUTC*`만 쓴다(lib/format.ts 주석의 2026-07 OOM 사고 규칙). KST 변환은 `+9h` 후 `toISOString()`.
- 주석·UI 문구는 한국어, 기존 코드 밀도에 맞춘다. DB 함수는 security invoker(0003 방식).
- 개인 메일함 보호: 폴러의 발신자 제한(`misomamy@naver.com`)·"seen으로 거르지 않음" 규칙은 건드리지 않는다.
- 게이트: `npx tsc --noEmit; echo $?`(파이프 금지) → `TZ=UTC npx vitest run` → `npm run build`.

## Review Focus

- 4/8 외 개월 수("월간구독6개월") 메일 → 금액을 지어내지 말고 `parse_failed`로 남긴다. (Task 2 테스트)
- 같은 메일 재수신·폴링 재시도 → 중복 등록 없음, 이전 시도가 실패했으면 재시도됨. (Task 4 테스트)
- 12월 신청 → 시작달이 다음 해 1월, 마치는 달도 연도를 넘김. (Task 1 테스트)
- KST 자정 경계 입금확인(UTC 15:00 직후) → KST 기준 다음 날/달에 매출 귀속. (Task 5 테스트)
- 상세주소·우편번호·연락처가 없는 신청 → 있는 값만 저장하고 죽지 않음. (Task 2 테스트)
- 입금확인/종료를 되돌렸을 때 통계 매출·활성 인원에서 정확히 빠짐. (Task 5 테스트)
- 구독 메일 분기가 일반 아임웹 예약 메일 경로를 깨지 않음(회귀). (Task 4 테스트)

---

## File Structure

| 파일 | 책임 |
|---|---|
| `lib/subscription.ts` (신규) | 금액·월 계산·정렬·라벨 순수 함수, 수동입력 타입 |
| `lib/parsers/subscription-email.ts` (신규) | 구독 메일 제목 판별 + 본문 파싱 |
| `lib/ingest-subscription.ts` (신규) | ingest_log 멱등 + subscriptions upsert |
| `lib/subscription-stats.ts` (신규) | 구독 통계 순수 함수 |
| `lib/subscription-actions.ts` (신규) | 직원용 서버 액션 |
| `components/SubscriptionList.tsx` (신규) | 구독 섹션 UI |
| `supabase/migrations/0029_subscriptions.sql` (신규) | 테이블·RLS·realtime·RPC |
| `scripts/verify-0029.sql`, `scripts/rollback-0029.sql` (신규) | 검증/롤백 |
| `lib/db-types.ts`, `lib/queries.ts`, `lib/mail/poll-gmail.ts`, `components/DashboardRealtime.tsx`, `components/Statistics.tsx`, `app/page.tsx`, `app/globals.css` (수정) | 연결 |

---

### Task 1: 구독 순수 함수 (`lib/subscription.ts`)

**Files:**
- Create: `lib/subscription.ts`
- Test: `lib/subscription.test.ts`

**Interfaces:**
- Consumes: (없음)
- Produces:
  - `type PlanMonths = 4 | 8`
  - `PLAN_AMOUNT: Record<PlanMonths, number>`
  - `isPlanMonths(n: number): n is PlanMonths`
  - `planAmount(plan: PlanMonths): number`
  - `addMonths(ym: string, n: number): string` ('YYYY-MM')
  - `endMonthOf(startMonth: string, plan: PlanMonths): string`
  - `kstDateOf(iso: string): string` ('YYYY-MM-DD', KST)
  - `defaultStartMonth(appliedAtISO: string): string`
  - `monthsBetween(start: string, end: string): string[]` (양끝 포함)
  - `sortSubscriptions<T extends { status: 'pending'|'confirmed'|'ended'; applied_at: string }>(subs: readonly T[]): T[]`
  - `SUBSCRIPTION_STATUS_LABEL: Record<'pending'|'confirmed'|'ended', string>`
  - `interface ManualSubscriptionInput { name: string; phone: string; address: string; addressDetail: string; planMonths: PlanMonths; startMonth: string }`

- [ ] **Step 1: 실패하는 테스트 작성** — `lib/subscription.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  isPlanMonths,
  planAmount,
  addMonths,
  endMonthOf,
  kstDateOf,
  defaultStartMonth,
  monthsBetween,
  sortSubscriptions,
} from './subscription';

describe('planAmount / isPlanMonths', () => {
  it('4개월 10만, 8개월 20만', () => {
    expect(planAmount(4)).toBe(100000);
    expect(planAmount(8)).toBe(200000);
  });
  it('4·8만 유효', () => {
    expect(isPlanMonths(4)).toBe(true);
    expect(isPlanMonths(8)).toBe(true);
    expect(isPlanMonths(6)).toBe(false);
    expect(isPlanMonths(0)).toBe(false);
  });
});

describe('addMonths / endMonthOf', () => {
  it('연도를 넘긴다', () => {
    expect(addMonths('2026-10', 1)).toBe('2026-11');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
  it('마치는 달 = 시작달 + (개월수-1)', () => {
    expect(endMonthOf('2026-11', 4)).toBe('2027-02');
    expect(endMonthOf('2026-11', 8)).toBe('2027-06');
    expect(endMonthOf('2026-01', 4)).toBe('2026-04');
  });
});

describe('kstDateOf / defaultStartMonth', () => {
  it('UTC 15:00 이후는 KST 다음 날', () => {
    expect(kstDateOf('2026-10-31T15:00:00Z')).toBe('2026-11-01');
    expect(kstDateOf('2026-10-31T14:59:59Z')).toBe('2026-10-31');
  });
  it('시작달 = 신청일(KST) 다음 달', () => {
    expect(defaultStartMonth('2026-10-14T23:53:08Z')).toBe('2026-11'); // KST 10/15
    expect(defaultStartMonth('2026-12-15T00:00:00Z')).toBe('2027-01'); // 연말 → 다음 해
  });
  it('월말 KST 자정 직후 신청은 그 다음 달 기준', () => {
    expect(defaultStartMonth('2026-12-31T15:00:00Z')).toBe('2027-02'); // KST 2027-01-01
  });
});

describe('monthsBetween', () => {
  it('양끝 포함, 연도 넘김', () => {
    expect(monthsBetween('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
  it('시작=끝이면 1개, 끝<시작이면 빈 배열', () => {
    expect(monthsBetween('2026-11', '2026-11')).toEqual(['2026-11']);
    expect(monthsBetween('2026-12', '2026-11')).toEqual([]);
  });
});

describe('sortSubscriptions', () => {
  type S = { id: string; status: 'pending' | 'confirmed' | 'ended'; applied_at: string };
  const s = (id: string, status: S['status'], applied_at: string): S => ({ id, status, applied_at });

  it('pending → confirmed → ended, 같은 상태 안에서는 접수 최신순', () => {
    const rows = [
      s('ended-new', 'ended', '2026-10-10T00:00:00Z'),
      s('conf-old', 'confirmed', '2026-09-01T00:00:00Z'),
      s('pend-old', 'pending', '2026-10-01T00:00:00Z'),
      s('conf-new', 'confirmed', '2026-10-05T00:00:00Z'),
      s('pend-new', 'pending', '2026-10-12T00:00:00Z'),
    ];
    expect(sortSubscriptions(rows).map((x) => x.id)).toEqual([
      'pend-new', 'pend-old', 'conf-new', 'conf-old', 'ended-new',
    ]);
  });
  it('입력 배열을 변경하지 않는다', () => {
    const rows = [s('a', 'ended', '2026-10-01T00:00:00Z'), s('b', 'pending', '2026-10-02T00:00:00Z')];
    const snap = rows.map((x) => x.id);
    sortSubscriptions(rows);
    expect(rows.map((x) => x.id)).toEqual(snap);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd /Users/byeolli/Claude/Projects/숙박통합사이트 && TZ=UTC npx vitest run lib/subscription.test.ts` / Expected: FAIL (`./subscription` 없음)

- [ ] **Step 3: 구현** — `lib/subscription.ts`

```ts
// 월간구독 순수 규칙(금액·월 계산·정렬). 화면/수집/통계가 모두 이걸 쓴다.
//
//  · 상품은 4개월 10만원 / 8개월 20만원 고정. 그 외 개월 수는 지원하지 않는다(파서가 null).
//  · 월은 'YYYY-MM' 문자열. 날짜 계산은 정수 연산만 쓰고 Date 는 KST 변환에만 쓴다
//    (lib/format.ts 의 2026-07 OOM 사고 주석 참고 — 로컬 게터 금지).

export type PlanMonths = 4 | 8;
export type SubscriptionStatusKey = 'pending' | 'confirmed' | 'ended';

export const PLAN_AMOUNT: Record<PlanMonths, number> = { 4: 100000, 8: 200000 };

export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatusKey, string> = {
  pending: '입금대기',
  confirmed: '확정',
  ended: '종료',
};

export interface ManualSubscriptionInput {
  name: string;
  phone: string;
  address: string;
  addressDetail: string;
  planMonths: PlanMonths;
  startMonth: string;
}

export function isPlanMonths(n: number): n is PlanMonths {
  return n === 4 || n === 8;
}

export function planAmount(plan: PlanMonths): number {
  return PLAN_AMOUNT[plan];
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function endMonthOf(startMonth: string, plan: PlanMonths): string {
  return addMonths(startMonth, plan - 1);
}

/** ISO 시각의 한국시간 날짜 'YYYY-MM-DD'. */
export function kstDateOf(iso: string): string {
  return new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 기본 시작달 = 신청일(KST) 다음 달. */
export function defaultStartMonth(appliedAtISO: string): string {
  return addMonths(kstDateOf(appliedAtISO).slice(0, 7), 1);
}

/** start~end 사이 모든 달(양끝 포함). 비정상 입력에도 무한루프 없도록 최대 120개월. */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end && out.length < 120) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

const STATUS_ORDER: Record<SubscriptionStatusKey, number> = { pending: 0, confirmed: 1, ended: 2 };

/** 입금대기 → 확정 → 종료, 같은 상태 안에서는 접수 최신순. 종료는 항상 맨 뒤. */
export function sortSubscriptions<T extends { status: SubscriptionStatusKey; applied_at: string }>(
  subs: readonly T[],
): T[] {
  return [...subs].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return Date.parse(b.applied_at) - Date.parse(a.applied_at);
  });
}
```

- [ ] **Step 4: 통과 확인** — Run: `TZ=UTC npx vitest run lib/subscription.test.ts` / Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add lib/subscription.ts lib/subscription.test.ts
git commit -m "feat: 월간구독 금액·월 계산·정렬 순수 함수

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 구독 메일 파서 (`lib/parsers/subscription-email.ts`)

**Files:**
- Create: `lib/parsers/subscription-email.ts`
- Test: `lib/parsers/subscription-email.test.ts`

**Interfaces:**
- Consumes: `isPlanMonths`, `PlanMonths` from `../subscription`
- Produces:
  - `isSubscriptionSubject(subject?: string | null): boolean`
  - `interface ParsedSubscription { name: string; phone: string | null; address: string | null; address_detail: string | null; plan_months: PlanMonths }`
  - `parseSubscriptionEmail(raw: string): ParsedSubscription | null` — `raw`는 `제목: <subject>\n<본문 텍스트>` 형식(폴러가 만든다).

- [ ] **Step 1: 실패하는 테스트 작성** — `lib/parsers/subscription-email.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { isSubscriptionSubject, parseSubscriptionEmail } from './subscription-email';

// 실메일(2026-10-15 도착, Gmail API 로 원문 HTML 조회 → html-to-text 변환) 그대로의 본문 형식.
// 이름·연락처만 가상값으로 치환. 라벨(이름/연락처/주소)은 각각 독립된 줄, 주소 값은 여러 줄,
// 주소 끝은 빈 줄로 구분된다.
const SUBJECT = '[스테이 온 페이지] 월간구독4개월 신청에 새 응답이 접수되었습니다.';
const BODY = `스테이 온 페이지 새 입력폼 응답이 접수되었습니다.

등록자비회원 등록위치월간구독4개월 신청 등록시각2026-10-15 08:52 응답
이름
홍길동
연락처
01012345678
주소
(38334)
경북 청도군 화양읍 동천3길 67 (교촌리)
오마이뷱

  

입력폼 관리하기 [http://stayonpage.com/admin/contents/form]

© 스테이 온 페이지

[https://mail.naver.com/readReceipt/notify/?img=abc.gif]`;

const raw = (subject: string, body = BODY) => `제목: ${subject}\n${body}`;

describe('isSubscriptionSubject', () => {
  it('월간구독N개월 제목만 true', () => {
    expect(isSubscriptionSubject(SUBJECT)).toBe(true);
    expect(isSubscriptionSubject('[스테이 온 페이지] 월간구독 8개월 신청에 새 응답이')).toBe(true);
    expect(isSubscriptionSubject('[스테이 온 페이지] 예약이 접수되어 입금 확인이 필요합니다.')).toBe(false);
    expect(isSubscriptionSubject(undefined)).toBe(false);
    expect(isSubscriptionSubject(null)).toBe(false);
  });
});

describe('parseSubscriptionEmail', () => {
  it('실메일 형식: 이름·연락처·주소(우편번호+도로명)·상세주소·4개월', () => {
    expect(parseSubscriptionEmail(raw(SUBJECT))).toEqual({
      name: '홍길동',
      phone: '01012345678',
      address: '(38334) 경북 청도군 화양읍 동천3길 67 (교촌리)',
      address_detail: '오마이뷱',
      plan_months: 4,
    });
  });

  it('8개월 제목이면 plan_months 8', () => {
    const r = parseSubscriptionEmail(raw('[스테이 온 페이지] 월간구독8개월 신청에 새 응답이 접수되었습니다.'));
    expect(r?.plan_months).toBe(8);
  });

  it('★ 4·8 이외 개월 수(6개월)는 금액을 추측하지 않고 null', () => {
    expect(parseSubscriptionEmail(raw('[스테이 온 페이지] 월간구독6개월 신청에 새 응답이 접수되었습니다.', BODY.replace('월간구독4개월', '월간구독6개월')))).toBeNull();
  });

  it('구독 메일이 아니면(예약 메일 등) null', () => {
    expect(parseSubscriptionEmail('제목: [스테이 온 페이지] 예약이 취소되었습니다.\n고객명 홍길동 예약번호 1')).toBeNull();
  });

  it('★ 상세주소 없음 — 우편번호+도로명만', () => {
    const body = BODY.replace('오마이뷱\n', '');
    const r = parseSubscriptionEmail(raw(SUBJECT, body));
    expect(r?.address).toBe('(38334) 경북 청도군 화양읍 동천3길 67 (교촌리)');
    expect(r?.address_detail).toBeNull();
  });

  it('★ 우편번호 없음 — 첫 줄이 주소, 나머지는 상세주소', () => {
    const body = BODY.replace('(38334)\n', '');
    const r = parseSubscriptionEmail(raw(SUBJECT, body));
    expect(r?.address).toBe('경북 청도군 화양읍 동천3길 67 (교촌리)');
    expect(r?.address_detail).toBe('오마이뷱');
  });

  it('상세주소가 여러 줄이면 공백으로 합친다', () => {
    const body = BODY.replace('오마이뷱', '101동\n202호');
    expect(parseSubscriptionEmail(raw(SUBJECT, body))?.address_detail).toBe('101동 202호');
  });

  it('★ 연락처 누락 — phone null, 나머지는 정상(죽지 않음)', () => {
    const body = BODY.replace('연락처\n01012345678\n', '');
    const r = parseSubscriptionEmail(raw(SUBJECT, body));
    expect(r?.phone).toBeNull();
    expect(r?.name).toBe('홍길동');
  });

  it('연락처의 하이픈·공백은 제거해 숫자만 저장', () => {
    const body = BODY.replace('01012345678', '010-1234 5678');
    expect(parseSubscriptionEmail(raw(SUBJECT, body))?.phone).toBe('01012345678');
  });

  it('이름이 없으면 null (parse_failed 로 가시화)', () => {
    const body = BODY.replace('이름\n홍길동\n', '');
    expect(parseSubscriptionEmail(raw(SUBJECT, body))).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `TZ=UTC npx vitest run lib/parsers/subscription-email.test.ts` / Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `lib/parsers/subscription-email.ts`

```ts
import { isPlanMonths, type PlanMonths } from '../subscription';

// 아임웹 입력폼 "월간구독N개월 신청" 알림 메일 파서.
// 발신: 사장님 네이버 릴레이(misomamy@naver.com) — 예약 알림과 같은 발신자. 제목은
// "[스테이 온 페이지] 월간구독4개월 신청에 새 응답이 접수되었습니다."
//
// 입력(raw)은 폴러가 만든 "제목: <subject>\n<html-to-text 본문>" 형식. 본문(2026-10-15 실메일):
//   등록자비회원 등록위치월간구독4개월 신청 등록시각2026-10-15 08:52 응답
//   이름 / 홍길동 / 연락처 / 01012345678 / 주소 / (38334) / 경북 청도군 … / 오마이뷱 / (빈 줄)
// 라벨(이름·연락처·주소)은 각자 한 줄, 값은 다음 줄(주소만 여러 줄, 빈 줄에서 끝).
// 개월 수는 제목(= 본문 "등록위치")의 "월간구독N개월" 에서 읽는다. 시작달은 메일에 없다.

const PLAN_RE = /월간구독\s*(\d+)\s*개월/;
const LABELS = new Set(['이름', '연락처', '주소']);
const ZIP_RE = /^\(\d{5}\)$/;

export interface ParsedSubscription {
  name: string;
  phone: string | null;
  address: string | null;
  address_detail: string | null;
  plan_months: PlanMonths;
}

export function isSubscriptionSubject(subject?: string | null): boolean {
  return !!subject && PLAN_RE.test(subject);
}

function valueAfter(lines: string[], label: string): string | null {
  const i = lines.indexOf(label);
  if (i === -1) return null;
  const v = lines[i + 1];
  if (!v || LABELS.has(v)) return null; // 값이 비어 다음 라벨이 바로 오는 경우
  return v;
}

export function parseSubscriptionEmail(raw: string): ParsedSubscription | null {
  const planMatch = raw.match(PLAN_RE);
  if (!planMatch) return null;
  const months = Number(planMatch[1]);
  if (!isPlanMonths(months)) return null; // 금액을 추측하지 않는다 — 파싱 실패로 가시화

  const lines = raw.split('\n').map((l) => l.trim());

  const name = valueAfter(lines, '이름');
  if (!name) return null;

  const phoneRaw = valueAfter(lines, '연락처');
  const phone = phoneRaw ? phoneRaw.replace(/\D/g, '') || null : null;

  const ai = lines.indexOf('주소');
  const addrLines: string[] = [];
  if (ai !== -1) {
    for (let j = ai + 1; j < lines.length && lines[j] !== ''; j++) addrLines.push(lines[j]);
  }

  let address: string | null = null;
  let addressDetail: string | null = null;
  if (addrLines.length > 0) {
    if (ZIP_RE.test(addrLines[0])) {
      address = addrLines.length > 1 ? `${addrLines[0]} ${addrLines[1]}` : addrLines[0];
      addressDetail = addrLines.slice(2).join(' ') || null;
    } else {
      address = addrLines[0];
      addressDetail = addrLines.slice(1).join(' ') || null;
    }
  }

  return { name, phone, address, address_detail: addressDetail, plan_months: months };
}
```

- [ ] **Step 4: 통과 확인** — Run: `TZ=UTC npx vitest run lib/parsers/subscription-email.test.ts` / Expected: PASS (10 tests)

- [ ] **Step 5: 커밋**

```bash
git add lib/parsers/subscription-email.ts lib/parsers/subscription-email.test.ts
git commit -m "feat: 월간구독 신청 메일 파서

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: DB 마이그레이션 + 타입 + 조회

**Files:**
- Create: `supabase/migrations/0029_subscriptions.sql`, `scripts/verify-0029.sql`, `scripts/rollback-0029.sql`
- Modify: `lib/db-types.ts` (파일 끝에 추가), `lib/queries.ts` (파일 끝에 추가)

**Interfaces:**
- Consumes: (없음)
- Produces (db-types):
  ```ts
  export type SubscriptionStatus = 'pending' | 'confirmed' | 'ended';
  export interface Subscription {
    id: string; name: string; phone: string | null; address: string | null; address_detail: string | null;
    plan_months: 4 | 8; amount: number; status: SubscriptionStatus;
    start_month: string; end_month: string; applied_at: string;
    confirmed_at: string | null; ended_at: string | null; notes: string | null; created_at: string;
  }
  export interface SubscriptionShipment { id: string; subscription_id: string; month: string; memo: string; updated_at: string }
  ```
- Produces (queries): `getSubscriptions(supabase): Promise<Subscription[]>`, `getSubscriptionShipments(supabase): Promise<SubscriptionShipment[]>` — 테이블 없음(42P01)이면 빈 배열(배포 순서 슬립 대비, getPendingReservationChanges 와 동일).
- Produces (DB RPC): `confirm_subscription(p_id uuid)`, `unconfirm_subscription(p_id uuid)`, `end_subscription(p_id uuid, p_ended boolean)` — 모두 `returns void`, security invoker.

- [ ] **Step 1: 마이그레이션 작성** — `supabase/migrations/0029_subscriptions.sql`

```sql
-- 월간구독(아임웹 입력폼 "월간구독N개월 신청") 관리. 예약(reservations)과 로직이 달라 별도 테이블.
-- 상품: 4개월 100,000원 / 8개월 200,000원 고정(금액은 수집 시 plan_months 로 결정해 저장).
-- 통계 매출은 confirmed_at(입금확인일) 기준으로 앱에서 집계한다.

create type subscription_status as enum ('pending', 'confirmed', 'ended');

create table subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  phone              text,
  address            text,
  address_detail     text,
  plan_months        smallint not null check (plan_months in (4, 8)),
  amount             integer not null check (amount >= 0),
  status             subscription_status not null default 'pending',
  start_month        text not null check (start_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  end_month          text not null check (end_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  applied_at         timestamptz not null default now(),
  confirmed_at       timestamptz,
  ended_at           timestamptz,
  notes              text,
  source_external_id text unique,           -- 메일 Message-ID(접두어 포함) — 재수신 중복 방지
  created_at         timestamptz not null default now(),
  check (end_month >= start_month)
);
create index subscriptions_status_applied_idx on subscriptions (status, applied_at desc);

-- 달별 발송 메모(어떤 책·특산물이 나갔는지)
create table subscription_shipments (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  month           text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  memo            text not null default '',
  updated_at      timestamptz not null default now(),
  unique (subscription_id, month)
);

alter table subscriptions enable row level security;
alter table subscription_shipments enable row level security;
create policy "authed full subscriptions"
  on subscriptions for all to authenticated using (true) with check (true);
create policy "authed full subscription_shipments"
  on subscription_shipments for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table subscriptions;
alter publication supabase_realtime add table subscription_shipments;

-- 입금확인: pending 만 confirmed 로(이미 처리된 건은 조용히 무시 — confirm_deposit 와 동일 규칙).
create or replace function confirm_subscription(p_id uuid)
returns void language plpgsql security invoker as $$
begin
  update subscriptions
     set status = 'confirmed', confirmed_at = now()
   where id = p_id and status = 'pending';
end $$;

-- 입금확인 되돌리기: confirmed 만 pending 으로. confirmed_at 을 비워 통계 매출에서 빠지게 한다.
create or replace function unconfirm_subscription(p_id uuid)
returns void language plpgsql security invoker as $$
begin
  update subscriptions
     set status = 'pending', confirmed_at = null
   where id = p_id and status = 'confirmed';
end $$;

-- 종료 체크(p_ended=true: confirmed → ended) / 해제(p_ended=false: ended → confirmed).
create or replace function end_subscription(p_id uuid, p_ended boolean)
returns void language plpgsql security invoker as $$
begin
  if p_ended then
    update subscriptions set status = 'ended', ended_at = now()
     where id = p_id and status = 'confirmed';
  else
    update subscriptions set status = 'confirmed', ended_at = null
     where id = p_id and status = 'ended';
  end if;
end $$;

grant execute on function confirm_subscription(uuid) to authenticated;
grant execute on function unconfirm_subscription(uuid) to authenticated;
grant execute on function end_subscription(uuid, boolean) to authenticated;
```

- [ ] **Step 2: 검증/롤백 SQL 작성** — `scripts/verify-0029.sql` (begin…rollback, 무변경, 성공 시 'ALL PASSED')

```sql
-- 0029 검증 — 0029 적용 후 실행. 테스트 행을 만들고 rollback 하므로 운영 데이터 무변경.
-- 성공 시 'ALL PASSED' 한 행, 실패 시 ERROR: FAIL: <라벨>.
begin;

do $$
declare
  v_id uuid;
  v_s subscriptions%rowtype;
begin
  insert into subscriptions (name, plan_months, amount, start_month, end_month)
  values ('검증용', 4, 100000, '2026-11', '2027-02') returning id into v_id;

  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'pending' then raise exception 'FAIL: 기본 상태 pending'; end if;

  perform confirm_subscription(v_id);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'confirmed' or v_s.confirmed_at is null then raise exception 'FAIL: 입금확인'; end if;

  perform end_subscription(v_id, true);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'ended' or v_s.ended_at is null then raise exception 'FAIL: 종료'; end if;

  perform end_subscription(v_id, false);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'confirmed' or v_s.ended_at is not null then raise exception 'FAIL: 종료 해제'; end if;

  perform unconfirm_subscription(v_id);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'pending' or v_s.confirmed_at is not null then raise exception 'FAIL: 입금확인 되돌리기'; end if;

  -- pending 에 종료 시도는 무시되어야 한다
  perform end_subscription(v_id, true);
  select * into v_s from subscriptions where id = v_id;
  if v_s.status <> 'pending' then raise exception 'FAIL: pending 은 종료 불가'; end if;

  begin
    insert into subscriptions (name, plan_months, amount, start_month, end_month)
    values ('잘못', 6, 1, '2026-11', '2027-04');
    raise exception 'FAIL: plan_months 6 이 허용됨';
  exception when check_violation then null; end;

  begin
    insert into subscriptions (name, plan_months, amount, start_month, end_month)
    values ('잘못', 4, 1, '2026-11', '2026-10');
    raise exception 'FAIL: end < start 가 허용됨';
  exception when check_violation then null; end;

  insert into subscription_shipments (subscription_id, month, memo) values (v_id, '2026-11', '책 A / 사과');
  begin
    insert into subscription_shipments (subscription_id, month, memo) values (v_id, '2026-11', '중복');
    raise exception 'FAIL: (구독, 월) 중복이 허용됨';
  exception when unique_violation then null; end;

  delete from subscriptions where id = v_id;
  if exists (select 1 from subscription_shipments where subscription_id = v_id) then
    raise exception 'FAIL: 구독 삭제 시 발송 메모 cascade';
  end if;
end $$;

select 'ALL PASSED' as result;
rollback;
```

`scripts/rollback-0029.sql`:

```sql
-- 0029 롤백(주의: 구독 데이터가 모두 사라진다).
drop function if exists end_subscription(uuid, boolean);
drop function if exists unconfirm_subscription(uuid);
drop function if exists confirm_subscription(uuid);
alter publication supabase_realtime drop table subscription_shipments;
alter publication supabase_realtime drop table subscriptions;
drop table if exists subscription_shipments;
drop table if exists subscriptions;
drop type if exists subscription_status;
```

- [ ] **Step 3: 타입 추가** — `lib/db-types.ts` 파일 끝에 append

```ts
export type SubscriptionStatus = 'pending' | 'confirmed' | 'ended';

// subscriptions(0029) 1:1 조회용 타입. 월은 'YYYY-MM'.
export interface Subscription {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  address_detail: string | null;
  plan_months: 4 | 8;
  amount: number;
  status: SubscriptionStatus;
  start_month: string;
  end_month: string;
  applied_at: string;
  confirmed_at: string | null;
  ended_at: string | null;
  notes: string | null;
  created_at: string;
}

// 달별 발송 메모(어떤 책·특산물이 나갔는지).
export interface SubscriptionShipment {
  id: string;
  subscription_id: string;
  month: string;
  memo: string;
  updated_at: string;
}
```

- [ ] **Step 4: 조회 함수 추가** — `lib/queries.ts` 상단 import 를 `import type { Reservation, BlockTask, ReservationChange, Subscription, SubscriptionShipment } from './db-types';` 로 바꾸고, 파일 끝에 append

```ts
// 월간구독 — 배포 순서 슬립(0029 미적용)으로 테이블이 없을 때(42P01) 대시보드 전체가 500 나지 않도록 빈 배열 폴백.
export async function getSubscriptions(supabase: SupabaseClient): Promise<Subscription[]> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select(
      'id,name,phone,address,address_detail,plan_months,amount,status,start_month,end_month,applied_at,confirmed_at,ended_at,notes,created_at',
    )
    .order('applied_at', { ascending: false });
  if (error) {
    if (error.code === '42P01') {
      console.warn('getSubscriptions: subscriptions 테이블 없음 — 빈 목록으로 폴백', error.message);
      return [];
    }
    throw error;
  }
  return (data ?? []) as unknown as Subscription[];
}

export async function getSubscriptionShipments(
  supabase: SupabaseClient,
): Promise<SubscriptionShipment[]> {
  const { data, error } = await supabase
    .from('subscription_shipments')
    .select('id,subscription_id,month,memo,updated_at');
  if (error) {
    if (error.code === '42P01') {
      console.warn('getSubscriptionShipments: 테이블 없음 — 빈 목록으로 폴백', error.message);
      return [];
    }
    throw error;
  }
  return (data ?? []) as unknown as SubscriptionShipment[];
}
```

- [ ] **Step 5: 타입 체크** — Run: `npx tsc --noEmit; echo $?` / Expected: `0`

- [ ] **Step 6: 커밋** (마이그레이션 적용은 Task 7 에서 사용자와 함께 — 운영 DB 변경이므로 여기선 파일만)

```bash
git add supabase/migrations/0029_subscriptions.sql scripts/verify-0029.sql scripts/rollback-0029.sql lib/db-types.ts lib/queries.ts
git commit -m "feat: 월간구독 테이블·RPC 마이그레이션(0029)과 조회 타입

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 수집 — `handleSubscriptionIncoming` + 폴러 분기

**Files:**
- Create: `lib/ingest-subscription.ts`, `lib/ingest-subscription.test.ts`
- Modify: `lib/mail/poll-gmail.ts` (`pollGmailImwebInbox` 안, import 추가)
- Test: `lib/mail/poll-gmail.test.ts` (케이스 추가)

**Interfaces:**
- Consumes: `parseSubscriptionEmail`, `isSubscriptionSubject` (Task 2), `planAmount`/`defaultStartMonth`/`endMonthOf` (Task 1)
- Produces: `handleSubscriptionIncoming(args: { externalId: string; raw: string; appliedAt?: Date }): Promise<{ status: 'parsed' } | { status: 'duplicate' } | { status: 'parse_failed' }>`

- [ ] **Step 1: 실패하는 테스트 작성** — `lib/ingest-subscription.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase 전부 목 — lib/ingest.test.ts 와 같은 방식. 멱등/재시도 분기와 저장 값만 검증한다.

const responses = {
  insert: null as { code?: string; message?: string } | null,
  selectStatusSingle: { data: null as { status: string } | null, error: null as unknown },
  upsert: null as { message: string } | null,
};

const ingestLogSelectBuilder = {
  match: vi.fn(() => ingestLogSelectBuilder),
  single: vi.fn(() => Promise.resolve(responses.selectStatusSingle)),
};
const ingestLogUpdateBuilder = { match: vi.fn(() => Promise.resolve({ error: null })) };
const ingestLogBuilder = {
  insert: vi.fn(() => Promise.resolve({ error: responses.insert })),
  select: vi.fn(() => ingestLogSelectBuilder),
  update: vi.fn(() => ingestLogUpdateBuilder),
};
const subscriptionsBuilder = {
  upsert: vi.fn(() => Promise.resolve({ error: responses.upsert })),
};
const mockClient = {
  from: vi.fn((table: string) => {
    if (table === 'ingest_log') return ingestLogBuilder;
    if (table === 'subscriptions') return subscriptionsBuilder;
    throw new Error(`unexpected table: ${table}`);
  }),
};

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => mockClient) }));

const { handleSubscriptionIncoming } = await import('./ingest-subscription');

const body = (plan: number) => `제목: [스테이 온 페이지] 월간구독${plan}개월 신청에 새 응답이 접수되었습니다.
등록위치월간구독${plan}개월 신청 응답
이름
홍길동
연락처
01012345678
주소
(38334)
경북 청도군 화양읍 동천3길 67 (교촌리)
오마이뷱
`;
const applied = new Date('2026-10-14T23:53:08Z'); // KST 10/15 → 시작달 2026-11

describe('handleSubscriptionIncoming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responses.insert = null;
    responses.selectStatusSingle = { data: null, error: null };
    responses.upsert = null;
  });

  it('신규 4개월: pending 으로 저장, 금액 10만, 시작 2026-11 ~ 마침 2027-02, external_id 접두어', async () => {
    const res = await handleSubscriptionIncoming({ externalId: '<m1>', raw: body(4), appliedAt: applied });
    expect(res).toEqual({ status: 'parsed' });
    expect(ingestLogBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'imweb_email', external_id: 'subscription:<m1>' }),
    );
    expect(subscriptionsBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '홍길동',
        phone: '01012345678',
        address: '(38334) 경북 청도군 화양읍 동천3길 67 (교촌리)',
        address_detail: '오마이뷱',
        plan_months: 4,
        amount: 100000,
        status: 'pending',
        start_month: '2026-11',
        end_month: '2027-02',
        applied_at: '2026-10-14T23:53:08.000Z',
        source_external_id: 'subscription:<m1>',
      }),
      { onConflict: 'source_external_id', ignoreDuplicates: true },
    );
    expect(ingestLogUpdateBuilder.match).toHaveBeenCalled(); // markLog parsed
  });

  it('8개월: 금액 20만, 마침 2027-06', async () => {
    await handleSubscriptionIncoming({ externalId: '<m2>', raw: body(8), appliedAt: applied });
    expect(subscriptionsBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ plan_months: 8, amount: 200000, end_month: '2027-06' }),
      expect.anything(),
    );
  });

  it('★ 이미 parsed 인 메일(23505)은 duplicate — 저장 안 함', async () => {
    responses.insert = { code: '23505', message: 'dup' };
    responses.selectStatusSingle = { data: { status: 'parsed' }, error: null };
    const res = await handleSubscriptionIncoming({ externalId: '<m1>', raw: body(4), appliedAt: applied });
    expect(res).toEqual({ status: 'duplicate' });
    expect(subscriptionsBuilder.upsert).not.toHaveBeenCalled();
  });

  it('★ 이전 시도가 실패(23505 + parse_failed)했다면 재시도해서 저장한다(영구 유실 방지)', async () => {
    responses.insert = { code: '23505', message: 'dup' };
    responses.selectStatusSingle = { data: { status: 'parse_failed' }, error: null };
    const res = await handleSubscriptionIncoming({ externalId: '<m1>', raw: body(4), appliedAt: applied });
    expect(res).toEqual({ status: 'parsed' });
    expect(subscriptionsBuilder.upsert).toHaveBeenCalled();
  });

  it('★ 6개월 메일은 parse_failed — 저장하지 않고 로그에 남긴다', async () => {
    const res = await handleSubscriptionIncoming({ externalId: '<m3>', raw: body(6), appliedAt: applied });
    expect(res).toEqual({ status: 'parse_failed' });
    expect(subscriptionsBuilder.upsert).not.toHaveBeenCalled();
    expect(ingestLogUpdateBuilder.match).toHaveBeenCalled();
  });

  it('저장 오류는 parse_failed 로 기록하고 던진다(다음 폴링에서 재시도)', async () => {
    responses.upsert = { message: 'timeout' };
    await expect(
      handleSubscriptionIncoming({ externalId: '<m4>', raw: body(4), appliedAt: applied }),
    ).rejects.toMatchObject({ message: 'timeout' });
    expect(ingestLogBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'parse_failed', error: 'timeout' }),
    );
  });

  it('ingest_log insert 의 23505 외 오류는 그대로 던진다', async () => {
    responses.insert = { code: '500', message: 'boom' };
    await expect(
      handleSubscriptionIncoming({ externalId: '<m5>', raw: body(4), appliedAt: applied }),
    ).rejects.toMatchObject({ message: 'boom' });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `TZ=UTC npx vitest run lib/ingest-subscription.test.ts` / Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `lib/ingest-subscription.ts`

```ts
import { createClient } from '@supabase/supabase-js';
import { parseSubscriptionEmail } from './parsers/subscription-email';
import { planAmount, defaultStartMonth, endMonthOf } from './subscription';

// 월간구독 신청 메일 수신. lib/ingest.ts 의 handleIncoming 과 같은 멱등/재시도 규칙:
//  · ingest_log (source, external_id) unique 로 원문을 먼저 기록.
//  · 충돌 시 기존 행이 'parsed' 일 때만 duplicate — 'received'/'parse_failed' 면 재시도
//    (2026-09 박재홍님 예약 유실 사고와 같은 실패를 구독에서 반복하지 않는다).
// source 는 기존 'imweb_email'(enum 추가 불필요)을 쓰고 external_id 에 'subscription:' 접두어를
// 붙인다 — 과거에 예약 파서로 보내져 parse_failed 로 남은 같은 메일 행과 충돌하지 않는다.
// service_role 키 사용 — 서버 전용.

const SOURCE = 'imweb_email' as const;

export type SubscriptionIngestResult =
  | { status: 'parsed' }
  | { status: 'duplicate' }
  | { status: 'parse_failed' };

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

export async function handleSubscriptionIncoming(args: {
  externalId: string; // 메일 Message-ID (접두어는 여기서 붙인다)
  raw: string; // "제목: <subject>\n<본문>"
  appliedAt?: Date; // 메일 Date 헤더 — 없으면 현재 시각
}): Promise<SubscriptionIngestResult> {
  const externalId = `subscription:${args.externalId}`;

  const markLog = (patch: Record<string, unknown>) =>
    supabase.from('ingest_log').update(patch).match({ source: SOURCE, external_id: externalId });

  const { error: logErr } = await supabase
    .from('ingest_log')
    .insert({ source: SOURCE, external_id: externalId, raw: args.raw, status: 'received' });
  if (logErr) {
    if (logErr.code !== '23505') throw logErr;
    const { data: existing, error: fetchErr } = await supabase
      .from('ingest_log')
      .select('status')
      .match({ source: SOURCE, external_id: externalId })
      .single();
    if (fetchErr) throw fetchErr;
    if (existing?.status === 'parsed') return { status: 'duplicate' };
    // 'received' 또는 'parse_failed' → 아래로 이어져 재시도.
  }

  const parsed = parseSubscriptionEmail(args.raw);
  if (!parsed) {
    await markLog({ status: 'parse_failed', error: 'subscription parser returned null' });
    return { status: 'parse_failed' };
  }

  const appliedAt = args.appliedAt && !Number.isNaN(args.appliedAt.getTime()) ? args.appliedAt : new Date();
  const startMonth = defaultStartMonth(appliedAt.toISOString());

  const { error } = await supabase.from('subscriptions').upsert(
    {
      name: parsed.name,
      phone: parsed.phone,
      address: parsed.address,
      address_detail: parsed.address_detail,
      plan_months: parsed.plan_months,
      amount: planAmount(parsed.plan_months),
      status: 'pending',
      start_month: startMonth,
      end_month: endMonthOf(startMonth, parsed.plan_months),
      applied_at: appliedAt.toISOString(),
      source_external_id: externalId,
    },
    { onConflict: 'source_external_id', ignoreDuplicates: true },
  );
  if (error) {
    await markLog({ status: 'parse_failed', error: error.message });
    throw error;
  }

  await markLog({ status: 'parsed' });
  return { status: 'parsed' };
}
```

- [ ] **Step 4: 통과 확인** — Run: `TZ=UTC npx vitest run lib/ingest-subscription.test.ts` / Expected: PASS (7 tests)

- [ ] **Step 5: 폴러 분기 테스트 추가** — `lib/mail/poll-gmail.test.ts`

상단 mock 영역(`vi.mock('../parsers/imweb-email', ...)` 바로 아래)에 추가:

```ts
const mockHandleSubscription = vi.fn();
vi.mock('../ingest-subscription', () => ({
  handleSubscriptionIncoming: (...args: unknown[]) => mockHandleSubscription(...args),
}));
```

`describe('pollGmailImwebInbox', ...)` 블록 안 마지막에 추가:

```ts
  it('★ 제목이 월간구독 신청이면 구독 수집기로 보내고 예약 수집기는 부르지 않는다(읽음 처리 포함)', async () => {
    mockClient.search.mockResolvedValue([801]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    const date = new Date('2026-10-14T23:53:08Z');
    mockParsed.mockResolvedValue({
      messageId: '<sub-1>',
      subject: '[스테이 온 페이지] 월간구독4개월 신청에 새 응답이 접수되었습니다.',
      text: '이름\n홍길동',
      date,
    });
    mockHandleSubscription.mockResolvedValue({ status: 'parsed' });

    const result = await pollGmailImwebInbox();

    expect(mockHandleSubscription).toHaveBeenCalledWith({
      externalId: '<sub-1>',
      raw: '제목: [스테이 온 페이지] 월간구독4개월 신청에 새 응답이 접수되었습니다.\n이름\n홍길동',
      appliedAt: date,
    });
    expect(mockHandleIncoming).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, parsed: 1, duplicate: 0, parseFailed: 0, errors: [] });
    expect(mockClient.messageFlagsAdd).toHaveBeenCalledWith({ uid: '801' }, ['\\Seen'], { uid: true });
  });

  it('★ 회귀: 일반 예약 메일(제목에 월간구독 없음)은 기존대로 handleIncoming', async () => {
    mockClient.search.mockResolvedValue([802]);
    mockClient.download.mockResolvedValue({ content: Buffer.from('raw') });
    mockParsed.mockResolvedValue({
      messageId: '<iw-2>',
      subject: '[스테이 온 페이지] 예약이 접수되어 입금 확인이 필요합니다.',
      text: '예약 내용',
    });
    mockHandleIncoming.mockResolvedValue({ status: 'parsed', reservationId: 'r9' });

    await pollGmailImwebInbox();

    expect(mockHandleIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'imweb_email', externalId: '<iw-2>' }),
    );
    expect(mockHandleSubscription).not.toHaveBeenCalled();
  });
```

- [ ] **Step 6: 실패 확인** — Run: `TZ=UTC npx vitest run lib/mail/poll-gmail.test.ts` / Expected: 새 케이스 FAIL (구독 분기 없음)

- [ ] **Step 7: 폴러 수정** — `lib/mail/poll-gmail.ts`

import 추가(`import { parseImwebEmail } ...` 아래):

```ts
import { isSubscriptionSubject } from '../parsers/subscription-email';
import { handleSubscriptionIncoming } from '../ingest-subscription';
```

`pollGmailImwebInbox` 안의 아래 블록을 교체한다(기존):

```ts
        const outcome = await handleIncoming({
          source: 'imweb_email',
          externalId,
          raw: text,
          parse: parseImwebEmail,
        });
```

→

```ts
        // 입력폼 "월간구독N개월 신청" 알림은 예약이 아니라 구독 — 제목으로 분기한다
        // (예약 파서로 보내면 parse_failed 만 쌓인다). 그 외 모든 메일은 기존 경로 그대로.
        const subject = parsedMail.subject ?? '';
        const outcome = isSubscriptionSubject(subject)
          ? await handleSubscriptionIncoming({
              externalId,
              raw: `제목: ${subject}\n${text}`,
              appliedAt: parsedMail.date,
            })
          : await handleIncoming({
              source: 'imweb_email',
              externalId,
              raw: text,
              parse: parseImwebEmail,
            });
```

(`pollGmailStayfolioInbox` 는 건드리지 않는다.)

- [ ] **Step 8: 통과 확인** — Run: `TZ=UTC npx vitest run lib/mail/poll-gmail.test.ts lib/ingest-subscription.test.ts` / Expected: PASS 전부

- [ ] **Step 9: 커밋**

```bash
git add lib/ingest-subscription.ts lib/ingest-subscription.test.ts lib/mail/poll-gmail.ts lib/mail/poll-gmail.test.ts
git commit -m "feat: 월간구독 신청 메일 자동 수집(제목 분기, 멱등/재시도)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 구독 통계 (`lib/subscription-stats.ts`)

**Files:**
- Create: `lib/subscription-stats.ts`
- Test: `lib/subscription-stats.test.ts`

**Interfaces:**
- Consumes: `Subscription` (db-types), `DateRange` from `./stats`, `kstDateOf` (Task 1)
- Produces:
  ```ts
  export interface SubscriptionStats { newCount: number; revenue: number; activeCount: number }
  export function computeSubscriptionStats(subs: readonly Subscription[], range: DateRange): SubscriptionStats
  ```
  의미: `newCount`/`revenue` = 입금확인일(KST)이 `[range.start, range.end)` 안인 confirmed·ended 건. `activeCount` = status `confirmed` 이면서 `[start_month, end_month]` 가 범위의 달들과 겹치는 건.

- [ ] **Step 1: 실패하는 테스트 작성** — `lib/subscription-stats.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { computeSubscriptionStats } from './subscription-stats';
import type { Subscription } from './db-types';

const sub = (over: Partial<Subscription>): Subscription => ({
  id: 'x',
  name: '홍길동',
  phone: null,
  address: null,
  address_detail: null,
  plan_months: 4,
  amount: 100000,
  status: 'confirmed',
  start_month: '2026-11',
  end_month: '2027-02',
  applied_at: '2026-10-15T00:00:00Z',
  confirmed_at: '2026-10-20T03:00:00Z',
  ended_at: null,
  notes: null,
  created_at: '2026-10-15T00:00:00Z',
  ...over,
});

const OCT = { start: '2026-10-01', end: '2026-11-01' };
const NOV = { start: '2026-11-01', end: '2026-12-01' };

describe('computeSubscriptionStats', () => {
  it('입금확인일이 범위 안인 확정 건만 매출·건수에 잡는다', () => {
    const r = computeSubscriptionStats(
      [sub({ id: 'a', amount: 100000 }), sub({ id: 'b', plan_months: 8, amount: 200000, end_month: '2027-06' })],
      OCT,
    );
    expect(r.newCount).toBe(2);
    expect(r.revenue).toBe(300000);
  });

  it('입금대기(미확정)는 제외', () => {
    const r = computeSubscriptionStats([sub({ status: 'pending', confirmed_at: null })], OCT);
    expect(r).toEqual({ newCount: 0, revenue: 0, activeCount: 0 });
  });

  it('★ 입금확인을 되돌린 건(pending, confirmed_at null)은 매출에서 빠진다', () => {
    const before = computeSubscriptionStats([sub({})], OCT);
    const after = computeSubscriptionStats([sub({ status: 'pending', confirmed_at: null })], OCT);
    expect(before.revenue).toBe(100000);
    expect(after.revenue).toBe(0);
  });

  it('종료된 건도 입금확인 월 매출은 유지', () => {
    const r = computeSubscriptionStats([sub({ status: 'ended', ended_at: '2027-03-01T00:00:00Z' })], OCT);
    expect(r.revenue).toBe(100000);
  });

  it('★ KST 경계: UTC 10/31 15:00 은 KST 11/1 → 10월 제외·11월 포함', () => {
    const s = sub({ confirmed_at: '2026-10-31T15:00:00Z' });
    expect(computeSubscriptionStats([s], OCT).revenue).toBe(0);
    expect(computeSubscriptionStats([s], NOV).revenue).toBe(100000);
  });

  it('★ KST 경계: UTC 9/30 15:00 은 KST 10/1 → 10월 포함', () => {
    const s = sub({ confirmed_at: '2026-09-30T15:00:00Z' });
    expect(computeSubscriptionStats([s], OCT).revenue).toBe(100000);
  });

  it('활성 구독자: 확정이면서 구독 기간이 범위의 달과 겹칠 때만(종료·대기 제외)', () => {
    const rows = [
      sub({ id: 'active' }), // 2026-11 ~ 2027-02
      sub({ id: 'ended', status: 'ended' }),
      sub({ id: 'pending', status: 'pending', confirmed_at: null }),
      sub({ id: 'future', start_month: '2027-03', end_month: '2027-06' }),
    ];
    expect(computeSubscriptionStats(rows, NOV).activeCount).toBe(1); // active 만
    expect(computeSubscriptionStats(rows, OCT).activeCount).toBe(0); // 10월엔 아직 시작 전
  });

  it('활성 판정은 범위가 여러 달에 걸쳐도 겹치면 포함(반개구간 end 의 전날 달까지)', () => {
    const range = { start: '2026-10-01', end: '2026-12-01' }; // 10~11월
    expect(computeSubscriptionStats([sub({})], range).activeCount).toBe(1);
    const decOnly = { start: '2026-12-01', end: '2027-01-01' };
    expect(computeSubscriptionStats([sub({ start_month: '2027-01', end_month: '2027-04' })], decOnly).activeCount).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `TZ=UTC npx vitest run lib/subscription-stats.test.ts` / Expected: FAIL

- [ ] **Step 3: 구현** — `lib/subscription-stats.ts`

```ts
import type { Subscription } from './db-types';
import type { DateRange } from './stats';
import { kstDateOf } from './subscription';

// 월간구독 통계(순수 함수). 숙박(lib/stats.ts)의 computeStats 는 건드리지 않고 따로 계산해
// 화면(Statistics.tsx)에서 나란히 보여준다.
//
// 매출 귀속 = 입금확인일(confirmed_at 의 KST 날짜)이 range 안인 건 — 4개월/8개월 치 전액이
// 입금받은 달에 들어온다(사장님 결정 2026-10-15). 입금대기·되돌린 건(confirmed_at null)은 제외.

export interface SubscriptionStats {
  newCount: number; // 기간 내 입금확인 건수
  revenue: number; // 기간 내 입금확인 금액 합
  activeCount: number; // 기간과 구독 기간이 겹치는 '확정' 구독자 수
}

export function computeSubscriptionStats(
  subs: readonly Subscription[],
  range: DateRange,
): SubscriptionStats {
  const confirmedInRange = subs.filter((s) => {
    if (s.status === 'pending' || !s.confirmed_at) return false;
    const d = kstDateOf(s.confirmed_at);
    return d >= range.start && d < range.end;
  });

  // range.end 는 미포함(반개구간) — 마지막으로 포함되는 날의 달까지 본다.
  const firstMonth = range.start.slice(0, 7);
  const lastDay = new Date(Date.parse(range.end + 'T00:00:00Z') - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const lastMonth = lastDay.slice(0, 7);

  const activeCount = subs.filter(
    (s) => s.status === 'confirmed' && s.start_month <= lastMonth && s.end_month >= firstMonth,
  ).length;

  return {
    newCount: confirmedInRange.length,
    revenue: confirmedInRange.reduce((sum, s) => sum + s.amount, 0),
    activeCount,
  };
}
```

- [ ] **Step 4: 통과 확인** — Run: `TZ=UTC npx vitest run lib/subscription-stats.test.ts` / Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add lib/subscription-stats.ts lib/subscription-stats.test.ts
git commit -m "feat: 월간구독 통계(입금확인 월 기준 매출, 활성 구독자)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 화면 — 서버 액션, `SubscriptionList`, 대시보드 연결, 통계 카드

**Files:**
- Create: `lib/subscription-actions.ts`, `components/SubscriptionList.tsx`
- Modify: `components/DashboardRealtime.tsx`, `components/Statistics.tsx`, `app/page.tsx`, `app/globals.css`

**Interfaces:**
- Consumes: Task 1(`ManualSubscriptionInput`, `planAmount`, `endMonthOf`, `isPlanMonths`, `monthsBetween`, `sortSubscriptions`, `SUBSCRIPTION_STATUS_LABEL`, `kstDateOf`), Task 3(`Subscription`, `SubscriptionShipment`, `getSubscriptions`, `getSubscriptionShipments`, RPC 3개), Task 5(`computeSubscriptionStats`)
- Produces:
  - actions (모두 `Promise<{ error: string | null }>`): `confirmSubscription(id)`, `unconfirmSubscription(id)`, `setSubscriptionEnded(id, ended)`, `updateSubscription(id, patch: { start_month?: string; end_month?: string; notes?: string | null })`, `saveShipmentMemo(subscriptionId, month, memo)`, `createManualSubscription(input: ManualSubscriptionInput)`, `deleteSubscription(id)`
  - `<SubscriptionList id? subscriptions shipments onConfirm onUnconfirm onSetEnded onUpdate onSaveShipment onCreate onDelete />`

이 태스크는 UI 중심이라 단위 테스트 대상이 아니다(순수 로직은 Task 1·5 에서 테스트됨). 검증은 tsc + build + 로컬 대시보드 육안 확인.

- [ ] **Step 1: 서버 액션** — `lib/subscription-actions.ts`

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from './supabase/server';
import { planAmount, endMonthOf, isPlanMonths, type ManualSubscriptionInput } from './subscription';

// 월간구독 뮤테이션. 인증된 사용자 컨텍스트(RLS) — lib/actions.ts 와 같은 방식.
// 상태 전이(입금확인/되돌리기/종료)는 RPC(0029)가 잘못된 전이를 조용히 무시한다.

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
type Result = Promise<{ error: string | null }>;

export async function confirmSubscription(id: string): Result {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_subscription', { p_id: id });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function unconfirmSubscription(id: string): Result {
  const supabase = await createClient();
  const { error } = await supabase.rpc('unconfirm_subscription', { p_id: id });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function setSubscriptionEnded(id: string, ended: boolean): Result {
  const supabase = await createClient();
  const { error } = await supabase.rpc('end_subscription', { p_id: id, p_ended: ended });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function updateSubscription(
  id: string,
  patch: { start_month?: string; end_month?: string; notes?: string | null },
): Result {
  if (patch.start_month !== undefined && !MONTH_RE.test(patch.start_month)) {
    return { error: '시작달 형식이 올바르지 않습니다.' };
  }
  if (patch.end_month !== undefined && !MONTH_RE.test(patch.end_month)) {
    return { error: '마치는 달 형식이 올바르지 않습니다.' };
  }
  const supabase = await createClient();
  const { error } = await supabase.from('subscriptions').update(patch).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function saveShipmentMemo(subscriptionId: string, month: string, memo: string): Result {
  if (!MONTH_RE.test(month)) return { error: '월 형식이 올바르지 않습니다.' };
  const supabase = await createClient();
  const { error } = await supabase
    .from('subscription_shipments')
    .upsert(
      { subscription_id: subscriptionId, month, memo, updated_at: new Date().toISOString() },
      { onConflict: 'subscription_id,month' },
    );
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function createManualSubscription(input: ManualSubscriptionInput): Result {
  const name = input.name.trim();
  if (!name) return { error: '이름을 입력해 주세요.' };
  if (!isPlanMonths(input.planMonths)) return { error: '4개월 또는 8개월만 선택할 수 있습니다.' };
  if (!MONTH_RE.test(input.startMonth)) return { error: '시작달 형식이 올바르지 않습니다.' };
  const supabase = await createClient();
  const { error } = await supabase.from('subscriptions').insert({
    name,
    phone: input.phone.replace(/\D/g, '') || null,
    address: input.address.trim() || null,
    address_detail: input.addressDetail.trim() || null,
    plan_months: input.planMonths,
    amount: planAmount(input.planMonths),
    status: 'pending',
    start_month: input.startMonth,
    end_month: endMonthOf(input.startMonth, input.planMonths),
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function deleteSubscription(id: string): Result {
  const supabase = await createClient();
  const { error } = await supabase.from('subscriptions').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}
```

- [ ] **Step 2: 컴포넌트** — `components/SubscriptionList.tsx`

```tsx
'use client';

import { useState } from 'react';
import type { Subscription, SubscriptionShipment } from '../lib/db-types';
import {
  SUBSCRIPTION_STATUS_LABEL,
  sortSubscriptions,
  monthsBetween,
  endMonthOf,
  defaultStartMonth,
  kstDateOf,
  type ManualSubscriptionInput,
  type PlanMonths,
} from '../lib/subscription';
import { formatWon } from '../lib/format';

// 월간구독 섹션. 상태는 부모(DashboardRealtime)가 소유 — 이 컴포넌트는 표시 + 콜백만.
// 정렬: 입금대기 → 확정 → 종료(종료는 맨 뒤). 접어서 5건만 보이고 "더 보기".
const COLLAPSED_COUNT = 5;

export function SubscriptionList({
  subscriptions,
  shipments,
  onConfirm,
  onUnconfirm,
  onSetEnded,
  onUpdate,
  onSaveShipment,
  onCreate,
  onDelete,
  id,
}: {
  subscriptions: Subscription[];
  shipments: SubscriptionShipment[];
  onConfirm: (id: string) => void;
  onUnconfirm: (id: string) => void;
  onSetEnded: (id: string, ended: boolean) => void;
  onUpdate: (
    id: string,
    patch: { start_month?: string; end_month?: string; notes?: string | null },
  ) => void;
  onSaveShipment: (subscriptionId: string, month: string, memo: string) => void;
  onCreate: (input: ManualSubscriptionInput) => void;
  onDelete: (id: string) => void;
  id?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState({
    name: '',
    phone: '',
    address: '',
    addressDetail: '',
    planMonths: 4 as PlanMonths,
    startMonth: defaultStartMonth(new Date().toISOString()),
  });

  const sorted = sortSubscriptions(subscriptions);
  const shown = expanded ? sorted : sorted.slice(0, COLLAPSED_COUNT);
  const hiddenCount = sorted.length - shown.length;
  const memoOf = (subId: string, month: string) =>
    shipments.find((s) => s.subscription_id === subId && s.month === month)?.memo ?? '';

  return (
    <section id={id}>
      <div className="section-title">
        <h2>월간구독</h2>
        <span className="count-pill">{subscriptions.length}명</span>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">구독 신청 없음</div>
      ) : (
        shown.map((s) => {
          const open = !!openIds[s.id];
          return (
            <div key={s.id} className="card">
              <div className="card-top">
                <div>
                  <div className="card-title">
                    {s.name} · {s.plan_months}개월
                  </div>
                  <div className="card-meta">
                    {s.phone ?? '연락처 없음'}
                    <br />
                    {s.address ?? '주소 없음'}
                    {s.address_detail && ` ${s.address_detail}`}
                    <br />
                    <label>
                      시작{' '}
                      <input
                        type="month"
                        value={s.start_month}
                        onChange={(e) =>
                          e.target.value &&
                          onUpdate(s.id, {
                            start_month: e.target.value,
                            end_month: endMonthOf(e.target.value, s.plan_months),
                          })
                        }
                      />
                    </label>{' '}
                    <label>
                      종료{' '}
                      <input
                        type="month"
                        value={s.end_month}
                        onChange={(e) => e.target.value && onUpdate(s.id, { end_month: e.target.value })}
                      />
                    </label>
                    <br />
                    신청 {kstDateOf(s.applied_at)}
                    {s.confirmed_at && ` · 입금확인 ${kstDateOf(s.confirmed_at)}`}
                  </div>
                </div>
                <div className="amount">{formatWon(s.amount)}</div>
              </div>

              <div className="badge-row">
                <span className={`sub-badge sub-${s.status}`}>{SUBSCRIPTION_STATUS_LABEL[s.status]}</span>
                {s.status === 'pending' && (
                  <button type="button" className="btn-primary" onClick={() => onConfirm(s.id)}>
                    입금확인
                  </button>
                )}
                {s.status === 'confirmed' && (
                  <>
                    <label className="sub-end-check">
                      <input type="checkbox" checked={false} onChange={() => onSetEnded(s.id, true)} /> 종료
                    </label>
                    <button type="button" className="deeplink" onClick={() => onUnconfirm(s.id)}>
                      입금확인 취소
                    </button>
                  </>
                )}
                {s.status === 'ended' && (
                  <label className="sub-end-check">
                    <input type="checkbox" checked onChange={() => onSetEnded(s.id, false)} /> 종료
                  </label>
                )}
                <button
                  type="button"
                  className="deeplink"
                  onClick={() => setOpenIds((prev) => ({ ...prev, [s.id]: !open }))}
                >
                  {open ? '접기' : '발송 메모'}
                </button>
                <button
                  type="button"
                  className="reservation-cancel-btn"
                  onClick={() => {
                    if (window.confirm(`${s.name} 구독을 삭제할까요? 발송 메모도 함께 사라집니다.`)) {
                      onDelete(s.id);
                    }
                  }}
                >
                  삭제
                </button>
              </div>

              {open && (
                <div className="sub-memo-panel">
                  {monthsBetween(s.start_month, s.end_month).map((m) => {
                    const saved = memoOf(s.id, m);
                    return (
                      <label key={`${s.id}-${m}-${saved}`} className="sub-memo-row">
                        <span>{m}</span>
                        <input
                          type="text"
                          defaultValue={saved}
                          placeholder="발송한 책 / 특산물"
                          onBlur={(e) => {
                            if (e.target.value !== saved) onSaveShipment(s.id, m, e.target.value);
                          }}
                        />
                      </label>
                    );
                  })}
                  <label className="sub-memo-row">
                    <span>메모</span>
                    <input
                      key={`${s.id}-notes-${s.notes ?? ''}`}
                      type="text"
                      defaultValue={s.notes ?? ''}
                      placeholder="자유 메모"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (s.notes ?? '')) onUpdate(s.id, { notes: v || null });
                      }}
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })
      )}

      {hiddenCount > 0 && (
        <button type="button" className="block-more-btn" onClick={() => setExpanded(true)}>
          {hiddenCount}명 더 보기
        </button>
      )}
      {expanded && sorted.length > COLLAPSED_COUNT && (
        <button type="button" className="block-more-btn" onClick={() => setExpanded(false)}>
          접기
        </button>
      )}

      <details className="sub-manual">
        <summary>구독자 직접 추가</summary>
        <div className="sub-manual-grid">
          <input placeholder="이름" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="연락처" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input placeholder="주소" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <input placeholder="상세주소" value={form.addressDetail} onChange={(e) => setForm({ ...form, addressDetail: e.target.value })} />
          <select value={form.planMonths} onChange={(e) => setForm({ ...form, planMonths: Number(e.target.value) as PlanMonths })}>
            <option value={4}>4개월 (10만원)</option>
            <option value={8}>8개월 (20만원)</option>
          </select>
          <input type="month" value={form.startMonth} onChange={(e) => setForm({ ...form, startMonth: e.target.value })} />
          <button
            type="button"
            className="btn-primary"
            disabled={!form.name.trim() || !form.startMonth}
            onClick={() => {
              onCreate(form);
              setForm({ ...form, name: '', phone: '', address: '', addressDetail: '' });
            }}
          >
            추가
          </button>
        </div>
      </details>
    </section>
  );
}
```

- [ ] **Step 3: CSS** — `app/globals.css` 끝에 append

```css
/* 월간구독 */
.sub-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
}
.sub-badge.sub-pending { background: var(--st-awaiting); }
.sub-badge.sub-confirmed { background: var(--st-confirmed); }
.sub-badge.sub-ended { background: #8a8a8a; }
.sub-end-check { font-size: 13px; display: inline-flex; align-items: center; gap: 4px; }
.sub-memo-panel { margin-top: 10px; display: grid; gap: 6px; }
.sub-memo-row { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 8px; font-size: 13px; }
.sub-memo-row input { width: 100%; min-width: 0; padding: 6px 8px; }
.sub-manual { margin-top: 12px; }
.sub-manual summary { cursor: pointer; font-size: 13px; }
.sub-manual-grid { margin-top: 8px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.sub-manual-grid input, .sub-manual-grid select { min-width: 0; padding: 6px 8px; }
```

- [ ] **Step 4: `app/page.tsx` 수정**

import 목록의 `getTodayPageAssignedReservationIds,` 다음 줄에 추가:

```ts
  getSubscriptions,
  getSubscriptionShipments,
```

`Promise.allSettled([...])` 배열 끝(`getTodayPageAssignedReservationIds(supabase),` 다음)에 추가:

```ts
    getSubscriptions(supabase),
    getSubscriptionShipments(supabase),
```

`const names = [...]` 배열에 `'getSubscriptions', 'getSubscriptionShipments'` 두 이름을 끝에 추가.

구조분해/캐스팅을 교체:

```ts
  const [reservations, blockTasks, lastSync, pendingChanges, todayPageAssignedIds, subscriptions, subscriptionShipments] = settled.map(
    (r) => (r as PromiseFulfilledResult<unknown>).value,
  ) as [
    Awaited<ReturnType<typeof getReservations>>,
    Awaited<ReturnType<typeof getBlockTasks>>,
    Awaited<ReturnType<typeof getLastSyncByChannel>>,
    Awaited<ReturnType<typeof getPendingReservationChanges>>,
    Awaited<ReturnType<typeof getTodayPageAssignedReservationIds>>,
    Awaited<ReturnType<typeof getSubscriptions>>,
    Awaited<ReturnType<typeof getSubscriptionShipments>>,
  ];
```

`<DashboardRealtime ... />` 에 props 추가:

```tsx
        initialSubscriptions={subscriptions}
        initialSubscriptionShipments={subscriptionShipments}
```

- [ ] **Step 5: `components/DashboardRealtime.tsx` 수정**

(a) import: queries 목록에 `getSubscriptions, getSubscriptionShipments,` 추가; `import type { Reservation, BlockTask, ReservationChange } ...` 에 `Subscription, SubscriptionShipment` 추가; 아래 추가:

```ts
import { SubscriptionList } from './SubscriptionList';
import {
  confirmSubscription,
  unconfirmSubscription,
  setSubscriptionEnded,
  updateSubscription,
  saveShipmentMemo,
  createManualSubscription,
  deleteSubscription,
} from '../lib/subscription-actions';
```

(b) props: 구조분해에 `initialSubscriptions, initialSubscriptionShipments,` 추가, 타입에 `initialSubscriptions: Subscription[]; initialSubscriptionShipments: SubscriptionShipment[];` 추가.

(c) state — `const [changes, setChanges] = useState(initialChanges);` 아래:

```ts
  const [subscriptions, setSubscriptions] = useState(initialSubscriptions);
  const [shipments, setShipments] = useState(initialSubscriptionShipments);
```

(d) realtime — `reservations` `.on(...)` 블록 직후, `block_tasks` `.on(` 앞에 삽입:

```ts
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'subscriptions' },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              const oldId = (payload.old as { id: string }).id;
              setSubscriptions((prev) => prev.filter((s) => s.id !== oldId));
            } else {
              setSubscriptions((prev) => upsertById(prev, payload.new as Subscription));
            }
          },
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'subscription_shipments' },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              const oldId = (payload.old as { id: string }).id;
              setShipments((prev) => prev.filter((s) => s.id !== oldId));
            } else {
              setShipments((prev) => upsertById(prev, payload.new as SubscriptionShipment));
            }
          },
        )
```

(e) `syncAll` 의 `run` 배열에 `getSubscriptions(sb), getSubscriptionShipments(sb),` 추가하고 `.then(([res, blk, chg, assignedIds]) => {` 를 `.then(([res, blk, chg, assignedIds, subs, ships]) => {` 로, 블록 끝에 `setSubscriptions(subs); setShipments(ships);` 추가.

(f) 핸들러 — `return (\n    <>\n      <DoubleBookingAlert` 바로 앞에 삽입:

```ts
  // 월간구독 뮤테이션: 낙관적 반영 → 서버 액션 → 성공/실패 모두 재조회로 authoritative 값에 맞춘다.
  const runSubscription = (
    apply: () => void,
    action: () => Promise<{ error: string | null }>,
    failMsg: string,
  ) => {
    apply();
    startTransition(() => {
      action().then((res) => {
        syncAll();
        if (res.error) {
          console.error(failMsg, res.error);
          if (typeof window !== 'undefined') window.alert(failMsg + '\n' + res.error);
        }
      });
    });
  };
  const patchSubscription = (id: string, patch: Partial<Subscription>) =>
    setSubscriptions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const handleConfirmSubscription = (id: string) =>
    runSubscription(
      () => patchSubscription(id, { status: 'confirmed', confirmed_at: new Date().toISOString() }),
      () => confirmSubscription(id),
      '입금확인 처리에 실패했습니다.',
    );
  const handleUnconfirmSubscription = (id: string) =>
    runSubscription(
      () => patchSubscription(id, { status: 'pending', confirmed_at: null }),
      () => unconfirmSubscription(id),
      '입금확인 취소에 실패했습니다.',
    );
  const handleSetSubscriptionEnded = (id: string, ended: boolean) =>
    runSubscription(
      () =>
        patchSubscription(id, {
          status: ended ? 'ended' : 'confirmed',
          ended_at: ended ? new Date().toISOString() : null,
        }),
      () => setSubscriptionEnded(id, ended),
      '종료 처리에 실패했습니다.',
    );
  const handleUpdateSubscription = (
    id: string,
    patch: { start_month?: string; end_month?: string; notes?: string | null },
  ) =>
    runSubscription(
      () => patchSubscription(id, patch),
      () => updateSubscription(id, patch),
      '구독 정보 저장에 실패했습니다.',
    );
  const handleSaveShipment = (subscriptionId: string, month: string, memo: string) =>
    runSubscription(
      () =>
        setShipments((prev) => {
          const i = prev.findIndex((x) => x.subscription_id === subscriptionId && x.month === month);
          if (i === -1) {
            return [
              { id: `tmp-${subscriptionId}-${month}`, subscription_id: subscriptionId, month, memo, updated_at: new Date().toISOString() },
              ...prev,
            ];
          }
          const copy = [...prev];
          copy[i] = { ...copy[i], memo };
          return copy;
        }),
      () => saveShipmentMemo(subscriptionId, month, memo),
      '발송 메모 저장에 실패했습니다.',
    );
  const handleCreateSubscription = (input: Parameters<typeof createManualSubscription>[0]) =>
    runSubscription(() => {}, () => createManualSubscription(input), '구독자 추가에 실패했습니다.');
  const handleDeleteSubscription = (id: string) =>
    runSubscription(
      () => setSubscriptions((prev) => prev.filter((s) => s.id !== id)),
      () => deleteSubscription(id),
      '구독 삭제에 실패했습니다.',
    );
  const pendingSubscriptionCount = subscriptions.filter((s) => s.status === 'pending').length;

```

(g) quick-nav — `<a href="#stats">통계</a>` 바로 앞에 추가:

```tsx
        <a href="#subs">
          구독
          <span className={`n-count ${pendingSubscriptionCount === 0 ? 'zero' : ''}`}>
            {pendingSubscriptionCount}
          </span>
        </a>
```

(h) 렌더 — `<Statistics id="stats" reservations={reservations} />` 를 교체:

```tsx
      <SubscriptionList
        id="subs"
        subscriptions={subscriptions}
        shipments={shipments}
        onConfirm={handleConfirmSubscription}
        onUnconfirm={handleUnconfirmSubscription}
        onSetEnded={handleSetSubscriptionEnded}
        onUpdate={handleUpdateSubscription}
        onSaveShipment={handleSaveShipment}
        onCreate={handleCreateSubscription}
        onDelete={handleDeleteSubscription}
      />
      <Statistics id="stats" reservations={reservations} subscriptions={subscriptions} />
```

- [ ] **Step 6: `components/Statistics.tsx` 수정**

import 변경/추가:

```ts
import type { Reservation, Subscription } from '../lib/db-types';
import { computeSubscriptionStats } from '../lib/subscription-stats';
```
(기존 `import type { Reservation } from '../lib/db-types';` 줄을 위 첫 줄로 교체.)

시그니처: `export function Statistics({ reservations, subscriptions, id }: { reservations: Reservation[]; subscriptions: Subscription[]; id?: string })`

`const stats = useMemo(...)` 다음 줄에 추가:

```ts
  const subStats = useMemo(() => computeSubscriptionStats(subscriptions, range), [subscriptions, range]);
```

요약 카드 영역에서 `<div className="stat-card highlight">…합계(전체)…</div>` 바로 다음에 추가:

```tsx
        <div className="stat-card">
          <div className="stat-card-label">월간구독</div>
          <div className="stat-card-value">{formatWon(subStats.revenue)}</div>
          <div className="stat-card-sub">
            입금 {subStats.newCount}건 · 활성 {subStats.activeCount}명
          </div>
        </div>
        <div className="stat-card highlight">
          <div className="stat-card-label">숙박+구독 합계</div>
          <div className="stat-card-value">{formatWon(stats.grandTotal + subStats.revenue)}</div>
        </div>
```

(기존 "합계(전체)" 카드 값은 변경하지 않는다 — 숙박 합계 그대로.)

- [ ] **Step 7: 게이트** — Run (각각 따로): `npx tsc --noEmit; echo $?` → `0`; `TZ=UTC npx vitest run` → 전부 PASS; `npm run build` → 성공.

- [ ] **Step 8: 로컬 화면 확인** — `0029` 가 로컬에서 접근 가능한 DB 에 없으면 getSubscriptions 가 42P01 폴백으로 빈 목록을 반환하므로 화면은 "구독 신청 없음"으로 뜬다. `preview_start` 로 대시보드를 열어 `#subs` 섹션·헤더 "구독" 배지·통계의 "월간구독" 카드가 보이는지, 콘솔 에러가 없는지 확인한다(데이터 동작 검증은 Task 7 의 마이그레이션 적용 후).

- [ ] **Step 9: 커밋**

```bash
git add lib/subscription-actions.ts components/SubscriptionList.tsx components/DashboardRealtime.tsx components/Statistics.tsx app/page.tsx app/globals.css
git commit -m "feat: 월간구독 섹션·입금확인·종료·발송메모·통계 카드

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 마이그레이션 적용·배포·테스트 데이터 정리

운영 DB/배포를 건드리는 단계라 각 단계마다 사용자에게 확인받고 진행한다.

**Files:**
- Create(임시): `scripts/_cleanup-subscription-tests.ts` (실행 후 삭제)
- Modify: `docs/superpowers/HANDOFF-reservation-review-v2.md` 는 건드리지 않는다. 메모리 `sukbak-subscription.md` 신규 + `MEMORY.md` 한 줄.

- [ ] **Step 1: 전체 게이트 재확인** — `npx tsc --noEmit; echo $?` / `TZ=UTC npx vitest run` / `npm run build` 모두 통과.

- [ ] **Step 2: 브랜치 푸시 + PR** (사용자 승인 후)

```bash
git push -u origin feat/monthly-subscription
gh pr create --title "feat: 월간구독 관리(수집·입금확인·발송메모·통계)" --body "$(cat <<'EOF'
## 요약
- 아임웹 "월간구독N개월 신청" 메일 자동 수집 → 별도 `월간구독` 섹션
- 입금대기→확정→종료, 달별 발송 메모, 종료는 맨 뒤 정렬
- 통계: 입금확인 월 기준 매출 + 활성 구독자, 숙박+구독 합계
- 마이그레이션 0029 (머지 전에 적용해야 함)

## 테스트
- vitest 전체, tsc, build 통과
- scripts/verify-0029.sql (begin…rollback)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: 마이그레이션 적용(머지 전)** — 사용자가 Supabase SQL Editor 에서 `0029_subscriptions.sql` 전체를 실행(채팅에 SQL 코드블록으로 제공). 이어서 `scripts/verify-0029.sql` 실행 → `ALL PASSED` 확인. (앱은 테이블이 없어도 42P01 폴백으로 죽지 않으므로 순서가 뒤바뀌어도 대시보드는 안전.)

- [ ] **Step 4: 머지·배포 확인** — 사용자 승인 후 `gh pr merge --squash`(또는 사용자가 웹에서). 이후 `gh workflow run poll.yml --ref main` → 완료 대기 → `curl -s -o /dev/null -w "%{http_code}" <앱 URL>/` 가 `307` 이면 정상. 이 폴링이 곧 첫 구독 수집이다.

- [ ] **Step 5: 테스트 신청 2건 정리** — 폴링 후 `subscriptions` 에 김벼리(01098711804)·김인식(01087761804) 행이 들어온다. 임시 스크립트로 이름+연락처가 정확히 일치하는 행만 삭제한다(ingest_log 는 `parsed` 로 남으므로 재수집되지 않는다).

```ts
// scripts/_cleanup-subscription-tests.ts — 실행 후 삭제
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const tests = [
  { name: '김벼리', phone: '01098711804' },
  { name: '김인식', phone: '01087761804' },
];
for (const t of tests) {
  const { data, error } = await sb.from('subscriptions').delete().match(t).select('id,name');
  console.log(t.name, error ? error.message : `삭제 ${data?.length ?? 0}건`);
}
```

Run: `npx tsx scripts/_cleanup-subscription-tests.ts` → 두 건 모두 `삭제 1건`. 그다음 `rm scripts/_cleanup-subscription-tests.ts`.

- [ ] **Step 6: 실데이터 확인** — 대시보드를 새로고침해 `월간구독` 섹션이 "구독 신청 없음"이고 폴링 로그/`ingest_log` 에 `parse_failed` 가 새로 쌓이지 않는지 확인. 이후 진짜 신청이 오면 카드가 입금대기로 뜨는지 사용자와 함께 확인(또는 "구독자 직접 추가"로 한 건 입력 → 입금확인 → 통계 카드 매출 반영 → 종료 체크 시 맨 뒤 이동까지 눈으로 검증하고 삭제).

- [ ] **Step 7: 메모리 기록** — `/Users/byeolli/.claude/projects/-Users-byeolli-Claude-Projects--------------/memory/sukbak-monthly-subscription.md` 작성(type: project: 상품·금액·상태 흐름·통계 기준·소스/접두어·마이그레이션 0029·테스트 정리 완료 여부) 후 `MEMORY.md` 에 한 줄 추가.

---

## Self-Review (작성자 점검 결과)

- **Spec coverage:** 데이터(Task 3) · 수집+분기+멱등(Task 4) · 파서(Task 2) · 화면 전 항목(카드/정렬/입금확인/종료/월별 메모/수동추가/삭제/배지: Task 6) · 통계(Task 5, 6) · 테스트/verify SQL(각 Task, Task 3) · 테스트 신청 정리(Task 7) · 범위 밖 항목 없음. spec 의 "RPC ingest_subscription" 은 직접 upsert 로 바꿨고 spec 도 같은 커밋에서 수정함.
- **Placeholder scan:** TBD/TODO 없음.
- **Type consistency:** `PlanMonths`/`ManualSubscriptionInput`/`SubscriptionStatusKey`(Task 1) ↔ `Subscription.status`(`'pending'|'confirmed'|'ended'`, Task 3) 일치. `computeSubscriptionStats(subs, range)` 시그니처가 Task 5 정의와 Task 6 사용에서 동일. RPC 인자명 `p_id`/`p_ended` 가 SQL(Task 3)과 액션(Task 6)에서 동일. 수집기 external_id 접두어 `subscription:` 이 테스트/구현/클린업에서 일관.
- **Review Focus:** 7개 항목 모두 위 Task 의 테스트에 매핑됨(표시 참조).
