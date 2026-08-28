'use client';

import type { ReservationChange } from '../lib/db-types';
import { ChannelBadge } from './Badges';
import { formatWon, formatDateRange } from '../lib/format';
import { displayRoomName } from '../lib/rooms';
import { refundForChange } from '../lib/refund';
import { changedFields, changeSummaryLabel } from '../lib/reservation-change';

// 예약 변경 확인 큐. 상태는 부모(DashboardRealtime)가 소유 — 이 컴포넌트는 순수 표시 +
// onKeep/onConfirm 콜백만. 변경 메일이 오면 예약 본체는 그대로이고 여기 pending 으로 뜬다.
// 직원이 [기존 예약 유지] 또는 [변경 확정]을 눌러야 반영된다.

export function ReservationChangeQueue({
  changes,
  onKeep,
  onConfirm,
  todayISO,
  id,
}: {
  changes: ReservationChange[];
  onKeep: (changeId: string) => void;
  onConfirm: (changeId: string) => void;
  todayISO?: string;
  id?: string;
}) {
  const pending = [...changes]
    .filter((c) => c.status === 'pending')
    .sort((a, b) => a.new_check_in.localeCompare(b.new_check_in));

  return (
    <section id={id}>
      <div className="section-title">
        <h2>예약 변경 확인</h2>
        <span className="count-pill">{pending.length}건</span>
      </div>

      {pending.length === 0 ? (
        <div className="empty">대기 중인 예약 변경 없음</div>
      ) : (
        pending.map((c) => {
          const fields = changedFields(
            {
              check_in: c.prev_check_in,
              check_out: c.prev_check_out,
              room_name: c.prev_room_name,
              amount: c.prev_amount,
              guest_name: c.prev_guest_name,
              options: c.prev_options,
            },
            {
              check_in: c.new_check_in,
              check_out: c.new_check_out,
              room_name: c.new_room_name,
              amount: c.new_amount,
              guest_name: c.new_guest_name,
              // 큐에는 직전 전화번호가 없어(reservation_changes에 prev_guest_phone 미저장)
              // 전화 변경은 라벨로 구분하지 않는다 — 이름 변경만 '예약자 변경'으로 표시.
              options: c.new_options,
            },
          );
          // 큐에 떠 있는 건 항상 뭔가 바뀐 것 — 라벨이 빌 수 있는 경우(전화만 변경 등,
          // 직전 전화 미보유로 감지 불가)는 '기타 변경'으로 표시.
          const summary = fields.length > 0 ? changeSummaryLabel(fields) : '기타 변경';
          // 위약금 기준: 변경 전(직전) 체크인 · 직전 결제금액.
          const refund = refundForChange(c.prev_check_in, c.prev_amount, todayISO);

          return (
            <div key={c.id} className="card">
              <div className="badge-row">
                <ChannelBadge channel={c.reservation_channel} />
                <span className="card-title">
                  {c.new_guest_name ?? c.prev_guest_name ?? '이름 미상'}
                </span>
              </div>

              <div className="change-rows">
                <div className="change-row">
                  <span className="change-tag">기존</span>
                  {formatDateRange(c.prev_check_in, c.prev_check_out)} ·{' '}
                  {displayRoomName(c.prev_room_name)} · {formatWon(c.prev_amount)}
                </div>
                <div className="change-row change-row-new">
                  <span className="change-tag">변경</span>
                  {formatDateRange(c.new_check_in, c.new_check_out)} ·{' '}
                  {displayRoomName(c.new_room_name)} · {formatWon(c.new_amount)}{' '}
                  <em>({summary})</em>
                </div>
              </div>

              <PenaltyBanner refund={refund} total={c.prev_amount} />

              <div className="badge-row">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onKeep(c.id)}
                >
                  기존 예약 유지
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => onConfirm(c.id)}
                >
                  변경 확정
                </button>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

function PenaltyBanner({
  refund,
  total,
}: {
  refund: ReturnType<typeof refundForChange>;
  total: number | null;
}) {
  if (!refund.hasPenalty) {
    return (
      <div className="penalty-banner ok">
        ✓ 위약금 없음 (체크인 {refund.daysBefore}일 전)
      </div>
    );
  }
  if (!refund.amountKnown) {
    return (
      <div className="penalty-banner warn">
        ⚠️ 위약금 발생 구간 (체크인 {refund.daysBefore}일 전) · 금액 미상 — 위약금 수동 확인
      </div>
    );
  }
  if (refund.refundRate === 0) {
    return (
      <div className="penalty-banner danger">
        <strong>⚠️ 위약금 {formatWon(total)} (전액) · 환불 불가</strong>
        <div>
          {refund.daysBefore < 0
            ? '체크인 지난 예약'
            : `체크인 ${refund.daysBefore}일 이내 변경`}
        </div>
      </div>
    );
  }
  return (
    <div className="penalty-banner warn">
      <strong>⚠️ 위약금 {formatWon(refund.penalty)} 발생</strong>
      <div>
        체크인 {refund.daysBefore}일 전 변경 · 환불 가능 {formatWon(refund.refundable)} (
        {Math.round(refund.refundRate * 100)}%) · 총 결제 {formatWon(total)}
      </div>
    </div>
  );
}
