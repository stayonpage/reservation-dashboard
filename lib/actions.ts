'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from './supabase/server';
import type { Channel, PaymentStatus, ReservationOption } from './types';

// 대시보드 뮤테이션. 인증된 사용자 컨텍스트로 RPC 호출(supabase/migrations/0003_actions_fn.sql) —
// auth.uid()가 감사 필드에 정확히 기록되고, RLS로 미인증 요청은 자동 차단된다.

export async function toggleBlockTask(
  taskId: string,
  done: boolean,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('toggle_block_task', {
    p_task_id: taskId,
    p_done: done,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function confirmDeposit(
  reservationId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_deposit', {
    p_reservation_id: reservationId,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

// 예약 없이 직접 방을 막을 때(청소·보수·개인사용 등) — 채널 3곳 전부에 막기 태스크 생성.
export async function createManualBlock(
  roomCode: string,
  checkIn: string,
  checkOut: string,
  reason: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('create_manual_block', {
    p_room_code: roomCode,
    p_check_in: checkIn,
    p_check_out: checkOut,
    p_reason: reason,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

// 직접 막기 취소(청소 취소 등) — 그룹(채널 3곳) 전체를 한 번에 skipped 처리해 방을 다시 비운다.
export async function cancelManualBlock(
  group: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('cancel_manual_block', {
    p_group: group,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

// 확정/신규 예약을 직원이 직접 취소 — 방을 다시 비운다(달력 슬라이더 OFF).
export async function cancelReservation(
  reservationId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_cancel_reservation', {
    p_reservation_id: reservationId,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

// 시스템 도입 전 예약을 직원이 수동 입력 — 자동 감지된 예약과 동일하게 취급됨
// (통계·달력·막기 할 일 전부 반영). 이번 백필 전용, 반복 사용 예정 없음.
export async function createManualReservation(params: {
  channel: Channel;
  roomName: string;
  guestName: string;
  guestPhone: string | null;
  checkIn: string;
  checkOut: string;
  amount: number | null;
  paymentStatus: PaymentStatus;
  options: ReservationOption[];
}): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('create_manual_reservation', {
    p_channel: params.channel,
    p_room_name: params.roomName,
    p_guest_name: params.guestName,
    p_guest_phone: params.guestPhone,
    p_check_in: params.checkIn,
    p_check_out: params.checkOut,
    p_amount: params.amount,
    p_payment_status: params.paymentStatus,
    p_options: params.options,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

// 예약 비고(특이사항) 저장 — reservations는 authenticated 전체 CRUD RLS라 RPC 없이 직접 update.
export async function updateReservationNotes(
  reservationId: string,
  notes: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('reservations')
    .update({ notes })
    .eq('id', reservationId);
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}
