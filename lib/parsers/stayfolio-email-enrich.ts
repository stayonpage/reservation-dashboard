import type { ParsedReservation } from '../types';
import { parseStayfolioEmail } from './stayfolio-email';
import { findIcsUrlForRoom } from './stayfolio-rooms';
import { parseStayfolioIcs, matchIcsBooking } from './stayfolio-ics';

// 이메일 파싱 결과(합성키)를 ICS 피드의 진짜 예약번호로 보강한다.
// ICS 조회가 실패하거나 매칭이 안 돼도 감지 자체는 실패시키지 않는다 — 합성키로 폴백
// (design doc 원칙: 무음 실패보다 저하된 상태로라도 감지가 이어지는 게 낫다).
export async function parseStayfolioEmailWithRealId(
  raw: string,
): Promise<ParsedReservation | null> {
  const parsed = parseStayfolioEmail(raw);
  if (!parsed) return null;

  const icsUrl = findIcsUrlForRoom(parsed.room_name);
  if (!icsUrl) return parsed; // 매핑에 없는 방 — 합성키 유지

  try {
    const res = await fetch(icsUrl);
    if (!res.ok) return parsed;
    const icsText = await res.text();
    const bookings = parseStayfolioIcs(icsText);
    const match = matchIcsBooking(
      bookings,
      parsed.check_in,
      parsed.check_out,
      parsed.guest_phone,
    );
    if (match) {
      return { ...parsed, channel_reservation_id: match.bookingId };
    }
  } catch {
    // ICS 조회 실패 — 합성키로 폴백, 감지는 계속 진행.
  }
  return parsed;
}
