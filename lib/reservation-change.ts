// prev/new 예약 스냅샷을 비교해 "무엇이 바뀌었나"를 낸다 — 변경 확인 큐 카드 라벨용.
// DB의 ingest_reservation v_changed 판정과 의미를 맞춘다(빈 옵션/‌null 금액·전화는 변경 아님).
import type { ReservationOption } from './types';

export type ChangedField = 'dates' | 'room' | 'amount' | 'guest' | 'options';

export interface ChangeSnapshot {
  check_in: string;
  check_out: string;
  room_name: string | null;
  amount: number | null;
  guest_name: string | null;
  guest_phone?: string | null;
  options: ReservationOption[];
}

function normOptions(opts: ReservationOption[]): string {
  return JSON.stringify(
    [...(opts ?? [])]
      .map((o) => ({ name: o.name, qty: o.qty, price: o.price }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

const ORDER: ChangedField[] = ['dates', 'room', 'amount', 'guest', 'options'];

const LABEL: Record<ChangedField, string> = {
  dates: '날짜',
  room: '객실',
  amount: '금액',
  guest: '예약자',
  options: '옵션',
};

export function changedFields(
  prev: ChangeSnapshot,
  next: ChangeSnapshot,
): ChangedField[] {
  const set = new Set<ChangedField>();

  if (prev.check_in !== next.check_in || prev.check_out !== next.check_out) {
    set.add('dates');
  }
  if (prev.room_name !== next.room_name) set.add('room');
  if (next.amount != null && next.amount !== prev.amount) set.add('amount');
  if (
    prev.guest_name !== next.guest_name ||
    (next.guest_phone != null && next.guest_phone !== prev.guest_phone)
  ) {
    set.add('guest');
  }
  const nextOpts = next.options ?? [];
  if (nextOpts.length > 0 && normOptions(prev.options) !== normOptions(nextOpts)) {
    set.add('options');
  }

  return ORDER.filter((f) => set.has(f));
}

export function changeSummaryLabel(fields: ChangedField[]): string {
  if (fields.length === 0) return '변경 없음';
  return fields.map((f) => LABEL[f]).join('·') + ' 변경';
}
