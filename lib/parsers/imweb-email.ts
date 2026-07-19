import type {
  ParsedReservation,
  ReservationOption,
  PaymentMethod,
} from '../types';
import { firstAmount, extractLabeledFields } from './util';

// 아임웹 예약 알림 메일 파서.
// 발신: 사장님 개인 네이버 계정(misomamy@naver.com) — 아임웹 [사용자 관리 > 자동 메일]의
//       "메일 발송 설정"에 SMTP 릴레이로 등록해 그 계정 명의로 발송됨(2026-07 실메일로 확인).
// 수신: stayonpage77@gmail.com — 스테이폴리오와 같은 편지함으로 들어온다.
// 제목 두 가지, 본문 라벨 구조는 동일(구분은 제목/헤더 문구로):
//   "[스테이 온 페이지] 예약이 접수되어 입금 확인이 필요합니다." — 신규 접수(무통장입금 대기)
//   "[스테이 온 페이지] 예약이 취소되었습니다."                    — 취소
//
// 실 샘플(2026-07 확보, Gmail API로 원문 HTML 직접 조회 — 이름만 가상 값으로 치환, 나머지 형식 그대로):
//   고객명 홍길동 예약번호 202607158517921 예약일자 2026-07-15 15:39
//   결제정보 총 예약금액 342,000원 결제 수단 무통장입금 최종 결제금액 342,000원
//   예약상품 [상품설명 긴 텍스트...] page26 - 분홍 마음을 울리는 시인선 [...정원 안내...]
//   1박(2026년 08월 05일~08월 06일)
//   주문금액 260,000원 굿바이 키트 1명 20,000원 조식_달콤하루 1인 2명 24,000원
//   석식룸서비스_선데이로스트 1인 1명 22,000원 석식룸서비스_굿데이라이스 1인 1명 16,000원
//   최종 결제금액 342,000원
//
// 전화번호는 이 메일에 아예 없다(2026-07 실메일 2건 모두 확인) — null로 둔다.
//
// 방 이름: "객실명" 같은 전용 라벨이 없다. 대신 상품 설명 맨 앞부분에 강조색 글자로
// "pageNN - 방이름"(공백 없이 page+숫자)이 정확히 한 번 나오고, 한참 뒤 정원 안내에
// "page NN"(공백 있음) 형태로 4개 방이 전부 나열된다 — 텍스트에서 처음 나오는
// "page(공백?)+숫자 - ..." 매치가 항상 실제 예약된 방(실샘플 2건으로 순서 확인됨).
const LABELS = [
  '고객명',
  '예약번호',
  '예약일자',
  '총 예약금액',
  '결제 수단',
  '최종 결제금액',
] as const;

function classifyPaymentMethod(s: string): PaymentMethod {
  if (/카드/.test(s)) return 'card';
  if (/페이/.test(s)) return 'card';
  if (/현금|계좌|무통장/.test(s)) return 'cash';
  return 'unknown';
}

// "스테이 온 페이지" 4개 방은 'pageNN - 방이름' 형태, "게스트하우스" 2개 방은
// '서쪽방'/'남쪽방'처럼 짧게 단독으로 나온다(실메일 2026-07 확보, 형식이 완전히 다름).
// 본문 뒷부분(정원 안내 등)에 "남쪽 서쪽"처럼 방 이름이 다시 나오는 경우가 있어
// 텍스트에서 처음 나오는 매치만 쓴다 — 두 패턴 중 더 앞서 나오는 쪽이 실제 예약된 방.
function extractRoomName(text: string): string | null {
  const pageMatch = text.match(/page\s?\d+\s*-\s*[^\n]+/);
  const guesthouseMatch = text.match(/[남서]쪽방/);
  const candidates = [pageMatch, guesthouseMatch].filter(
    (m): m is RegExpMatchArray => m !== null,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return candidates[0][0].replace(/\s+/g, ' ').trim();
}

/** '1박(2026년 08월 05일~08월 06일)' → 체크인/체크아웃. 체크아웃 쪽엔 연도가 반복되지 않음. */
function extractDates(
  text: string,
): { check_in: string; check_out: string } | null {
  const m = text.match(
    /\((\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*~\s*(\d{1,2})월\s*(\d{1,2})일\)/,
  );
  if (!m) return null;
  const pad = (n: string) => n.padStart(2, '0');
  return {
    check_in: `${m[1]}-${pad(m[2])}-${pad(m[3])}`,
    check_out: `${m[1]}-${pad(m[4])}-${pad(m[5])}`,
  };
}

/** '주문금액' 이후 ~ '예약관리' 전까지 구간에서 "이름 금액원" 반복을 옵션으로 뽑는다.
 *  첫 항목(주문금액 자체, 이름 없음)과 마지막 총액(최종 결제금액)은 옵션이 아니므로 제외. */
function extractOptions(text: string): ReservationOption[] {
  const startIdx = text.indexOf('주문금액');
  if (startIdx < 0) return [];
  const endIdx = text.indexOf('예약관리', startIdx);
  const section = (endIdx >= 0 ? text.slice(startIdx, endIdx) : text.slice(startIdx))
    .replace(/^주문금액/, '')
    .replace(/최종\s*결제금액[\s\S]*$/, '')
    .replace(/\[https?:\/\/[^\]]+\]/g, ' ');

  return [...section.matchAll(/(.*?)\s*([\d,]+)원/g)]
    .filter((m) => m[1].trim())
    .map((m) => ({
      name: m[1].trim(),
      qty: 1,
      price: Number(m[2].replace(/,/g, '')),
    }));
}

export function parseImwebEmail(text: string): ParsedReservation | null {
  const f = extractLabeledFields(text, LABELS);

  const channel_reservation_id = f['예약번호'];
  const dates = extractDates(text);
  if (!channel_reservation_id || !dates) return null; // 필수 최소값 없으면 실패

  const cancelled = /취소되었습니다/.test(text.slice(0, 60));
  const method = classifyPaymentMethod(f['결제 수단'] ?? '');
  // 무통장입금은 입금 확인 전까지 대기(다른 채널과 동일하게 수동 확인 큐로), 카드/각종 페이는
  // 신청 시점 결제완료로 간주 — 2026-07 실메일 2건은 전부 무통장입금이라 카드 경로는
  // classifyPaymentMethod 로직을 유추 적용한 것(실샘플 확보되면 재검증 필요).
  const payment_status = cancelled ? 'none' : method === 'cash' ? 'pending' : 'paid';

  return {
    channel: 'imweb',
    channel_reservation_id,
    guest_name: f['고객명'] || null,
    guest_phone: null, // 이메일에 전화번호 없음(2026-07 실메일 2건 모두 확인)
    room_name: extractRoomName(text),
    check_in: dates.check_in,
    check_out: dates.check_out,
    amount: firstAmount(f['최종 결제금액'] ?? f['총 예약금액'] ?? ''),
    options: extractOptions(text),
    payment_method: method,
    payment_status,
    cancelled,
    raw_payload: { source: 'imweb_email', fields: f, text },
  };
}
