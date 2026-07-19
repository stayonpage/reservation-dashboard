import { describe, it, expect } from 'vitest';
import { findRoomConflicts } from './conflicts';
import type { Reservation } from './db-types';

function makeReservation(overrides: Partial<Reservation>): Reservation {
  return {
    id: overrides.id ?? 'r1',
    channel: 'naver',
    channel_reservation_id: '1',
    guest_name: '홍길동',
    guest_phone: null,
    room_name: 'page 127 - 별서에서 흐르는 시간',
    check_in: '2026-07-25',
    check_out: '2026-07-26',
    amount: 100000,
    options: [],
    payment_method: 'unknown',
    payment_status: 'pending',
    status: 'confirmed',
    deposit_confirmed_by: null,
    deposit_confirmed_at: null,
    confirmed_by: null,
    confirmed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    detected_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    notes: null,
    ...overrides,
  };
}

describe('findRoomConflicts', () => {
  it('같은 방·겹치는 날짜에 예약 2건이면 충돌로 잡는다(실사례: page127, 7/25~26 두 손님)', () => {
    const reservations = [
      makeReservation({ id: 'a', guest_name: '김*석', status: 'awaiting_deposit' }),
      makeReservation({ id: 'b', guest_name: '허*영', status: 'confirmed' }),
    ];
    const conflicts = findRoomConflicts(reservations);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].roomCode).toBe('page127');
    expect(conflicts[0].reservations.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('다른 방이면 겹쳐도 충돌 아님', () => {
    const reservations = [
      makeReservation({ id: 'a', room_name: 'page26 - 시가 내려앉는 순간' }),
      makeReservation({ id: 'b', room_name: 'page 8 - 숨결같은 선율에 머무는 하루' }),
    ];
    expect(findRoomConflicts(reservations)).toHaveLength(0);
  });

  it('같은 방이어도 날짜가 안 겹치면 충돌 아님', () => {
    const reservations = [
      makeReservation({ id: 'a', check_in: '2026-07-25', check_out: '2026-07-26' }),
      makeReservation({ id: 'b', check_in: '2026-07-26', check_out: '2026-07-27' }), // 체크아웃=체크인, 안 겹침
    ];
    expect(findRoomConflicts(reservations)).toHaveLength(0);
  });

  it('취소된 예약은 충돌 판정에서 제외한다', () => {
    const reservations = [
      makeReservation({ id: 'a', status: 'cancelled' }),
      makeReservation({ id: 'b', status: 'confirmed' }),
    ];
    expect(findRoomConflicts(reservations)).toHaveLength(0);
  });

  it('한 예약뿐이면 충돌 없음', () => {
    expect(findRoomConflicts([makeReservation({ id: 'a' })])).toHaveLength(0);
  });
});
