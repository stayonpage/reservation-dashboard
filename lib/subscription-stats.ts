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
