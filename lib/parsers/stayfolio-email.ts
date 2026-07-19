import type {
  ParsedReservation,
  ReservationOption,
  PaymentMethod,
} from '../types';
import { parseKoreanDate, normalizeKrPhone, firstAmount, extractLabeledFields } from './util';

// 스테이폴리오 예약 알림 이메일 파서(hello@stayfolio.com).
// 스테이폴리오가 구글 캘린더 연동 서비스를 중단하고 이메일 알림으로 전환(2026-07 확인).
// 기존 SMS 알림(parseStayfolioSms)과 완전히 다른 포맷 — 별도 파서로 분리:
//   - 예약번호가 본문/제목/HTML 어디에도 없음(2026-07 실메일로 확인, hidden link도 없음)
//     → guest_email|check_in|check_out|room_name 합성키를 channel_reservation_id로 사용
//   - 날짜가 '2026년 7월 29일' 형태(체크인/체크아웃 각각 별도 라벨, 범위 아님)
//   - 옵션이 콤마가 아니라 공백으로 나열: "A (￦12000) * 1 B (￦22000) * 1"
//   - 원화 기호가 전각(￦, U+FFE6) — 반각(₩, U+20A9)과 다른 문자
//   - 결제방법이 '카드'가 아니라 '네이버페이' 등 PG사명으로 옴
//
// 실제 샘플(2026-07 확보, Gmail IMAP 직접 조회 — 개인정보는 가상 값으로 치환, 형식은 그대로):
//   제목: 스테이폴리오 홍길동(test.guest@example.com)님의 예약내용입니다. - 스테이온페이지(page26 - 시가 내려앉는 순간) 2026년 7월 29일 ~ 2026년 7월 30일
//   Guest Information 성함 홍길동 연락처 +821000000000 이메일 test.guest@example.com 객실명 page26 - 시가
//   내려앉는 순간 투숙인원 성인: 2명 / 아동: 0명 / 영아: 0명 체크인 2026년 7월 29일 오후 3시 체크아웃 2026년 7월 30일
//   오전 10시 옵션 조식_멋진하루 1인 (￦12000) * 1 석식룸서비스_선데이로스트 1인 (￦22000) * 1
//   기념일패키지_석식2인(매장이용) (￦140000) * 1 요청사항 요청사항이 없습니다.
//   결제정보 결제금액 434,000원 결제방법 네이버페이 중개수수료 퍼센트 11.0% 중개수수료 47,740원 정산금액 386,260원

const LABELS = [
  '성함',
  '연락처',
  '이메일',
  '객실명',
  '투숙인원',
  '체크인',
  '체크아웃',
  '옵션',
  '요청사항',
  '결제금액',
  '결제방법',
  '중개수수료',
  '정산금액',
] as const;

/** 'A (￦12000) * 1 B(매장이용) (￦22000) * 2' → 옵션 리스트.
 *  가격 괄호(￦/₩ 포함)만 구분자로 삼아, 이름 안의 다른 괄호(예: '(매장이용)')는 보존한다. */
function parseSpaceSeparatedOptions(s: string): ReservationOption[] {
  const priceRe = /\(\s*[￦₩]\s*([\d,]+)\s*\)\s*\*\s*(\d+)/g;
  const options: ReservationOption[] = [];
  let prevEnd = 0;
  for (const m of s.matchAll(priceRe)) {
    const name = s.slice(prevEnd, m.index).trim();
    if (name) {
      options.push({
        name,
        price: Number(m[1].replace(/,/g, '')),
        qty: Number(m[2]),
      });
    }
    prevEnd = (m.index ?? 0) + m[0].length;
  }
  return options;
}

function classifyPaymentMethod(s: string): PaymentMethod {
  if (/카드/.test(s)) return 'card';
  if (/페이/.test(s)) return 'card'; // 네이버페이·카카오페이 등 전자결제 → 카드와 동일하게 취급(즉시결제)
  if (/현금|계좌|무통장/.test(s)) return 'cash';
  return 'unknown';
}

export function parseStayfolioEmail(text: string): ParsedReservation | null {
  const f = extractLabeledFields(text, LABELS);

  const guestEmail = f['이메일'] || null;
  const guestPhone = f['연락처'] ? normalizeKrPhone(f['연락처']) : null;
  const roomName = f['객실명'] || null;
  const checkIn = f['체크인'] ? parseKoreanDate(f['체크인']) : null;
  const checkOut = f['체크아웃'] ? parseKoreanDate(f['체크아웃']) : null;

  if (!checkIn || !checkOut) return null; // 필수 최소값 없으면 실패

  // 예약번호가 이메일 어디에도 없음(실메일로 확인) — 합성키로 대체.
  // 같은 예약이 재도착해도 동일 조합이면 동일 키 → upsert로 안전.
  const idParts = [guestEmail, checkIn, checkOut, roomName].filter(Boolean);
  const channel_reservation_id = idParts.join('|');
  if (!channel_reservation_id) return null;

  const method = classifyPaymentMethod(f['결제방법'] ?? '');

  // 운영자 확인(2026-07): 스테이폴리오는 "신청" 이메일만 발송한다 — 별도 확정/취소 이메일 없음.
  // 신청 시점에 이미 결제(정산금액까지) 완료돼 있으므로, 이 이메일 하나로 바로 확정 처리한다.
  // 남기는 안전장치: 혹시 모를 취소 문구 포함 시에만 취소로 분류(현재까지 실제 사례는 없음).
  const cancelled = /취소/.test(text.slice(0, 60));

  return {
    channel: 'stayfolio',
    channel_reservation_id,
    guest_name: f['성함'] || null,
    guest_phone: guestPhone,
    room_name: roomName,
    check_in: checkIn,
    check_out: checkOut,
    amount: firstAmount(f['결제금액'] ?? ''),
    options: f['옵션'] ? parseSpaceSeparatedOptions(f['옵션']) : [],
    payment_method: method,
    payment_status: cancelled ? 'none' : 'paid',
    cancelled,
    raw_payload: { source: 'stayfolio_email', fields: f, guestEmail, text },
  };
}
