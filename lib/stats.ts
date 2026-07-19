// 통계 계산 — 순수 함수(화면 로직과 분리, 테스트 용이). 화면(components/Statistics.tsx)은
// 이 결과만 그려준다.

import type { Reservation } from './db-types';
import type { Channel } from './types';
import { ROOMS, roomCodeOf } from './rooms';

export interface DateRange {
  start: string; // 'YYYY-MM-DD' 포함
  end: string; // 'YYYY-MM-DD' 미포함(반개구간) — 캘린더·일주일예약과 동일 규칙
}

export interface RoomStat {
  code: string;
  label: string;
  property: string;
  occupiedNights: number;
  totalNights: number;
  occupancyPct: number; // 0~100
  revenue: number;
  reservationCount: number;
}

export interface OptionStat {
  name: string;
  count: number;
  revenue: number;
}

export interface ChannelStat {
  channel: Channel;
  count: number;
  revenue: number;
}

export interface PropertyStat {
  property: string;
  revenue: number;
  reservationCount: number;
}

export interface DailyRevenue {
  date: string;
  revenue: number;
}

export interface StatsSummary {
  range: DateRange;
  totalReservations: number;
  totalRevenue: number;
  cancelledCount: number;
  averageAmount: number;
  rooms: RoomStat[];
  options: OptionStat[];
  channels: ChannelStat[];
  properties: PropertyStat[];
  grandTotal: number; // properties 합산(= totalRevenue와 같음 — 명시적으로 노출)
  dailyRevenue: DailyRevenue[];
}

