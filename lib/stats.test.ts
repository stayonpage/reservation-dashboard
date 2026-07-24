import { describe, it, expect } from 'vitest';
import { computeStats, monthRange, getKnownOptionNames } from './stats';
import type { Reservation } from './db-types';

function makeReservation(overrides: Partial<Reservation>): Reservation {
  return {
    id: overrides.id ?? 'r1',
    channel: 'naver',
    channel_reservation_id: '1',
    guest_name: '홍길동',
    guest_phone: null,
    room_name: 'page26 - 시가 내려앉는 순간',
    check_in: '2026-07-05',
    check_out: '2026-07-06',
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

describe('monthRange', () => {
  it('해당 월 1일부터 다음달 1일 전까지(반개구간)', () => {
    expect(monthRange(2026, 6)).toEqual({ start: '2026-07-01', end: '2026-08-01' });
  });
  it('12월은 연도를 넘긴다', () => {
    expect(monthRange(2026, 11)).toEqual({ start: '2026-12-01', end: '2027-01-01' });
  });
});

describe('computeStats', () => {
  const range = { start: '2026-07-01', end: '2026-07-31' }; // 30박(7/1~7/30)

  it('취소된 예약은 매출·건수에서 제외하고 취소건수로만 집계', () => {
    const reservations = [
      makeReservation({ id: 'a', status: 'confirmed', amount: 100000, check_in: '2026-07-05', check_out: '2026-07-06' }),
      makeReservation({ id: 'b', status: 'cancelled', amount: 200000, check_in: '2026-07-10', check_out: '2026-07-11' }),
    ];
    const stats = computeStats(reservations, range);
    expect(stats.totalReservations).toBe(1);
    expect(stats.totalRevenue).toBe(100000);
    expect(stats.cancelledCount).toBe(1);
  });

  it('방별 점유율은 [체크인,체크아웃) 겹침으로, 매출은 체크인 기준으로 집계', () => {
    const reservations = [
      makeReservation({
        id: 'a',
        room_name: 'page26 - 시가 내려앉는 순간',
        check_in: '2026-07-05',
        check_out: '2026-07-08', // 3박(5,6,7)
        amount: 300000,
      }),
    ];
    const stats = computeStats(reservations, range);
    const page26 = stats.rooms.find((r) => r.code === 'page26')!;
    expect(page26.occupiedNights).toBe(3);
    expect(page26.totalNights).toBe(30);
    expect(page26.occupancyPct).toBe(10); // 3/30 = 10%
    expect(page26.revenue).toBe(300000);
    expect(page26.reservationCount).toBe(1);

    const page452 = stats.rooms.find((r) => r.code === 'page452')!;
    expect(page452.occupiedNights).toBe(0);
    expect(page452.revenue).toBe(0);
  });

  it('프로퍼티별 점유율은 소속 방들의 occupiedNights/totalNights를 합산해 계산한다', () => {
    const reservations = [
      makeReservation({
        id: 'a',
        room_name: 'page26 - 시가 내려앉는 순간',
        check_in: '2026-07-05',
        check_out: '2026-07-08', // page26 3박
      }),
      makeReservation({
        id: 'b',
        room_name: 'page452 - 지금, 나를 세우는 시간',
        check_in: '2026-07-10',
        check_out: '2026-07-11', // page452 1박
      }),
      makeReservation({
        id: 'c',
        room_name: '객실 서쪽',
        check_in: '2026-07-01',
        check_out: '2026-07-06', // 게스트 서쪽 5박
      }),
    ];
    const stats = computeStats(reservations, range);
    // 스테이 온 페이지: 4개 방 × 30박 = 120박 중 4박 참(3+1, page8·127은 0).
    const stay = stats.propertyOccupancy.find((p) => p.property === '스테이 온 페이지')!;
    expect(stay.occupiedNights).toBe(4);
    expect(stay.totalNights).toBe(120);
    expect(stay.occupancyPct).toBe(Math.round((4 / 120) * 1000) / 10);
    // 게스트하우스: 2개 방 × 30박 = 60박 중 5박 참(서쪽 5, 남쪽 0).
    const guesthouse = stats.propertyOccupancy.find((p) => p.property === '게스트하우스')!;
    expect(guesthouse.occupiedNights).toBe(5);
    expect(guesthouse.totalNights).toBe(60);
    expect(guesthouse.occupancyPct).toBe(Math.round((5 / 60) * 1000) / 10);
  });

  it('옵션별 개수·금액을 합산한다(같은 옵션명이 여러 예약에 걸쳐 나와도)', () => {
    const reservations = [
      makeReservation({
        id: 'a',
        options: [{ name: '웰컴키트', qty: 1, price: 3000 }],
      }),
      makeReservation({
        id: 'b',
        check_in: '2026-07-06',
        check_out: '2026-07-07',
        options: [{ name: '웰컴키트', qty: 2, price: 3000 }],
      }),
    ];
    const stats = computeStats(reservations, range);
    const welcome = stats.options.find((o) => o.name === '웰컴키트')!;
    expect(welcome.count).toBe(3);
    expect(welcome.revenue).toBe(9000);
  });

  it('네이버 옵션 배열에 섞여 들어온 방 기본요금 항목(이름=room_name)은 옵션 통계에서 제외한다', () => {
    const reservations = [
      makeReservation({
        id: 'a',
        room_name: 'page 127 - 별서에서 흐르는 시간',
        amount: 320000,
        options: [
          { name: 'page 127 - 별서에서 흐르는 시간', qty: 1, price: 290000 }, // 방값 그 자체 — 제외 대상
          { name: '북크닉_127페이지전용', qty: 1, price: 30000 }, // 진짜 옵션 — 포함
        ],
      }),
    ];
    const stats = computeStats(reservations, range);
    expect(stats.options.find((o) => o.name === 'page 127 - 별서에서 흐르는 시간')).toBeUndefined();
    const bookNic = stats.options.find((o) => o.name === '북크닉_127페이지전용')!;
    expect(bookNic.revenue).toBe(30000);
    expect(bookNic.count).toBe(1);
    // 방별 매출(r.amount 기준)은 영향 안 받는다 — 320,000 그대로.
    expect(stats.rooms.find((r) => r.code === 'page127')!.revenue).toBe(320000);
  });

  it('채널별로 건수·매출을 나눈다', () => {
    const reservations = [
      makeReservation({ id: 'a', channel: 'naver', amount: 100000 }),
      makeReservation({ id: 'b', channel: 'stayfolio', amount: 200000, check_in: '2026-07-06', check_out: '2026-07-07' }),
    ];
    const stats = computeStats(reservations, range);
    expect(stats.channels.find((c) => c.channel === 'naver')!.revenue).toBe(100000);
    expect(stats.channels.find((c) => c.channel === 'stayfolio')!.revenue).toBe(200000);
    expect(stats.channels.find((c) => c.channel === 'imweb')!.revenue).toBe(0);
  });

  it('스테이 온 페이지 / 게스트하우스로 나눈 매출과 합산(grandTotal)이 일치한다', () => {
    const reservations = [
      makeReservation({ id: 'a', room_name: 'page26 - 시가 내려앉는 순간', amount: 100000 }),
      makeReservation({
        id: 'b',
        room_name: '객실 서쪽',
        amount: 150000,
        check_in: '2026-07-06',
        check_out: '2026-07-07',
      }),
    ];
    const stats = computeStats(reservations, range);
    const stay = stats.properties.find((p) => p.property === '스테이 온 페이지')!;
    const guesthouse = stats.properties.find((p) => p.property === '게스트하우스')!;
    expect(stay.revenue).toBe(100000);
    expect(guesthouse.revenue).toBe(150000);
    expect(stats.grandTotal).toBe(250000);
    expect(stats.totalRevenue).toBe(250000);
  });

  it('일별 매출은 체크인일 기준으로 그날 합계만 잡힌다', () => {
    const reservations = [
      makeReservation({ id: 'a', check_in: '2026-07-05', check_out: '2026-07-06', amount: 50000 }),
      makeReservation({ id: 'b', check_in: '2026-07-05', check_out: '2026-07-06', amount: 70000 }),
    ];
    const stats = computeStats(reservations, range);
    const day = stats.dailyRevenue.find((d) => d.date === '2026-07-05')!;
    expect(day.revenue).toBe(120000);
    const otherDay = stats.dailyRevenue.find((d) => d.date === '2026-07-06')!;
    expect(otherDay.revenue).toBe(0);
  });

  it('예약이 없으면 평균금액은 0(0으로 나누지 않는다)', () => {
    const stats = computeStats([], range);
    expect(stats.averageAmount).toBe(0);
    expect(stats.totalRevenue).toBe(0);
  });
});

describe('getKnownOptionNames', () => {
  it('기간 제한 없이 전체 예약에서 옵션명 등장 횟수를 세고, 많이 나온 순으로 정렬한다', () => {
    const reservations = [
      makeReservation({
        id: 'a',
        options: [
          { name: '웰컴키트', qty: 1, price: 3000 },
          { name: '조식_멋진하루 1인', qty: 1, price: 12000 },
        ],
      }),
      makeReservation({
        id: 'b',
        options: [{ name: '웰컴키트', qty: 2, price: 3000 }],
      }),
      makeReservation({
        id: 'c',
        options: [{ name: '웰컴키트', qty: 1, price: 3000 }],
      }),
    ];
    const known = getKnownOptionNames(reservations);
    expect(known[0]).toEqual({ name: '웰컴키트', count: 3 });
    expect(known[1]).toEqual({ name: '조식_멋진하루 1인', count: 1 });
  });

  it('방 기본요금이 옵션 배열에 섞여 들어온 항목(이름=room_name)은 제외한다', () => {
    const reservations = [
      makeReservation({
        id: 'a',
        room_name: 'page26 - 시가 내려앉는 순간',
        options: [
          { name: 'page26 - 시가 내려앉는 순간', qty: 1, price: 260000 },
          { name: '북크닉_127페이지전용', qty: 1, price: 30000 },
        ],
      }),
    ];
    const known = getKnownOptionNames(reservations);
    expect(known.find((o) => o.name === 'page26 - 시가 내려앉는 순간')).toBeUndefined();
    expect(known.find((o) => o.name === '북크닉_127페이지전용')).toEqual({
      name: '북크닉_127페이지전용',
      count: 1,
    });
  });

  it('예약이 없으면 빈 배열', () => {
    expect(getKnownOptionNames([])).toEqual([]);
  });

  it('취소된 예약의 옵션은 제외한다(취소 메일 특유의 파싱 잡음도 같이 걸러짐)', () => {
    const reservations = [
      makeReservation({ id: 'a', status: 'cancelled', options: [{ name: '노이즈옵션', qty: 1, price: 0 }] }),
      makeReservation({ id: 'b', status: 'confirmed', options: [{ name: '웰컴키트', qty: 1, price: 3000 }] }),
    ];
    const known = getKnownOptionNames(reservations);
    expect(known.find((o) => o.name === '노이즈옵션')).toBeUndefined();
    expect(known.find((o) => o.name === '웰컴키트')).toEqual({ name: '웰컴키트', count: 1 });
  });
});
