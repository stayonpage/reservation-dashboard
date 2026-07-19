// 일회성 백필: 취소 처리 도입(0005) 이전에 수신된 메일들을 새 파서로 재처리한다.
//   1) ingest_log의 parsed 원문을 다시 파싱 → 취소 메일이면 RPC로 cancelled 전환
//   2) 체크아웃이 지난 pending 블록태스크를 skipped 처리(과거 날짜는 막을 이유가 없음)
// 실행: npx tsx scripts/backfill-cancellations.ts

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { parseNaverEmail } from '../lib/parsers/naver';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const sb = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  const { data: logs, error } = await sb
    .from('ingest_log')
    .select('id, raw')
    .eq('source', 'naver_email')
    .eq('status', 'parsed');
  if (error) throw error;

  let cancelled = 0;
  for (const row of logs ?? []) {
    const parsed = parseNaverEmail(row.raw ?? '');
    if (!parsed?.cancelled) continue;

    const { error: rpcErr } = await sb.rpc('ingest_reservation', {
      p_channel: parsed.channel,
      p_channel_reservation_id: parsed.channel_reservation_id,
      p_guest_name: parsed.guest_name,
      p_guest_phone: parsed.guest_phone,
      p_room_name: parsed.room_name,
      p_check_in: parsed.check_in,
      p_check_out: parsed.check_out,
      p_amount: parsed.amount,
      p_options: parsed.options,
      p_payment_method: parsed.payment_method,
      p_payment_status: parsed.payment_status,
      p_raw: parsed.raw_payload,
      p_cancelled: true,
    });
    if (rpcErr) {
      console.error(`ingest_log ${row.id} 백필 실패:`, rpcErr.message);
      continue;
    }
    cancelled++;
  }
  console.log(`취소 전환 백필: ${cancelled}건`);

  // 과거 날짜 pending 블록태스크 정리
  const today = new Date().toISOString().slice(0, 10);
  const { data: skipped, error: skipErr } = await sb
    .from('block_tasks')
    .update({ status: 'skipped' })
    .eq('status', 'pending')
    .lt('check_out', today)
    .select('id');
  if (skipErr) throw skipErr;
  console.log(`과거 날짜 블록태스크 skip: ${skipped?.length ?? 0}건`);

  // 결과 요약
  const { count: cancelledCount } = await sb
    .from('reservations')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'cancelled');
  const { count: pendingBlocks } = await sb
    .from('block_tasks')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');
  console.log(`현재 상태: 취소 예약 ${cancelledCount}건 / 남은 pending 블록태스크 ${pendingBlocks}건`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
