'use client';

import type { Reservation } from '../lib/db-types';
import { formatDateShort } from '../lib/format';
import { kstTodayISO } from '../lib/format';
import {
  datesInRange,
  findFullTodayPageDates,
  isTodayPageSellableDate,
} from '../lib/today-page-occupancy';

// "오늘의 페이지"(월~목 전용 가상 객실) 대상 날짜가 실제 4개 객실로 이미 다 찬 경우 —
// 아임웹엔 API 연동이 없어 자동으로 못 막으니, 대시보드를 열 때마다 바로 보이게 경고한다.
// 평소엔 아예 렌더링 안 됨(DoubleBookingAlert와 같은 패턴).

const LOOKAHEAD_DAYS = 90; // 아임웹 예약 가능 기간과 맞춤.

export function TodayPageBlockAlert({ reservations }: { reservations: Reservation[] }) {
  const today = kstTodayISO();
  const future = new Date(today + 'T00:00:00Z');
  future.setUTCDate(future.getUTCDate() + LOOKAHEAD_DAYS);
  const candidateDates = datesInRange(today, future.toISOString().slice(0, 10)).filter(
    isTodayPageSellableDate,
  );

  const fullDates = findFullTodayPageDates(reservations, candidateDates);
  if (fullDates.length === 0) return null;

  return (
    <section className="today-page-alert">
      <div className="today-page-alert-title">
        오늘의 페이지 수동 차단 필요 — {fullDates.length}건
      </div>
      <div className="today-page-alert-dates">
        아임웹에서 지금 막아주세요: {fullDates.map(formatDateShort).join(', ')}
      </div>
    </section>
  );
}
