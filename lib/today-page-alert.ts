// "오늘의 페이지"(아임웹 가상 객실) 대상 날짜가 실제 4개 객실(page26/452/8/127)로 전부
// 찼을 때 — 아임웹엔 API 연동이 없어 자동으로 못 막으니, 사장님이 지금 당장 아임웹에서
// 수동으로 막아야 한다는 이메일을 보낸다(대시보드를 안 열어도 닿도록, 2026-10-02 확인).
// lib/ingest.ts의 handleIncoming이 수신 직후 best-effort로 호출한다.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Reservation } from './db-types';
import { formatDateShort } from './format';
import {
  datesInRange,
  findFullTodayPageDates,
  isTodayPageSellableDate,
} from './today-page-occupancy';
import { sendMail } from './mail/send-mail';

const NOTIFY_TO = 'stayonpage77@gmail.com';

/**
 * 방금 들어온 예약의 [checkIn, checkOut) 구간 중 "오늘의 페이지" 판매 요일(월~목)에
 * 4개 객실이 전부 찼는지 확인하고, 있으면 이메일로 알린다. 날짜를 찾으면 그 목록을
 * 반환(로깅·테스트용) — 없으면 빈 배열, 메일 발송도 안 한다.
 */
export async function checkAndNotifyTodayPageBlock(
  supabase: SupabaseClient,
  checkIn: string,
  checkOut: string,
): Promise<string[]> {
  const candidateDates = datesInRange(checkIn, checkOut).filter(isTodayPageSellableDate);
  if (candidateDates.length === 0) return [];

  const { data, error } = await supabase
    .from('reservations')
    .select('room_name,check_in,check_out,status')
    .neq('status', 'cancelled')
    .ilike('room_name', 'page%')
    .lt('check_in', checkOut)
    .gt('check_out', checkIn);
  if (error) throw error;

  const fullDates = findFullTodayPageDates(
    (data ?? []) as Pick<Reservation, 'room_name' | 'check_in' | 'check_out' | 'status'>[],
    candidateDates,
  );
  if (fullDates.length === 0) return [];

  const dateList = fullDates.map(formatDateShort).join(', ');
  await sendMail({
    to: NOTIFY_TO,
    subject: `[긴급] 오늘의 페이지 수동 차단 필요 — ${fullDates.length}일`,
    text:
      `다음 날짜는 객실 4개(page26·452·8·127)가 모두 찼습니다.\n` +
      `아임웹 "오늘의 페이지" 상품에서 이 날짜를 지금 막아주세요:\n\n${dateList}`,
  });

  return fullDates;
}
