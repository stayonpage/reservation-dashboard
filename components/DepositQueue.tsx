'use client';

import type { Reservation } from '../lib/db-types';
import { ChannelBadge } from './Badges';
import { formatWon, formatDateRange, timeAgo, formatOptions } from '../lib/format';

// 입금확인→확정 큐. 현금/미결제 예약만 대상(카드 선결제는 이미 confirmed로 여기 안 옴).
// 오래 미처리된 건은 강조 — 돈이 걸린 최고위험 지점이라 눈에 띄어야 한다.
// 상태는 부모(DashboardRealtime)가 소유 — 이 컴포넌트는 순수 표시 + onConfirm 콜백만.
const URGENT_AFTER_HOURS = 2;

export function DepositQueue({
  reservations,
  onConfirm,
  now = new Date(),
  id,
}: {
  reservations: Reservation[];
  onConfirm: (reservationId: string) => void;
  now?: Date;
  id?: string;
}) {
  const pending = reservations
    .filter((r) => r.status === 'awaiting_deposit')
    .sort((a, b) => a.detected_at.localeCompare(b.detected_at)); // 오래된 것 먼저

  return (
    <section id={id}>
      <div className="section-title">
        <h2>입금확인 대기</h2>
        <span className="count-pill">{pending.length}건</span>
      </div>

      {pending.length === 0 ? (
        <div className="empty">대기 중인 입금확인 건 없음</div>
      ) : (
        pending.map((r) => {
          const hoursWaiting =
            (now.getTime() - new Date(r.detected_at).getTime()) / 3_600_000;
          const urgent = hoursWaiting >= URGENT_AFTER_HOURS;

          return (
            <div key={r.id} className={`card ${urgent ? 'urgent' : ''}`}>
              <div className="card-top">
                <div>
                  <div className="card-title">
                    {r.guest_name ?? '이름 미상'} · {formatDateRange(r.check_in, r.check_out)}
                  </div>
                  <div className="card-meta">
                    {r.room_name}
                    <br />
                    감지 {timeAgo(r.detected_at, now)}
                    {urgent && ' · 확인 지연'}
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
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => onConfirm(r.id)}
                >
                  입금확인 → 확정
                </button>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
