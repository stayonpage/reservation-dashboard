'use client';

import type { Reservation } from '../lib/db-types';
import { CHANNEL_LABEL } from '../lib/db-types';
import { formatDateShort, formatOptions, stayNightLabel } from '../lib/format';

// 달력(월간, 클릭해야 상세 보임)과 전체예약(옵션까지 다 보려면 스크롤 많이 필요) 사이의
// 빠른 훑어보기 용도 — 오늘부터 7일간, 클릭 없이 옵션까지 한 번에 다 보이게.

function toISODate(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDaysIso(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  d.setDate(d.getDate() + days);
  return toISODate(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayOfWeek(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00+09:00').getDay();
}

// 체크아웃 당일은 비운 것으로 취급 — 달력·입금큐 등 다른 곳과 동일한 규칙.
function isOccupied(checkIn: string, checkOut: string, date: string): boolean {
  return checkIn <= date && date < checkOut;
}

export function WeeklyOverview({
  reservations,
  id,
}: {
  reservations: Reservation[];
  id?: string;
}) {
  const now = new Date();
  const todayIso = toISODate(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(todayIso, i));

  const active = reservations.filter((r) => r.status !== 'cancelled');

  return (
    <section id={id}>
      <div className="section-title">
        <h2>일주일 예약</h2>
      </div>

      {days.map((date) => {
        const dayReservations = active
          .filter((r) => isOccupied(r.check_in, r.check_out, date))
          .sort((a, b) => (a.room_name ?? '').localeCompare(b.room_name ?? ''));

        const dow = dayOfWeek(date);
        const dowCls = dow === 0 ? 'sun' : dow === 6 ? 'sat' : '';

        return (
          <div key={date} className="week-day">
            <div className={`week-day-title ${dowCls}`}>
              {formatDateShort(date)}
              {date === todayIso && <span className="week-today-tag">오늘</span>}
            </div>
            {dayReservations.length === 0 ? (
              <div className="week-day-empty">예약 없음</div>
            ) : (
              dayReservations.map((r) => {
                const night = stayNightLabel(r.check_in, r.check_out, date);
                return (
                  <div key={r.id} className="week-res-row">
                    <div className="week-res-main">
                      <strong>{r.room_name}</strong> · {r.guest_name ?? '이름 미상'} ·{' '}
                      {CHANNEL_LABEL[r.channel]}
                      {night && <span className="week-res-night"> · {night}</span>}
                    </div>
                    {r.options.length > 0 && (
                      <div className="week-res-options">{formatOptions(r.options)}</div>
                    )}
                    {r.notes && <div className="week-res-notes">비고: {r.notes}</div>}
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </section>
  );
}
