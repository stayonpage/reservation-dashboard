import { describe, it, expect } from 'vitest';
import {
  isTodayPageSellableDate,
  datesInRange,
  findFullTodayPageDates,
} from './today-page-occupancy';
import type { Reservation } from './db-types';

function makeReservation(
  roomName: string,
  checkIn: string,
  checkOut: string,
  status: Reservation['status'] = 'confirmed',
): Pick<Reservation, 'room_name' | 'check_in' | 'check_out' | 'status'> {
  return { room_name: roomName, check_in: checkIn, check_out: checkOut, status };
}

describe('isTodayPageSellableDate', () => {
  it('월~목만 true', () => {
    expect(isTodayPageSellableDate('2026-10-04')).toBe(false); // 일
    expect(isTodayPageSellableDate('2026-10-05')).toBe(true); // 월
    expect(isTodayPageSellableDate('2026-10-06')).toBe(true); // 화
    expect(isTodayPageSellableDate('2026-10-07')).toBe(true); // 수
    expect(isTodayPageSellableDate('2026-10-08')).toBe(true); // 목
    expect(isTodayPageSellableDate('2026-10-09')).toBe(false); // 금
    expect(isTodayPageSellableDate('2026-10-10')).toBe(false); // 토
  });
});

describe('datesInRange', () => {
  it('체크인 포함, 체크아웃 제외', () => {
    expect(datesInRange('2026-10-06', '2026-10-09')).toEqual([
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ]);
  });
});

describe('findFullTodayPageDates', () => {
  it('4개 객실이 전부 찬 날짜만 반환한다', () => {
    const reservations = [
      makeReservation('page26 - 책1', '2026-10-06', '2026-10-08'),
      makeReservation('page452 - 책2', '2026-10-06', '2026-10-08'),
      makeReservation('page8', '2026-10-06', '2026-10-08'),
      makeReservation('page127', '2026-10-06', '2026-10-07'), // 10/7엔 없음
    ];
    const result = findFullTodayPageDates(reservations, ['2026-10-06', '2026-10-07']);
    expect(result).toEqual(['2026-10-06']);
  });

  it('취소된 예약은 점유로 안 친다', () => {
    const reservations = [
      makeReservation('page26', '2026-10-06', '2026-10-08'),
      makeReservation('page452', '2026-10-06', '2026-10-08'),
      makeReservation('page8', '2026-10-06', '2026-10-08'),
      makeReservation('page127', '2026-10-06', '2026-10-08', 'cancelled'),
    ];
    const result = findFullTodayPageDates(reservations, ['2026-10-06']);
    expect(result).toEqual([]);
  });

  it('겹치는 날짜 없으면 빈 배열', () => {
    const result = findFullTodayPageDates([], ['2026-10-06']);
    expect(result).toEqual([]);
  });
});
