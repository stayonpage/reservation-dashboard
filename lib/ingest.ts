import { createClient } from '@supabase/supabase-js';
import type { ParsedReservation } from './types';
import { omaibookPromoEligible, appendPromoNote } from './promo';

// 수신 파이프라인 단일 진입점: 원시 메시지(메일/문자/웹훅) → 멱등 기록 → 파싱 → upsert.
//
// 파싱 워커(네이버 IMAP / 스테이폴리오 SMS전달 IMAP / 아임웹 웹훅)는 전부 이 함수를 호출한다.
// service_role 키로 접속(RLS 우회)해야 한다 — 서버 전용, 절대 클라이언트 번들에 넣지 말 것.

export type IngestSource =
  | 'naver_email'
  | 'stayfolio_sms'
  | 'stayfolio_gcal' // 구글 캘린더 연동 중단(2026-07) — 레거시, stayfolio_email로 대체됨
  | 'stayfolio_email'
  | 'imweb_webhook'
  | 'imweb_api'
  | 'imweb_email';

export type IngestResult =
  | { status: 'parsed'; reservationId: string }
  | { status: 'duplicate' }
  | { status: 'parse_failed' };

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

export async function handleIncoming(args: {
  source: IngestSource;
  externalId: string; // 메일 UID / SMS id / webhook id — 원시 멱등 키
  raw: string;
  // 비동기 허용: 스테이폴리오는 파싱 후 ICS 피드를 조회해 진짜 예약번호로 보강한다
  // (stayfolio-rooms.ts + stayfolio-ics.ts 참고) — 이메일 자체엔 예약번호가 없음.
  parse: (raw: string) => ParsedReservation | null | Promise<ParsedReservation | null>;
  // 스테이폴리오 확정메일 Date 헤더 — 프로모션 신청 기간 판정에 쓴다. 없으면 현재 시각.
  receivedAt?: Date;
}): Promise<IngestResult> {
  const { source, externalId, raw, parse, receivedAt } = args;

  // 1) 원시 멱등 기록. unique(source, external_id) 충돌 = 이미 받은 메시지 → 중복.
  const { error: logErr } = await supabase
    .from('ingest_log')
    .insert({ source, external_id: externalId, raw, status: 'received' });
  if (logErr) {
    if (logErr.code === '23505') return { status: 'duplicate' };
    throw logErr;
  }

  const markLog = (patch: Record<string, unknown>) =>
    supabase.from('ingest_log').update(patch).match({ source, external_id: externalId });

  // 2) 파싱. 실패해도 원문은 ingest_log에 남아 재파싱·디버깅 가능(무음 유실 방지).
  const parsed = await parse(raw);
  if (!parsed) {
    await markLog({ status: 'parse_failed', error: 'parser returned null' });
    return { status: 'parse_failed' };
  }

  // 3) upsert(+신규면 감지이벤트/블록태스크). status/감사는 재수신에도 보존(0002_ingest_fn.sql).
  const { data, error } = await supabase.rpc('ingest_reservation', {
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
    p_cancelled: parsed.cancelled,
    p_guest_request: parsed.guest_request,
  });
  if (error) {
    await markLog({ status: 'parse_failed', error: error.message });
    throw error;
  }

  await markLog({ status: 'parsed', parsed_reservation_id: data });

  // 오마이북 3만원 상품권 프로모션 — 대상이면 비고에 안내 문구를 남긴다(best-effort:
  // 실패해도 예약 수신 자체는 성공으로 둔다).
  try {
    if (
      omaibookPromoEligible({
        channel: parsed.channel,
        roomName: parsed.room_name,
        checkIn: parsed.check_in,
        cancelled: parsed.cancelled,
        confirmedMailAt: receivedAt ?? new Date(),
      })
    ) {
      const { data: row } = await supabase
        .from('reservations')
        .select('notes')
        .eq('id', data as string)
        .single();
      const nextNotes = appendPromoNote(row?.notes ?? null);
      if (nextNotes !== null) {
        const { error: noteErr } = await supabase
          .from('reservations')
          .update({ notes: nextNotes })
          .eq('id', data as string);
        if (noteErr) console.error('[promo-note]', data, noteErr.message);
      }
    }
  } catch (e) {
    console.error('[promo-note]', data, e instanceof Error ? e.message : String(e));
  }

  return { status: 'parsed', reservationId: data as string };
}

// 폴링이 성공할 때마다(새 메일 유무와 무관하게) 확인 시각을 남긴다 — 헤더의 "마지막 동기화"
// 칩용. 하트비트 실패가 폴링 자체를 실패로 만들면 안 되므로 어떤 에러도 삼킨다(best-effort).
export async function recordHeartbeat(source: IngestSource): Promise<void> {
  try {
    const { error } = await supabase
      .from('sync_heartbeat')
      .upsert(
        { source, checked_at: new Date().toISOString() },
        { onConflict: 'source' },
      );
    if (error) console.error('[heartbeat]', source, error.message);
  } catch (e) {
    console.error('[heartbeat]', source, e instanceof Error ? e.message : String(e));
  }
}