function listDates(range: DateRange): string[] {
  const dates: string[] = [];
  let d = range.start;
  while (d < range.end) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isOccupied(checkIn: string, checkOut: string, date: string): boolean {
  return checkIn <= date && date < checkOut;
}

// 매출 귀속 기준: 체크인일이 조회 기간에 속하는 예약만 집계(호텔 매출 리포트의 일반적 관행 —
// 숙박이 기간 경계를 넘나드는 경우 부분귀속하지 않고 "이 기간에 잡힌 예약"으로 단순화).
// 방별 점유율만 예외 — 그건 날짜별로 실제 차 있는지를 봐야 하므로 체크인 기준이 아니라
// [check_in, check_out) 겹침으로 계산한다.
export function computeStats(
  reservations: Reservation[],
  range: DateRange,
): StatsSummary {
  const dates = listDates(range);
  const totalNights = dates.length;

  const nonCancelled = reservations.filter((r) => r.status !== 'cancelled');
  const cancelledCount = reservations.filter(
    (r) => r.status === 'cancelled' && r.check_in >= range.start && r.check_in < range.end,
  ).length;

  // 매출 집계 대상: 체크인이 기간 안, 취소 아님.
  const inPeriod = nonCancelled.filter(
    (r) => r.check_in >= range.start && r.check_in < range.end,
  );

  // --- 방별: 점유율은 날짜별 겹침, 매출/건수는 체크인 기준. ---
  const rooms: RoomStat[] = ROOMS.map((room) => {
    const occupiedNights = dates.filter((date) =>
      nonCancelled.some(
        (r) => roomCodeOf(r.room_name) === room.code && isOccupied(r.check_in, r.check_out, date),
      ),
    ).length;
    const roomReservations = inPeriod.filter((r) => roomCodeOf(r.room_name) === room.code);
    return {
      code: room.code,
      label: room.label,
      property: room.property,
      occupiedNights,
      totalNights,
      occupancyPct: totalNights > 0 ? Math.round((occupiedNights / totalNights) * 1000) / 10 : 0,
      revenue: roomReservations.reduce((sum, r) => sum + (r.amount ?? 0), 0),
      reservationCount: roomReservations.length,
    };
  });

  // --- 옵션별. ---
  // 네이버 파서(lib/parsers/naver.ts)는 결제내역 문자열을 '+'로 쪼개면서 방 기본요금 항목도
  // options 배열에 함께 담는다(이름이 그 예약의 room_name과 완전히 같음) — 진짜 추가옵션이
  // 아니라 방값 그 자체이므로 옵션 통계에서는 제외해야 이중 집계가 안 생긴다.
  const optionMap = new Map<string, { count: number; revenue: number }>();
  for (const r of inPeriod) {
    for (const o of r.options) {
      if (o.name === r.room_name) continue;
      const cur = optionMap.get(o.name) ?? { count: 0, revenue: 0 };
      cur.count += o.qty;
      cur.revenue += o.price * o.qty;
      optionMap.set(o.name, cur);
    }
  }
  const options: OptionStat[] = [...optionMap.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.revenue - a.revenue);

  // --- 채널별. ---
  const channelOrder: Channel[] = ['naver', 'stayfolio', 'imweb'];
  const channels: ChannelStat[] = channelOrder.map((channel) => {
    const rs = inPeriod.filter((r) => r.channel === channel);
    return {
      channel,
      count: rs.length,
      revenue: rs.reduce((sum, r) => sum + (r.amount ?? 0), 0),
    };
  });

  // --- 프로퍼티별(스테이 온 페이지 vs 게스트하우스) + 합산. ---
  const propertyNames = [...new Set(ROOMS.map((r) => r.property))];
  const properties: PropertyStat[] = propertyNames.map((property) => {
    const codesInProperty = ROOMS.filter((r) => r.property === property).map((r) => r.code);
    const rs = inPeriod.filter((r) => codesInProperty.includes(roomCodeOf(r.room_name) ?? ''));
    return {
      property,
      revenue: rs.reduce((sum, r) => sum + (r.amount ?? 0), 0),
      reservationCount: rs.length,
    };
  });

  const totalRevenue = inPeriod.reduce((sum, r) => sum + (r.amount ?? 0), 0);

  // --- 일별 매출(그래프용). ---
  const dailyRevenue: DailyRevenue[] = dates.map((date) => ({
    date,
    revenue: inPeriod
      .filter((r) => r.check_in === date)
      .reduce((sum, r) => sum + (r.amount ?? 0), 0),
  }));

  return {
    range,
    totalReservations: inPeriod.length,
    totalRevenue,
    cancelledCount,
    averageAmount: inPeriod.length > 0 ? Math.round(totalRevenue / inPeriod.length) : 0,
    rooms,
    options,
    channels,
    properties,
    grandTotal: properties.reduce((sum, p) => sum + p.revenue, 0),
    dailyRevenue,
  };
}

export interface OptionFrequency {
  name: string;
  count: number; // 이 옵션명이 등장한 예약 건수 — 수동입력 폼의 "자주 쓰는 옵션" 빠른선택용
}

// 하드코딩된 옵션 목록이 아니라 실제 예약 데이터에서 매번 다시 뽑는다 — 그래야 새로 파싱된
// 옵션명(예: 아임웹에 새 추가상품이 생김)이 코드 수정 없이 바로 반영된다.
// 기간 제한 없이 전체 예약을 본다(수동입력은 언제든 쓸 수 있어야 하므로).
// 취소된 예약은 제외 — computeStats와 동일 규칙(취소 메일 파싱 특유의 잡음도 자연히 걸러짐).
export function getKnownOptionNames(reservations: Reservation[]): OptionFrequency[] {
  const freq = new Map<string, number>();
  for (const r of reservations) {
    if (r.status === 'cancelled') continue;
    for (const o of r.options) {
      if (o.name === r.room_name) continue; // 방값 항목 제외 — computeStats와 동일 규칙
      freq.set(o.name, (freq.get(o.name) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** 이번 달 1일 ~ 다음달 1일(반개구간). */
export function monthRange(year: number, month0: number): DateRange {
  const start = `${year}-${String(month0 + 1).padStart(2, '0')}-01`;
  const nextMonth = month0 === 11 ? { y: year + 1, m: 0 } : { y: year, m: month0 + 1 };
  const end = `${nextMonth.y}-${String(nextMonth.m + 1).padStart(2, '0')}-01`;
  return { start, end };
}
