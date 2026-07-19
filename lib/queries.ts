import type { SupabaseClient } from '@supabase/supabase-js';
import type { Reservation, BlockTask } from './db-types';
import type { Channel } from './types';
import { kstTodayISO } from './format';

// 서버 컴포넌트 초기 로드용 조회. DB 컬럼명이 Reservation/BlockTask 타입과 이미 1:1이라
// 캐스팅 위주로 단순하게 유지(실시간 갱신은 컴포넌트의 postgres_changes 구독이 담당).

export async function getReservations(
  supabase: SupabaseClient,
): Promise<Reservation[]> {
  // 대시보드는 지원의 "오늘의 업무" 화면 — 체크아웃이 지난 과거 예약은 제외한다.
  // (메일 백로그를 통째로 수집하므로 과거 이력이 수백 건 쌓일 수 있음. 이력 조회 화면은 추후.)
  // "오늘"은 한국시간 기준 — UTC 서버에서 자정~오전9시(KST) 사이에 어제로 밀리지 않게.
  const today = kstTodayISO();
  const { data, error } = await supabase
    .from('reservations')
    .select('*')
    .gte('check_out', today)
    .order('check_in', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Reservation[];
}

interface BlockTaskRow {
  id: string;
  reservation_id: string | null;
  target_channel: BlockTask['target_channel'];
  check_in: string;
  check_out: string;
  status: BlockTask['status'];
  action: BlockTask['action'];
  done_by: string | null;
  done_at: string | null;
  created_at: string;
  room_code: string | null;
  reason: string | null;
  manual_block_group: string | null;
  reservation: {
    room_name: string | null;
    guest_name: string | null;
    channel: Channel;
  } | null;
}

export async function getBlockTasks(
  supabase: SupabaseClient,
): Promise<BlockTask[]> {
  // skipped(취소·과거 정리분)는 워크리스트에서 제외 — done은 최근 완료 확인용으로 남긴다.
  const { data, error } = await supabase
    .from('block_tasks')
    .select(
      '*, reservation:reservations(room_name, guest_name, channel)',
    )
    .neq('status', 'skipped')
    .order('check_in', { ascending: true });
  if (error) throw error;

  return ((data ?? []) as unknown as BlockTaskRow[]).map((row) => ({
    id: row.id,
    reservation_id: row.reservation_id,
    target_channel: row.target_channel,
    check_in: row.check_in,
    check_out: row.check_out,
    status: row.status,
    action: row.action,
    done_by: row.done_by,
    done_at: row.done_at,
    created_at: row.created_at,
    room_code: row.room_code,
    reason: row.reason,
    manual_block_group: row.manual_block_group,
    reservation_room_name: row.reservation?.room_name ?? null,
    reservation_guest_name: row.reservation?.guest_name ?? null,
    reservation_channel: row.reservation?.channel ?? null,
  }));
}

const SOURCE_TO_CHANNEL: Record<string, Channel> = {
  naver_email: 'naver',
  stayfolio_sms: 'stayfolio',
  stayfolio_gcal: 'stayfolio',
  stayfolio_email: 'stayfolio',
  imweb_webhook: 'imweb',
  imweb_api: 'imweb',
  imweb_email: 'imweb',
};

// 헤더의 "마지막 동기화" 표시용 — 채널별로 max(마지막 확인 하트비트, 마지막 메일 처리 시각).
// 하트비트(sync_heartbeat)는 새 메일이 없어도 폴링 성공 시마다 갱신되므로 평상시 칩은 이걸
// 따라가고, ingest_log는 하트비트 도입 전 기록·웹훅 등 폴링 외 유입의 폴백.
// 실패모드2(무음 유실) 대응: 이게 오래되면 UI에서 경고를 띄운다(app/globals.css .sync-chip.stale).
export async function getLastSyncByChannel(
  supabase: SupabaseClient,
): Promise<Partial<Record<Channel, string>>> {
  const [ingest, heartbeat] = await Promise.all([
    supabase
      .from('ingest_log')
      .select('source, received_at')
      .order('received_at', { ascending: false })
      .limit(200),
    supabase.from('sync_heartbeat').select('source, checked_at'),
  ]);
  if (ingest.error) throw ingest.error;
  if (heartbeat.error) throw heartbeat.error;

  const result: Partial<Record<Channel, string>> = {};
  for (const row of ingest.data ?? []) {
    const channel = SOURCE_TO_CHANNEL[row.source as string];
    if (channel && !result[channel]) result[channel] = row.received_at as string;
  }
  for (const row of heartbeat.data ?? []) {
    const channel = SOURCE_TO_CHANNEL[row.source as string];
    if (!channel) continue;
    const checked = row.checked_at as string;
    const existing = result[channel];
    if (!existing || checked > existing) result[channel] = checked;
  }
  return result;
}
