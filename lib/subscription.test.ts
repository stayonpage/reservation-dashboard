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
