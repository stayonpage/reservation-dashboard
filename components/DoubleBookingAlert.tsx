'use client';

import type { Reservation } from '../lib/db-types';
import { CHANNEL_LABEL } from '../lib/db-types';
import { formatDateRange, formatWon } from '../lib/format';
import { findRoomConflicts } from '../lib/conflicts';

// 같은 방에 겹치는 예약이 2건 이상일 때만 뜨는 경고 — 평소엔 아예 렌더링 안 됨.
// 대시보드 맨 위에 둬서 다른 무엇보다 먼저 보이게 한다(돈·손님 신뢰 직결 문제라 최우선).

export function DoubleBookingAlert({
  reservations,
  onCancelReservation,
}: {
  reservations: Reservation[];
  onCancelReservation: (reservationId: string) => void;
}) {
  const conflicts = findRoomConflicts(reservations);
  if (conflicts.length === 0) return null;

  const handleCancel = (r: Reservation) => {
    if (
      window.confirm(
        `${r.guest_name ?? '이 손님'} · ${formatDateRange(r.check_in, r.check_out)} 예약을 취소할까요?`,
      )
    ) {
      onCancelReservation(r.id);
    }
  };

  return (
    <section className="conflict-alert">
      <div className="conflict-alert-title">
        중복 예약 감지 — {conflicts.length}건
      </div>
      {conflicts.map((c) => (
        <div key={c.roomCode} className="conflict-card">
          <div className="conflict-room">{c.roomLabel}</div>
          {c.reservations.map((r) => (
            <div key={r.id} className="conflict-row">
              <div className="conflict-info">
                <strong>{r.guest_name ?? '이름 미상'}</strong> · {CHANNEL_LABEL[r.channel]} ·{' '}
                {formatDateRange(r.check_in, r.check_out)} · {formatWon(r.amount)}
              </div>
              <button
                type="button"
                className="conflict-cancel-btn"
                onClick={() => handleCancel(r)}
              >
                이 예약 취소
              </button>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
