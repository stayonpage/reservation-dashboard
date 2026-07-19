'use client';

import { useState } from 'react';
import type { Reservation, BlockTask } from '../lib/db-types';
import { ChannelBadge, StatusBadge } from './Badges';
import { formatWon, formatDateRange, timeAgo, formatOptions } from '../lib/format';
import type { ReservationStatus } from '../lib/types';

// 3채널 통합 리스트 뷰. (캘린더 뷰는 v1 후속 — 지금은 날짜순 리스트로 통합 확인 니즈를 충족)

const TABS: { key: ReservationStatus | 'all'; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'new', label: '신규' },
  { key: 'awaiting_deposit', label: '입금대기' },
  { key: 'confirmed', label: '확정' },
  { key: 'cancelled', label: '취소' },
];

export function ReservationList({
  reservations,
  blockTasks,
  id,
}: {
  reservations: Reservation[];
  blockTasks: BlockTask[];
  id?: string;
}) {
  const [tab, setTab] = useState<ReservationStatus | 'all'>('all');

  const pendingBlocksByReservation = new Map<string, number>();
  for (const t of blockTasks) {
    if (t.status !== 'done' && t.reservation_id !== null) {
      pendingBlocksByReservation.set(
        t.reservation_id,
        (pendingBlocksByReservation.get(t.reservation_id) ?? 0) + 1,
      );
    }
  }

  const filtered = reservations
    .filter((r) => tab === 'all' || r.status === tab)
    .sort((a, b) => a.check_in.localeCompare(b.check_in));

  return (
    <section id={id}>
      <div className="section-title">
        <h2>전체 예약</h2>
        <span className="count-pill">{filtered.length}건</span>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">해당하는 예약 없음</div>
      ) : (
        filtered.map((r) => {
          const pendingBlocks = pendingBlocksByReservation.get(r.id) ?? 0;
          return (
            <div key={r.id} className="card">
              <div className="card-top">
                <div>
                  <div className="card-title">
                    {r.guest_name ?? '이름 미상'} · {formatDateRange(r.check_in, r.check_out)}
                  </div>
                  <div className="card-meta">
                    {r.room_name}
                    <br />
                    감지 {timeAgo(r.detected_at)}
                    {pendingBlocks > 0 && ` · 막을 채널 ${pendingBlocks}곳 남음`}
                    {r.options.length > 0 && (
                      <>
                        <br />
                        옵션: {formatOptions(r.options)}
                      </>
                    )}
                  </div>
                </div>
                <div className="amount">{formatWon(r.amount)}</div>
              </div>
              <div className="badge-row">
                <ChannelBadge channel={r.channel} />
                <StatusBadge status={r.status} />
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
