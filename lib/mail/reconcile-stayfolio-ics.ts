import { createClient } from '@supabase/supabase-js';
import { parseStayfolioIcs } from '../parsers/stayfolio-ics';
import { STAYFOLIO_ROOM_ICS_URLS } from '../parsers/stayfolio-rooms';

// 스테이폴리오는 취소 이메일을 보내지 않는다(운영자 확인, 2026-07) — 그래서 취소는
// ICS 캘린더를 주기적으로 다시 읽어 "전에 있던 예약번호가 사라짐"으로 간접 추론한다.
//
// 안전장치: ICS 조회 자체가 실패한 방은 그 방의 예약을 전부 건너뛴다(취소 처리 안 함).
// 네트워크 오류·일시적 5xx를 "전부 취소됨"으로 오판하면 절대 안 되기 때문 —
// 이게 이 모듈에서 가장 중요한 불변식이다.

export interface ReconcileResult {
  checkedRooms: number;
  checkedReservations: number;
  cancelledCount: number;
  skippedRooms: string[]; // ICS 조회 실패 등으로 대사를 건너뛴 방(안전 폴백)
  errors: string[];
}

interface ActiveReservation {
  id: string;
  channel_reservation_id: string;
  room_name: string | null;
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

/** room_name(예: 'page26 - 시가 내려앉는 순간')에서 방 코드를 뽑는다. findIcsUrlForRoom과
 *  동일한 규칙(숫자 경계 확인)을 쓴다 — page1이 page127에 오매칭되지 않도록. */
function roomCodeOf(roomName: string | null): string | null {
  if (!roomName) return null;
  return (
    Object.keys(STAYFOLIO_ROOM_ICS_URLS).find((c) => {
      if (!roomName.startsWith(c)) return false;
      const next = roomName[c.length];
      return next === undefined || !/\d/.test(next);
    }) ?? null
  );
}

export async function reconcileStayfolioCancellations(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    checkedRooms: 0,
    checkedReservations: 0,
    cancelledCount: 0,
    skippedRooms: [],
    errors: [],
  };

  // 대상: 아직 체크아웃 전이고, 취소 상태가 아니며, ICS 매칭으로 얻은 "진짜"(숫자) 예약번호를
  // 가진 스테이폴리오 예약만. 합성키(guest_email|...) 예약은 ICS와 대조할 수 없어 제외.
  const today = new Date().toISOString().slice(0, 10);
  const { data: reservations, error } = await supabase
    .from('reservations')
    .select('id, channel_reservation_id, room_name')
    .eq('channel', 'stayfolio')
    .neq('status', 'cancelled')
    .gte('check_out', today)
    .returns<ActiveReservation[]>();

  if (error) throw error;

  const byRoom = new Map<string, ActiveReservation[]>();
  for (const r of reservations ?? []) {
    if (!/^\d+$/.test(r.channel_reservation_id)) continue;
    const code = roomCodeOf(r.room_name);
    if (!code) continue;
    if (!byRoom.has(code)) byRoom.set(code, []);
    byRoom.get(code)!.push(r);
  }

  for (const [roomCode, roomReservations] of byRoom) {
    result.checkedRooms++;
    const url = STAYFOLIO_ROOM_ICS_URLS[roomCode];
    try {
      const res = await fetch(url);
      if (!res.ok) {
        result.skippedRooms.push(roomCode); // 안전 폴백 — 조회 실패는 취소 아님
        continue;
      }
      const text = await res.text();
      const currentIds = new Set(parseStayfolioIcs(text).map((b) => b.bookingId));

      for (const r of roomReservations) {
        result.checkedReservations++;
        if (currentIds.has(r.channel_reservation_id)) continue;

        const { error: cancelErr } = await supabase.rpc('cancel_reservation', {
          p_id: r.id,
          p_reason: 'stayfolio_ics_missing',
        });
        if (cancelErr) {
          result.errors.push(`${r.id}: ${cancelErr.message}`);
        } else {
          result.cancelledCount++;
        }
      }
    } catch (e) {
      result.skippedRooms.push(roomCode); // 네트워크 예외도 동일하게 안전 폴백
      result.errors.push(`${roomCode}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
