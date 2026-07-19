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
