import type {
  Channel,
  PaymentMethod,
  PaymentStatus,
  ReservationStatus,
  ReservationOption,
} from './types';

// supabase/migrations/0001_init.sql 과 1:1 대응하는 조회용(row) 타입.
// lib/types.ts 의 ParsedReservation(파서 출력)과는 다른 계층 —
// 이쪽은 DB에 이미 저장된 예약을 화면에서 읽을 때 쓴다.

export interface Reservation {
  id: string;
  channel: Channel;
  channel_reservation_id: string;
  guest_name: string | null;
  guest_phone: string | null;
  room_name: string | null;
  check_in: string; // 'YYYY-MM-DD'
  check_out: string;
  amount: number | null;
  options: ReservationOption[];
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  status: ReservationStatus;
  deposit_confirmed_by: string | null;
  deposit_confirmed_at: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  detected_at: string;
  updated_at: string;
  notes: string | null; // 직원이 남기는 비고(특이사항)
}

export type BlockTaskStatus = 'pending' | 'done' | 'skipped';
export type BlockAction = 'block' | 'unblock';

export interface BlockTask {
  id: string;
  reservation_id: string | null; // null이면 직접 막기(예약 아님) — room_code/reason 참고
  target_channel: Channel;
  check_in: string;
  check_out: string;
  status: BlockTaskStatus;
  // 'block'=막아야 함(기존), 'unblock'=이미 막아놨는데 예약이 취소돼 다시 열어야 함.
  action: BlockAction;
  done_by: string | null;
  done_at: string | null;
  created_at: string;
  room_code: string | null; // 직접 막기 전용
  reason: string | null; // 직접 막기 전용
  manual_block_group: string | null; // 직접 막기 전용 — 채널 3곳을 한 그룹으로 묶어 한 번에 취소
  // 화면 표시용 조인 필드(예약 기반일 때만 채워짐)
  reservation_room_name: string | null;
  reservation_guest_name: string | null;
  reservation_channel: Channel | null;
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  imweb: '아임웹',
  naver: '네이버',
  stayfolio: '스테이폴리오',
};

export const STATUS_LABEL: Record<ReservationStatus, string> = {
  new: '신규',
  awaiting_deposit: '입금대기',
  confirmed: '확정',
  cancelled: '취소',
};
