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
  it('금액만 다르면 빈 배열', () => {
    expect(changedFields(base, { ...base, amount: 120000 })).toEqual([]);
  });
  it('예약자만 다르면 빈 배열', () => {
    expect(changedFields(base, { ...base, guest_name: '김철수' })).toEqual([]);
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
        room_name: '객실 동쪽',
        options: [{ name: '조식', qty: 1, price: 10000 }],
      }),
    ).toEqual(['dates', 'room', 'options']);
  });
});

describe('changeSummaryLabel', () => {
  it('라벨 이어붙이기', () => {
    expect(changeSummaryLabel(['dates'])).toBe('날짜 변경');
    expect(changeSummaryLabel(['dates', 'options'])).toBe('날짜·옵션 변경');
    expect(changeSummaryLabel([])).toBe('변경 없음');
  });
});
