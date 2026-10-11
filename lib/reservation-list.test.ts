import { describe, it, expect } from 'vitest';
import { sixMonthsAgoISO, listReservations } from './reservation-list';

type R = { id: string; status: string; check_in: string; check_out: string; detected_at: string };
const r = (id: string, over: Partial<R> = {}): R => ({
  id,
  status: 'confirmed',
  check_in: '2026-10-20',
  check_out: '2026-10-21',
  detected_at: '2026-10-01T00:00:00+00:00',
  ...over,
});

describe('sixMonthsAgoISO', () => {
  it('정확히 6개월 전 같은 날짜', () => {
    expect(sixMonthsAgoISO('2026-10-11')).toBe('2026-04-11');
  });
  it('연도를 넘어가는 경우', () => {
    expect(sixMonthsAgoISO('2026-03-15')).toBe('2025-09-15');
  });
  it('말일 보정 — 8/31 의 6개월 전은 2월 말일', () => {
    expect(sixMonthsAgoISO('2026-08-31')).toBe('2026-02-28');
    expect(sixMonthsAgoISO('2028-08-31')).toBe('2028-02-29'); // 윤년
  });
});

describe('listReservations — 접수 최신순 + 6개월 이전 숨김', () => {
  const today = '2026-10-11'; // 컷오프 2026-04-11

  it('detected_at 이 최신인 예약이 맨 위(체크인 날짜와 무관)', () => {
    const rows = [
      r('old-receipt-far-future', { check_in: '2026-12-27', detected_at: '2026-09-01T00:00:00+00:00' }),
      r('newest-receipt', { check_in: '2026-10-12', detected_at: '2026-10-10T08:00:00+00:00' }),
      r('mid', { check_in: '2026-11-01', detected_at: '2026-09-20T00:00:00+00:00' }),
    ];
    expect(listReservations(rows, 'all', today).map((x) => x.id)).toEqual([
      'newest-receipt',
      'mid',
      'old-receipt-far-future',
    ]);
  });

  it('탭(상태)별로 걸러도 같은 접수 최신순', () => {
    const rows = [
      r('a', { status: 'confirmed', detected_at: '2026-10-01T00:00:00+00:00' }),
      r('b', { status: 'cancelled', detected_at: '2026-10-09T00:00:00+00:00' }),
      r('c', { status: 'confirmed', detected_at: '2026-10-05T00:00:00+00:00' }),
    ];
    expect(listReservations(rows, 'confirmed', today).map((x) => x.id)).toEqual(['c', 'a']);
    expect(listReservations(rows, 'cancelled', today).map((x) => x.id)).toEqual(['b']);
  });

  it('체크아웃이 6개월 전(2026-04-11) 이전이면 숨기고, 당일·이후는 보인다', () => {
    const rows = [
      r('hidden', { check_in: '2026-04-03', check_out: '2026-04-04' }),
      r('edge', { check_in: '2026-04-10', check_out: '2026-04-11' }),
      r('recent', { check_in: '2026-09-01', check_out: '2026-09-02' }),
    ];
    const ids = listReservations(rows, 'all', today).map((x) => x.id);
    expect(ids).not.toContain('hidden');
    expect(ids).toContain('edge');
    expect(ids).toContain('recent');
  });

  it('6개월 이전 숨김은 취소 탭에서도 동일하게 적용', () => {
    const rows = [r('old-cancelled', { status: 'cancelled', check_in: '2026-03-14', check_out: '2026-03-15' })];
    expect(listReservations(rows, 'cancelled', today)).toEqual([]);
  });

  it('입력 배열을 변경(mutate)하지 않는다', () => {
    const rows = [
      r('x', { detected_at: '2026-10-01T00:00:00+00:00' }),
      r('y', { detected_at: '2026-10-09T00:00:00+00:00' }),
    ];
    const snapshot = rows.map((x) => x.id);
    listReservations(rows, 'all', today);
    expect(rows.map((x) => x.id)).toEqual(snapshot);
  });

  it('detected_at 이 같으면 체크인 늦은 순으로 안정 정렬', () => {
    const same = '2026-10-01T00:00:00+00:00';
    const rows = [
      r('early-checkin', { detected_at: same, check_in: '2026-10-15' }),
      r('late-checkin', { detected_at: same, check_in: '2026-10-25' }),
    ];
    expect(listReservations(rows, 'all', today).map((x) => x.id)).toEqual(['late-checkin', 'early-checkin']);
  });
});
