import { createClient } from '@supabase/supabase-js';
import { parseStayfolioIcs } from '../parsers/stayfolio-ics';
import { STAYFOLIO_ROOM_ICS_URLS } from '../parsers/stayfolio-rooms';
import { kstTodayISO } from '../format';

// 스테이폴리오는 취소 이메일을 보내지 않는다(운영자 확인, 2026-07) — 그래서 취소는
// ICS 캘린더를 주기적으로 다시 읽어 "전에 있던 예약번호가 사라짐"으로 간접 추론한다.
//
// 안전장치: ICS 조회 자체가 실패한 방은 그 방의 예약을 전부 건너뛴다(취소 처리 안 함).
// 네트워크 오류·일시적 5xx를 "전부 취소됨"으로 오판하면 절대 안 되기 때문 —
// 이게 이 모듈에서 가장 중요한 불변식이다.
//
// 두 번째 불변식(2026-07-25 실사고로 발견): 스테이폴리오 ICS는 지난 밤이 된 순간(그쪽도
// 한국시간 기준으로 보임) 그날 체크아웃하는 예약을 캘린더에서 바로 빼버린다 — 취소된 게
// 아니라 그냥 "더 이상 막아야 할 미래 날짜가 아니라서" 지워지는 것. 그런데 우리 쪽 대상
// 필터가 UTC 자정 기준 오늘을 써서, 한국시간 자정~오전 9시(=UTC 전날 15~24시) 사이에
// 30분마다 도는 대사 잡이 "체크아웃 당일"인 예약을 걸러내지 못하고 그대로 조회해버리면,
// ICS엔 이미 사라졌지만 실제로는 멀쩡한 예약을 취소로 오판한다(최은수/7·25 체크아웃 건
// 실사고 — cancelled_at이 정확히 한국시간 00:00:01). 그래서 대상 필터도 한국시간 기준
// "오늘"을 쓰고, 체크아웃 당일 예약은 아예 대사 대상에서 뺀다(체크아웃일 이전에 취소됐다면
// 그 전날 이미 ICS에서 사라져 정상적으로 잡혔을 것이므로, 당일만 빼도 놓치는 취소는 없다).

export interface ReconcileResult {
  checkedRooms: number;
  checkedReservations: number;
  enqueuedReviewCount: number; // 즉시취소 대신 "취소 검토 큐"에 등록한 건수(v2)
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
    enqueuedReviewCount: 0,
    skippedRooms: [],
    errors: [],
  };

  // 대상: 체크아웃 당일이 아직 안 됐고(엄격히 이후), 취소 상태가 아니며, ICS 매칭으로 얻은
  // "진짜"(숫자) 예약번호를 가진 스테이폴리오 예약만. 합성키(guest_email|...) 예약은 ICS와
  // 대조할 수 없어 제외. "오늘"은 한국시간 기준(위 두 번째 불변식 주석 참고).
  const today = kstTodayISO();
  const { data: reservations, error } = await supabase
    .from('reservations')
    .select('id, channel_reservation_id, room_name')
    .eq('channel', 'stayfolio')
    .neq('status', 'cancelled')
    .gt('check_out', today)
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

        // v2: 즉시 취소하지 않고 "취소 검토 큐"에 등록한다(2026-07-25 / 2026-08-29 오취소
        // 실사고 재발 방지 — 사라짐 감지는 운영자 확인을 거친 뒤에만 실제 취소로 이어진다).
        const { error: enqueueErr } = await supabase.rpc('enqueue_ics_cancel_review', {
          p_reservation_id: r.id,
        });
        if (enqueueErr) {
          result.errors.push(`${r.id}: ${enqueueErr.message}`);
        } else {
          result.enqueuedReviewCount++;
        }
      }
    } catch (e) {
      result.skippedRooms.push(roomCode); // 네트워크 예외도 동일하게 안전 폴백
      result.errors.push(`${roomCode}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
