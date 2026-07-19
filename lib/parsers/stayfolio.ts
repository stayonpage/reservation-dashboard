import type {
  ParsedReservation,
  ReservationOption,
  PaymentMethod,
  PaymentStatus,
} from '../types';
import { parseTwoDates, normalizeKrPhone, firstAmount } from './util';

// 스테이폴리오 예약 알림 SMS 파서.
//
// 실제 샘플(2026-07 확보):
//   [Web발신]
//   [스테이폴리오, (page452 - 지금, 나를 세우는 시간) 예약신청]
//   스테이온페이지(...)의 새로운 예약 신청이 접수 되었습니다.
//   예약날짜 : 2026.07.10(금) ~ 2026.07.11(토) (1박)
//   예약객실 : page452 - 지금, 나를 세우는 시간
//   예약자명 : 이하윤(775617172)
//   전화번호 : +821096406605
//   결제금액 : ₩176,000 (₩152,000 ₩24,000)
//   결제상태 : 카드 결제 결제완료
//   옵션 : 조식_멋진하루 1인 (₩12000) * 2
//   예약확정/취소 : https://host.stayfolio.com/bookings/775617172
//
// 네이버와 달리 전화번호·실명 다 있고, 카드 선결제(결제완료) → 바로 confirmed 대상.

/** 'label : value' 한 줄 값 추출. */
function line(text: string, label: string): string | null {
  const m = text.match(new RegExp(label + '\\s*[:：]\\s*([^\\n]+)'));
  return m ? m[1].trim() : null;
}

/** '조식_멋진하루 1인 (₩12000) * 2' → {name, price, qty}. 콤마로 여러 개 지원. */
function parseOptions(s: string): ReservationOption[] {
  return s
    .split(/[,，]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.match(/^(.*?)\(\s*₩?\s*([\d,]+)\s*\)\s*\*\s*(\d+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({
      name: m[1].trim(),
      price: Number(m[2].replace(/,/g, '')),
      qty: Number(m[3]),
    }));
}

function classifyPayment(statusLine: string): {
  method: PaymentMethod;
  status: PaymentStatus;
} {
  const method: PaymentMethod = statusLine.includes('카드')
    ? 'card'
    : /현금|계좌|무통장/.test(statusLine)
      ? 'cash'
      : 'unknown';
  const status: PaymentStatus = statusLine.includes('완료') ? 'paid' : 'pending';
  return { method, status };
}

export function parseStayfolioSms(text: string): ParsedReservation | null {
  const dateLine = line(text, '예약날짜');
  const dates = dateLine ? parseTwoDates(dateLine) : null;

  // 예약번호: 확정 URL(/bookings/{id}) 우선, 없으면 예약자명 괄호 안 숫자.
  const nameLine = line(text, '예약자명'); // 이하윤(775617172)
  const id =
    text.match(/bookings\/(\d+)/)?.[1] ??
    nameLine?.match(/\((\d+)\)/)?.[1] ??
    null;
  if (!id || !dates) return null;

  const phoneLine = line(text, '전화번호');
  const payStatusLine = line(text, '결제상태') ?? '';
  const { method, status } = classifyPayment(payStatusLine);
  const optLine = line(text, '옵션');

  return {
    channel: 'stayfolio',
    channel_reservation_id: id,
    guest_name: nameLine ? nameLine.replace(/\(\d+\)\s*$/, '').trim() : null,
    guest_phone: phoneLine ? normalizeKrPhone(phoneLine) : null,
    room_name: line(text, '예약객실'),
    check_in: dates.check_in,
    check_out: dates.check_out,
    amount: firstAmount(line(text, '결제금액') ?? ''), // 첫 금액 = 총액
    options: optLine ? parseOptions(optLine) : [],
    payment_method: method,
    payment_status: status,
    // 스테이폴리오 취소 문자 포맷은 아직 실샘플 미확보 — 확보되면 감지 로직 추가.
    cancelled: /취소/.test(text.slice(0, 100)),
    raw_payload: { source: 'stayfolio_sms', text },
  };
}
