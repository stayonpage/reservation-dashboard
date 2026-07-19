import type { ParsedReservation, ReservationOption, PaymentMethod } from '../types';
import { parseTwoDates, extractLabeledFields } from './util';

// 네이버 예약(플레이스) 알림 메일 파서.
//
// 실제 샘플(2026-07 확보):
//   예약자명       : 김*희님              ← 마스킹, 전화번호 없음
//   예약신청 일시  : 2026.07.08. 23:48:53
//   예약번호       : 1287059074
//   예약상품       : page 8 - 숨결같은 선율에 머무는 하루
//   이용일시       : 2026.08.03.(월)~2026.08.04.(화) (1박 2일)
//   결제상태       : -
//   결제수단       : -
//   결제예상금액   : page 8 - ...(1) 260,000원 + 웰컴키트(1) 3,000원
//                    + 석식룸서비스_굿데이라이스 1인(1) 16,000원
//                    + 석식룸서비스_선데이로스트 1인(1) 22,000원 = 301,000원
//   요청사항       : -
//
// 특징: 전화번호·실명 마스킹은 무시(설계 확정 — 날짜·옵션이 핵심).
//       payment_status는 접수 시점이라 대개 pending.
//
// 취소 메일 변형(2026-07 실데이터 확인): "고객님이 예약을 취소 하셨습니다" +
//   예약취소 일시 / 결제상태 환불완료 / 환불금액 / **결제금액**(접수 메일의 '결제예상금액'과
//   라벨이 다름!) / 취소사유. 같은 예약번호로 오므로 cancelled=true로 upsert해
//   기존 행을 취소 전환한다 — 안 하면 취소된 예약이 '신규'로 남는 유령이 된다.

const LABELS = [
  '예약자명',
  '예약신청 일시',
  '예약취소 일시',
  '예약번호',
  '예약상품',
  '이용일시',
  '결제상태',
  '결제수단',
  '결제예상금액',
  '결제금액',
  '환불금액',
  '환불수수료',
  '취소사유',
  '요청사항',
] as const;

/** 결제예상금액 오른쪽('= 301,000원')의 총액. 없으면 마지막 금액. */
function parseAmount(s: string): number | null {
  const right = s.includes('=') ? s.slice(s.lastIndexOf('=') + 1) : s;
  const nums = [...right.matchAll(/([\d,]+)\s*원/g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
  if (nums.length) return nums[nums.length - 1];
  const all = [...s.matchAll(/([\d,]+)\s*원/g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
  return all.length ? all[all.length - 1] : null;
}

// 결제수단 라벨 텍스트 → 정규화. 카드 즉시결제 예약은 확정 메일에 '신용카드 간편결제'가
// 이미 채워져 오지만(실메일 확인), 접수 단계 메일은 '-'로 비어있는 경우가 있다 — 그때는
// 방 코드로 폴백한다(운영자 확인, 2026-07: page26·452는 카드 즉시결제, page8·127은
// 무통장입금/현장결제라 입금확인을 눌러야 확정된다).
function classifyPaymentMethod(s: string): PaymentMethod {
  if (/카드|페이/.test(s)) return 'card';
  if (/현금|계좌|무통장|매장방문/.test(s)) return 'cash';
  return 'unknown';
}

const CARD_ROOM_CODES = ['page26', 'page452'];
// 게스트하우스(오마이북) 2개 유닛 — 운영자 확인(2026-07): 전부 무통장입금.
const CASH_ROOM_CODES = ['page8', 'page127', '객실 서쪽', '객실 남쪽'];

function roomBasedPaymentMethod(roomName: string | null): PaymentMethod {
  if (!roomName) return 'unknown';
  const normalized = roomName.replace(/page\s*(\d+)/i, 'page$1');
  const matches = (codes: string[]) =>
    codes.some((c) => {
      if (!normalized.startsWith(c)) return false;
      const next = normalized[c.length];
      return next === undefined || !/\d/.test(next);
    });
  if (matches(CARD_ROOM_CODES)) return 'card';
  if (matches(CASH_ROOM_CODES)) return 'cash';
  return 'unknown';
}

/** 왼쪽 항목들('A(1) 260,000원 + B(2) 3,000원')을 옵션 리스트로. 총액(=뒤)은 제외. */
function parseOptions(s: string): ReservationOption[] {
  const left = s.includes('=') ? s.slice(0, s.indexOf('=')) : s;
  return left
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.match(/^(.*?)\((\d+)\)\s*([\d,]+)\s*원/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({
      name: m[1].trim(),
      qty: Number(m[2]),
      price: Number(m[3].replace(/,/g, '')),
    }));
}

/** 네이버 알림 메일 본문(텍스트) → 정규화 예약. 파싱 실패 시 null(호출부에서 parse_failed 기록). */
export function parseNaverEmail(text: string): ParsedReservation | null {
  const f = extractLabeledFields(text, LABELS);

  const channel_reservation_id = f['예약번호'];
  const dates = f['이용일시'] ? parseTwoDates(f['이용일시']) : null;
  if (!channel_reservation_id || !dates) return null; // 필수 최소값 없으면 실패

  const name = (f['예약자명'] ?? '').replace(/님\s*$/, '').trim() || null;
  // 접수 메일은 '결제예상금액', 취소 메일은 '결제금액' — 같은 계산식 포맷.
  const amountField = f['결제예상금액'] ?? f['결제금액'] ?? '';

  const cancelled =
    Boolean(f['예약취소 일시']) || text.includes('취소 하셨습니다');

  // 확정/결제완료 메일 변형 대응: 결제상태에 '결제완료'가 있으면 paid.
  const payStatus = f['결제상태'] ?? '';
  const payment_status = cancelled
    ? 'none'
    : payStatus.includes('결제완료')
      ? 'paid'
      : 'pending';

  const roomName = f['예약상품'] || null;
  const fieldMethod = classifyPaymentMethod(f['결제수단'] ?? '');
  const method =
    fieldMethod !== 'unknown' ? fieldMethod : roomBasedPaymentMethod(roomName);

  return {
    channel: 'naver',
    channel_reservation_id,
    guest_name: name,
    guest_phone: null, // 네이버 메일엔 없음(설계 확정: 무시)
    room_name: roomName,
    check_in: dates.check_in,
    check_out: dates.check_out,
    amount: parseAmount(amountField),
    options: parseOptions(amountField),
    payment_method: method,
    payment_status,
    cancelled,
    raw_payload: { source: 'naver_email', fields: f, text },
  };
}
