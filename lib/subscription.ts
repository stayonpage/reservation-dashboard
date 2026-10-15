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

/** "정보 복사" 버튼용 텍스트 — 이름 / 연락처 / 주소(+상세주소) 줄바꿈. 비어 있는 항목의 줄은 뺀다. */
export function formatContactText(s: {
  name: string;
  phone: string | null;
  address: string | null;
  address_detail: string | null;
}): string {
  const addr = [s.address, s.address_detail].filter((v): v is string => !!v).join(' ');
  return [s.name, s.phone, addr].filter((line): line is string => !!line).join('\n');
}
