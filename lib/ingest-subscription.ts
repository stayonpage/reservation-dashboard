import { createClient } from '@supabase/supabase-js';
import { parseSubscriptionEmail } from './parsers/subscription-email';
import { planAmount, defaultStartMonth, endMonthOf } from './subscription';

// 월간구독 신청 메일 수신. lib/ingest.ts 의 handleIncoming 과 같은 멱등/재시도 규칙:
//  · ingest_log (source, external_id) unique 로 원문을 먼저 기록.
//  · 충돌 시 기존 행이 'parsed' 일 때만 duplicate — 'received'/'parse_failed' 면 재시도
//    (2026-09 박재홍님 예약 유실 사고와 같은 실패를 구독에서 반복하지 않는다).
// source 는 기존 'imweb_email'(enum 추가 불필요)을 쓰고 external_id 에 'subscription:' 접두어를
// 붙인다 — 과거에 예약 파서로 보내져 parse_failed 로 남은 같은 메일 행과 충돌하지 않는다.
// service_role 키 사용 — 서버 전용.

const SOURCE = 'imweb_email' as const;

export type SubscriptionIngestResult =
  | { status: 'parsed' }
  | { status: 'duplicate' }
  | { status: 'parse_failed' };

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

export async function handleSubscriptionIncoming(args: {
  externalId: string; // 메일 Message-ID (접두어는 여기서 붙인다)
  raw: string; // "제목: <subject>\n<본문>"
  appliedAt?: Date; // 메일 Date 헤더 — 없으면 현재 시각
}): Promise<SubscriptionIngestResult> {
  const externalId = `subscription:${args.externalId}`;

  const markLog = (patch: Record<string, unknown>) =>
    supabase.from('ingest_log').update(patch).match({ source: SOURCE, external_id: externalId });

  const { error: logErr } = await supabase
    .from('ingest_log')
    .insert({ source: SOURCE, external_id: externalId, raw: args.raw, status: 'received' });
  if (logErr) {
    if (logErr.code !== '23505') throw logErr;
    const { data: existing, error: fetchErr } = await supabase
      .from('ingest_log')
      .select('status')
      .match({ source: SOURCE, external_id: externalId })
      .single();
    if (fetchErr) throw fetchErr;
    if (existing?.status === 'parsed') return { status: 'duplicate' };
    // 'received' 또는 'parse_failed' → 아래로 이어져 재시도.
  }

  const parsed = parseSubscriptionEmail(args.raw);
  if (!parsed) {
    await markLog({ status: 'parse_failed', error: 'subscription parser returned null' });
    return { status: 'parse_failed' };
  }

  const appliedAt =
    args.appliedAt && !Number.isNaN(args.appliedAt.getTime()) ? args.appliedAt : new Date();
  const startMonth = defaultStartMonth(appliedAt.toISOString());

  const { error } = await supabase.from('subscriptions').upsert(
    {
      name: parsed.name,
      phone: parsed.phone,
      address: parsed.address,
      address_detail: parsed.address_detail,
      plan_months: parsed.plan_months,
      amount: planAmount(parsed.plan_months),
      status: 'pending',
      start_month: startMonth,
      end_month: endMonthOf(startMonth, parsed.plan_months),
      applied_at: appliedAt.toISOString(),
      source_external_id: externalId,
    },
    { onConflict: 'source_external_id', ignoreDuplicates: true },
  );
  if (error) {
    await markLog({ status: 'parse_failed', error: error.message });
    throw error;
  }

  await markLog({ status: 'parsed' });
  return { status: 'parsed' };
}
