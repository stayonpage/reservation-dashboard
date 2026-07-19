// 대시보드 표시용 포맷 유틸(공용 — 컴포넌트에서 중복 구현 방지).

import type { ReservationOption } from './types';

/** 옵션 목록 → '조식_멋진하루 1인×2, 웰컴키트' 같은 한 줄 요약. 수량 1개는 ×표시 생략. */
export function formatOptions(options: ReservationOption[]): string {
  return options.map((o) => (o.qty > 1 ? `${o.name}×${o.qty}` : o.name)).join(', ');
}

export function formatWon(amount: number | null): string {
  if (amount == null) return '-';
  return `₩${amount.toLocaleString('ko-KR')}`;
}

/** '2026-07-10' → '7/10(금)' */
export function formatDateShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00+09:00');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]})`;
}

export function formatDateRange(checkIn: string, checkOut: string): string {
  return `${formatDateShort(checkIn)} ~ ${formatDateShort(checkOut)}`;
}

function daysBetween(a: string, b: string): number {
  const d1 = new Date(a + 'T00:00:00+09:00');
  const d2 = new Date(b + 'T00:00:00+09:00');
  return Math.round((d2.getTime() - d1.getTime()) / 86_400_000);
}

/** 특정 날짜가 몇 박째 숙박인지 — '연박(2/3)'. 1박(연박 아님)이면 null.
 *  달력·일주일예약 둘 다 이 하나로 계산해 서로 안 어긋나게 한다. */
export function stayNightLabel(
  checkIn: string,
  checkOut: string,
  date: string,
): string | null {
  const totalNights = daysBetween(checkIn, checkOut);
  if (totalNights <= 1) return null;
  const nightIndex = daysBetween(checkIn, date) + 1;
  return `연박(${nightIndex}/${totalNights})`;
}

/** 상대시간 — '3분 전' / '2시간 전' / '어제' 등. 무동기 경고 판단에도 사용. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

/** 실패모드2(무음 유실) 대응: 마지막 동기화가 이 시간을 넘으면 경고 표시. */
export const STALE_SYNC_THRESHOLD_HOURS = 3;

export function isStale(lastSyncIso: string, now: Date = new Date()): boolean {
  const hrs = (now.getTime() - new Date(lastSyncIso).getTime()) / 3_600_000;
  return hrs >= STALE_SYNC_THRESHOLD_HOURS;
}
