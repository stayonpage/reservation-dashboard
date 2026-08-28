import { describe, it, expect } from 'vitest';
import { changedFields, changeSummaryLabel } from './reservation-change';
import type { ChangeSnapshot } from './reservation-change';

const base: ChangeSnapshot = {
  check_in: '2026-03-09',
  check_out: '2026-03-10',
  room_name: '객실 서쪽',
  amount: 150000,
  guest_name: '홍길동',
  guest_phone: '010-1111-2222',
  options: [],
};

describe('changedFields', () => {
  it('동일하면 빈 배열', () => {
    expect(changedFields(base, { ...base })).toEqual([]);
  });
  it('날짜 변경', () => {
    expect(changedFields(base, { ...base, check_in: '2026-03-20', check_out: '2026-03-21' }))
      .toEqual(['dates']);
  });
  it('객실 변경', () => {
    expect(changedFields(base, { ...base, room_name: '객실 남쪽' })).toEqual(['room']);
  });
  it('금액: null이면 변경 아님, 값 다르면 변경', () => {
    expect(changedFields(base, { ...base, amount: null })).toEqual([]);
    expect(changedFields(base, { ...base, amount: 120000 })).toEqual(['amount']);
  });
  it('예약자: 전화 null이면 무시, 이름 다르면 변경', () => {
    expect(changedFields(base, { ...base, guest_phone: null })).toEqual([]);
    expect(changedFields(base, { ...base, guest_name: '김철수' })).toEqual(['guest']);
  });
  it('옵션: 빈 배열이면 변경 아님, 내용 다르면 변경', () => {
    expect(changedFields(base, { ...base, options: [] })).toEqual([]);
    expect(changedFields(base, { ...base, options: [{ name: '조식', qty: 2, price: 12000 }] }))
      .toEqual(['options']);
  });
  it('복합 변경은 정해진 순서로', () => {
    expect(
      changedFields(base, {
        ...base,
        check_in: '2026-03-20',
        amount: 99000,
      }),
    ).toEqual(['dates', 'amount']);
  });
});

describe('changeSummaryLabel', () => {
  it('라벨 이어붙이기', () => {
    expect(changeSummaryLabel(['dates'])).toBe('날짜 변경');
    expect(changeSummaryLabel(['dates', 'amount'])).toBe('날짜·금액 변경');
    expect(changeSummaryLabel([])).toBe('변경 없음');
  });
});
