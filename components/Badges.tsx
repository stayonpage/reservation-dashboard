import { CHANNEL_LABEL, STATUS_LABEL } from '../lib/db-types';
import type { Channel, ReservationStatus } from '../lib/types';

export const CHANNEL_COLOR: Record<Channel, string> = {
  imweb: 'var(--ch-imweb)',
  naver: 'var(--ch-naver)',
  stayfolio: 'var(--ch-stayfolio)',
};

export function ChannelBadge({ channel }: { channel: Channel }) {
  return (
    <span
      className="badge badge-channel"
      style={{ background: CHANNEL_COLOR[channel] }}
    >
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

export function StatusBadge({ status }: { status: ReservationStatus }) {
  return (
    <span className={`badge badge-status-${status}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

// 원래 예약 카드에 "이 예약에 처리 대기 중인 변경 요청이 있음"을 알리는 배지.
export function ChangeRequestBadge() {
  return <span className="badge badge-change-request">변경 요청</span>;
}

export function CancelRequestBadge() {
  return <span className="badge badge-cancel-request">취소 요청</span>;
}

export function UncancelRequestBadge() {
  return <span className="badge badge-uncancel-request">되살리기 요청</span>;
}
