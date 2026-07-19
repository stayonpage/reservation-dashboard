'use client';

import { useMemo, useState } from 'react';
import type { Reservation } from '../lib/db-types';
import { CHANNEL_LABEL } from '../lib/db-types';
import { CHANNEL_COLOR } from './Badges';
import { computeStats, monthRange, type DateRange } from '../lib/stats';
import { formatWon, kstNow } from '../lib/format';

// 기간(월 또는 커스텀) 통계 — 방별 점유율/매출, 옵션별, 채널별, 프로퍼티(스테이/게스트하우스)별
// 매출과 합산, 일별 매출 그래프까지 한 화면에서. 계산은 lib/stats.ts(순수 함수, 테스트됨).

function BarRow({
  label,
  value,
  valueLabel,
  max,
  color,
}: {
  label: string;
  value: number;
  valueLabel: string;
  max: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0;
  return (
    <div className="stat-bar-row">
      <span className="stat-bar-label">{label}</span>
      <span className="stat-bar-track">
        <span
          className="stat-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
      <span className="stat-bar-value">{valueLabel}</span>
    </div>
  );
}

export function Statistics({ reservations, id }: { reservations: Reservation[]; id?: string }) {
  // "이번 달"은 한국시간 기준(서버 SSR이 UTC여도 동일하게) — kstNow는 getUTC* 게터로만 읽는다.
  const today = kstNow();
  const [mode, setMode] = useState<'month' | 'custom'>('month');
  const [cursor, setCursor] = useState({ y: today.getUTCFullYear(), m: today.getUTCMonth() });
  const [customStart, setCustomStart] = useState(
    () => monthRange(today.getUTCFullYear(), today.getUTCMonth()).start,
  );
  const [customEnd, setCustomEnd] = useState(
    () => monthRange(today.getUTCFullYear(), today.getUTCMonth()).end,
  );

  const range: DateRange =
    mode === 'month' ? monthRange(cursor.y, cursor.m) : { start: customStart, end: customEnd };

  const stats = useMemo(() => computeStats(reservations, range), [reservations, range]);

  const maxRoomOccupancy = 100;
  const maxRoomRevenue = Math.max(1, ...stats.rooms.map((r) => r.revenue));
  const maxOptionRevenue = Math.max(1, ...stats.options.map((o) => o.revenue));
  const maxChannelRevenue = Math.max(1, ...stats.channels.map((c) => c.revenue));
  const maxDailyRevenue = Math.max(1, ...stats.dailyRevenue.map((d) => d.revenue));

  return (
    <section id={id}>
      <div className="section-title">
        <h2>통계</h2>
      </div>

      <div className="stat-mode-row">
        <button
          type="button"
          className={`tab ${mode === 'month' ? 'active' : ''}`}
          onClick={() => setMode('month')}
        >
          월별
        </button>
        <button
          type="button"
          className={`tab ${mode === 'custom' ? 'active' : ''}`}
          onClick={() => setMode('custom')}
        >
          기간 직접 설정
        </button>
      </div>

      {mode === 'month' ? (
        <div className="cal-nav">
          <button
            type="button"
            onClick={() =>
              setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }))
            }
            aria-label="이전 달"
          >
            ‹
          </button>
          <div className="cal-month">
            {cursor.y}년 {cursor.m + 1}월
          </div>
          <button
            type="button"
            onClick={() =>
              setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }))
            }
            aria-label="다음 달"
          >
            ›
          </button>
        </div>
      ) : (
        <div className="stat-range-row">
          <input
            type="date"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            className="stat-date-input"
          />
          <span>~</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="stat-date-input"
          />
        </div>
      )}

      {/* 요약 카드 */}
      <div className="stat-cards">
        {stats.properties.map((p) => (
          <div key={p.property} className="stat-card">
            <div className="stat-card-label">{p.property}</div>
            <div className="stat-card-value">{formatWon(p.revenue)}</div>
            <div className="stat-card-sub">{p.reservationCount}건</div>
          </div>
        ))}
        <div className="stat-card highlight">
          <div className="stat-card-label">합계(전체)</div>
          <div className="stat-card-value">{formatWon(stats.grandTotal)}</div>
          <div className="stat-card-sub">{stats.totalReservations}건</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">평균 예약금액</div>
          <div className="stat-card-value">{formatWon(stats.averageAmount)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">취소</div>
          <div className="stat-card-value">{stats.cancelledCount}건</div>
        </div>
      </div>

      {/* 일별 매출 그래프 */}
      <div className="stat-block">
        <div className="stat-block-title">일별 매출 추이</div>
        <div className="stat-daily-chart">
          {stats.dailyRevenue.map((d) => (
            <div
              key={d.date}
              className="stat-daily-bar"
              style={{
                height: `${Math.max((d.revenue / maxDailyRevenue) * 100, d.revenue > 0 ? 3 : 1)}%`,
              }}
              title={`${d.date}: ${formatWon(d.revenue)}`}
            />
          ))}
        </div>
        <div className="stat-daily-range">
          <span>{range.start}</span>
          <span>~</span>
          <span>{range.end}</span>
        </div>
      </div>

      {/* 방별: 점유율 + 매출 */}
      <div className="stat-block">
        <div className="stat-block-title">방별 점유율</div>
        {stats.rooms.map((r) => (
          <BarRow
            key={r.code}
            label={r.label}
            value={r.occupancyPct}
            valueLabel={`${r.occupancyPct}% (${r.occupiedNights}/${r.totalNights}박)`}
            max={maxRoomOccupancy}
          />
        ))}
      </div>

      <div className="stat-block">
        <div className="stat-block-title">방별 매출</div>
        {stats.rooms.map((r) => (
          <BarRow
            key={r.code}
            label={r.label}
            value={r.revenue}
            valueLabel={`${formatWon(r.revenue)} (${r.reservationCount}건)`}
            max={maxRoomRevenue}
          />
        ))}
      </div>

      {/* 채널별 */}
      <div className="stat-block">
        <div className="stat-block-title">채널별 매출</div>
        {stats.channels.map((c) => (
          <BarRow
            key={c.channel}
            label={CHANNEL_LABEL[c.channel]}
            value={c.revenue}
            valueLabel={`${formatWon(c.revenue)} (${c.count}건)`}
            max={maxChannelRevenue}
            color={CHANNEL_COLOR[c.channel]}
          />
        ))}
      </div>

      {/* 옵션별 */}
      <div className="stat-block">
        <div className="stat-block-title">옵션별 매출</div>
        {stats.options.length === 0 ? (
          <div className="empty">해당 기간 옵션 없음</div>
        ) : (
          stats.options.map((o) => (
            <BarRow
              key={o.name}
              label={o.name}
              value={o.revenue}
              valueLabel={`${formatWon(o.revenue)} (${o.count}개)`}
              max={maxOptionRevenue}
            />
          ))
        )}
      </div>
    </section>
  );
}
