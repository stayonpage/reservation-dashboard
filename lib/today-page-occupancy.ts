// "오늘의 페이지"(아임웹 가상 객실, 월~목 전용)가 실제로는 4개 객실(page26/452/8/127)이
// 전부 찬 날짜에 추가로 들어올 수 있다 — 아임웹엔 수동으로 그 날짜를 막아야 한다는 뜻.
// 이 계산은 순수 함수로 분리해 이메일 알림(lib/today-page-alert.ts)과 대시보드 배너
// (components/TodayPageBlockAlert.tsx) 둘 다에서 똑같이 재사용한다.

import type { Reservation } from './db-types';
import { roomCodeOf } from './rooms';

export const TODAY_PAGE_ROOM_CODES = ['page26', 'page452', 'page8', 'page127'];

/** "오늘의 페이지"는 월~목요일만 판매하는 가상 객실이다(사장님 확인, 2026-10-02). */
export function isTodayPageSellableDate(iso: string): boolean {
  const dow = new Date(iso + 'T00:00:00Z').getUTCDay(); // 0=일 ... 6=토
  return dow >= 1 && dow <= 4;
}

/** [checkIn, checkOut) 사이 날짜를 'YYYY-MM-DD' 문자열로 나열(체크인 포함, 체크아웃 제외). */
export function datesInRange(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  let d = new Date(checkIn + 'T00:00:00Z');
  const end = new Date(checkOut + 'T00:00:00Z');
  while (d < end) {
    dates.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86_400_000);
  }
  return dates;
}

/**
 * candidateDates 중, 4개 page 객실(page26/452/8/127)에 활성 예약(status≠cancelled)이
 * 전부 걸려 있는 날짜만 추려서 반환한다 — "오늘의 페이지"를 더 받으면 안 되는 날짜.
 */
export function findFullTodayPageDates(
  reservations: Pick<Reservation, 'room_name' | 'check_in' | 'check_out' | 'status'>[],
  candidateDates: string[],
): string[] {
  const active = reservations.filter((r) => r.status !== 'cancelled');

  const result: string[] = [];
  for (const iso of candidateDates) {
    const occupied = new Set<string>();
    for (const r of active) {
      if (r.check_in <= iso && iso < r.check_out) {
        const code = roomCodeOf(r.room_name);
        if (code && TODAY_PAGE_ROOM_CODES.includes(code)) occupied.add(code);
      }
    }
    if (TODAY_PAGE_ROOM_CODES.every((c) => occupied.has(c))) result.push(iso);
  }
  return result;
}
