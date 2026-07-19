// 3채널 예약을 하나로 정규화하는 공용 타입.
// DB 스키마(supabase/migrations/0001_init.sql)와 1:1 대응.

export type Channel = 'imweb' | 'naver' | 'stayfolio';
export type PaymentMethod = 'card' | 'cash' | 'unknown';
export type PaymentStatus = 'paid' | 'pending' | 'none';
export type ReservationStatus =
  | 'new'
  | 'awaiting_deposit'
  | 'confirmed'
  | 'cancelled';

export interface ReservationOption {
  name: string;
  qty: number;
  price: number; // 원(정수)
}

/** 파서가 뱉는 정규화 결과. reservations 테이블에 upsert 된다. */
export interface ParsedReservation {
  channel: Channel;
  channel_reservation_id: string; // 소스 예약번호 (upsert 키의 일부)
  guest_name: string | null;
  guest_phone: string | null; // 네이버는 null(마스킹/부재)
  room_name: string | null;
  check_in: string; // 'YYYY-MM-DD'
  check_out: string; // 'YYYY-MM-DD'
  amount: number | null; // 총액(원)
  options: ReservationOption[];
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  /** 취소 알림 여부 — true면 ingest 시 해당 예약을 cancelled로 전환하고 블록태스크를 skip한다.
   *  (네이버는 접수/취소를 같은 예약번호로 별도 메일 발송 — 취소를 놓치면 유령 예약이 남는다.) */
  cancelled: boolean;
  raw_payload: unknown; // 원문 보존(재파싱·감사)
}
