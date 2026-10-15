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
