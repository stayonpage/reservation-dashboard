'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from './supabase/server';
import type { Channel, PaymentStatus, ReservationOption } from './types';
import { notifyIfReservationFillsTodayPage } from './today-page-alert';

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

// 예약 변경 확인 큐 — [기존 예약 유지]: 변경 메일 무시, 예약 원본 유지.
export async function keepReservationChange(
  changeId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('keep_reservation_change', {
    p_change_id: changeId,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

// [변경 확정]: 예약을 새 값으로 교체(같은 id) + 옛 날짜 다시 열기 + 새 날짜 막기 + 재트리아지.
// 변경 확정 이후 실제 객실(page26/452/8/127)이 새로 채워졌을 수 있는 경우 공통으로 쓴다
// (confirmReservationChange=날짜변경 확정, confirmUncancelReview=취소철회 확정) —
// best-effort: 실패해도 확정 자체는 성공으로 둔다.
async function notifyTodayPageAfterChange(
  supabase: Awaited<ReturnType<typeof createClient>>,
  changeId: string,
): Promise<void> {
  try {
    const { data: change } = await supabase
      .from('reservation_changes')
      .select('reservation_id')
      .eq('id', changeId)
      .single();
    if (!change) return;
    const { data: row } = await supabase
      .from('reservations')
      .select('room_name,check_in,check_out,status')
      .eq('id', change.reservation_id)
      .single();
    if (row) await notifyIfReservationFillsTodayPage(supabase, row);
  } catch (e) {
    console.error('[today-page-alert]', changeId, e instanceof Error ? e.message : String(e));
  }
}

export async function confirmReservationChange(
  changeId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_reservation_change', {
    p_change_id: changeId,
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  await notifyTodayPageAfterChange(supabase, changeId);
  return { error: null };
}

export async function confirmCancelReview(
  changeId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_cancel_review', { p_change_id: changeId });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function confirmUncancelReview(
  changeId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_uncancel_review', { p_change_id: changeId });
  if (error) return { error: error.message };
  revalidatePath('/');
  await notifyTodayPageAfterChange(supabase, changeId);
  return { error: null };
}

// "오늘의 페이지"(랜덤객실) 예약에 실제 객실을 배정 — room_name 갱신 + 3채널(아임웹 포함)
// 막기 태스크 생성을 RPC 하나로 원자적으로 처리(supabase/migrations/0027_assign_random_room.sql).
export async function assignRandomRoom(
  reservationId: string,
  roomCode: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('assign_random_room', {
    p_reservation_id: reservationId,
    p_room_name: roomCode,
  });
  if (error) return { error: error.message };
  revalidatePath('/');

  // "오늘의 페이지" 수동 차단 알림 — 이 배정으로 실제 객실이 막 찼을 수 있다.
  // best-effort: 실패해도 배정 자체는 성공으로 둔다.
  try {
    const { data: row } = await supabase
      .from('reservations')
      .select('room_name,check_in,check_out,status')
      .eq('id', reservationId)
      .single();
    if (row) await notifyIfReservationFillsTodayPage(supabase, row);
  } catch (e) {
    console.error('[today-page-alert]', reservationId, e instanceof Error ? e.message : String(e));
  }

  return { error: null };
}
