import { roomCodeOf } from './rooms';

export const OMAIBOOK_PROMO_NOTE = '오마이북 3만원 상품권 증정';

/**
 * 2026년 9~11월 한국 공휴일 (대체공휴일 포함). 프로모션 범위 밖 날짜는 불필요.
 * 추석 연휴 9/24(목)·9/25(금)·9/26(토) + 대체 9/28(월),
 * 개천절 10/3(토) + 대체 10/5(월), 한글날 10/9(금). 11월 공휴일 없음.
 */
export const PROMO_HOLIDAYS_2026 = new Set([
  '2026-09-24',
  '2026-09-25',
  '2026-09-26',
  '2026-09-28',
  '2026-10-03',
  '2026-10-05',
  '2026-10-09',
]);

/** Date → 한국시간 기준 'YYYY-MM-DD'. */
function kstDateString(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 다음날 'YYYY-MM-DD'. */
function nextDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 가 토요일인가. */
function isSaturday(iso: string): boolean {
  return new Date(iso + 'T00:00:00Z').getUTCDay() === 6;
}

/**
 * 오마이북 3만원 상품권 프로모션 대상인가.
 * 직원추천(확정 9/1~9/30, 전 객실, 토·공휴일 전날 체크인 제외) 또는
 * 웰니스(확정 9/14~10/18, page26·452, 요일 제한 없음) 중 하나라도 충족하면 true.
 * 두 프로모션 문구가 같아 어느 쪽인지는 구분하지 않는다.
 */
export function omaibookPromoEligible(input: {
  channel: string;
  roomName: string | null;
  checkIn: string; // 'YYYY-MM-DD'
  cancelled: boolean;
  confirmedMailAt: Date; // 스테이폴리오 확정메일 Date 헤더
}): boolean {
  const { channel, roomName, checkIn, cancelled, confirmedMailAt } = input;
  if (channel !== 'stayfolio' || cancelled) return false;
  if (checkIn > '2026-11-30') return false; // 11월까지 투숙

  const applyDate = kstDateString(confirmedMailAt);

  // 웰니스: 확정일 9/14~10/18 + 객실 page26·452
  if (applyDate >= '2026-09-14' && applyDate <= '2026-10-18') {
    const code = roomCodeOf(roomName);
    if (code === 'page26' || code === 'page452') return true;
  }

  // 직원추천: 확정일 9/1~9/30 + 체크인 토요일 아님 + 다음날 공휴일 아님
  if (applyDate >= '2026-09-01' && applyDate <= '2026-09-30') {
    if (!isSaturday(checkIn) && !PROMO_HOLIDAYS_2026.has(nextDay(checkIn))) {
      return true;
    }
  }

  return false;
}

/**
 * 비고(notes)에 프로모션 문구를 이어붙인 새 값. 변경 불필요면 null.
 * - 이미 문구 포함 → null
 * - 비어있음 → 문구만
 * - 그 외 → 기존값 + 개행 + 문구
 */
export function appendPromoNote(existing: string | null): string | null {
  if (existing && existing.includes(OMAIBOOK_PROMO_NOTE)) return null;
  if (!existing) return OMAIBOOK_PROMO_NOTE;
  return `${existing}\n${OMAIBOOK_PROMO_NOTE}`;
}
