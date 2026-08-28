// 취소(변경)/환불 규정 계산 — 순수 함수. 스키마·DB 영향 없음(표시 전용).
// 규정: 체크인까지 남은 일수로 환불율이 정해지고, 위약금 = 총액 × (1 - 환불율).
//
// 날짜 계산은 format.ts 규칙 준수: 'T00:00:00Z' 파싱 + getUTC* 만.
import { kstTodayISO } from './format';

export interface RefundInfo {
  daysBefore: number;
  refundRate: number;
  refundable: number | null;
  penalty: number | null;
  hasPenalty: boolean;
  amountKnown: boolean;
}

/** targetISO - fromISO 를 '일' 단위 정수로. 둘 다 'YYYY-MM-DD'. */
export function daysUntil(targetISO: string, fromISO: string): number {
  const t = new Date(targetISO + 'T00:00:00Z').getTime();
  const f = new Date(fromISO + 'T00:00:00Z').getTime();
  return Math.round((t - f) / 86_400_000);
}

const RATE_BY_DAYS: Record<number, number> = {
  9: 0.9, 8: 0.8, 7: 0.7, 6: 0.6, 5: 0.5, 4: 0.4,
};

/** 체크인까지 남은 일수 → 환불율(0~1). */
export function refundRateForDaysBefore(daysBefore: number): number {
  if (daysBefore >= 10) return 1;
  if (daysBefore <= 3) return 0;
  return RATE_BY_DAYS[daysBefore] ?? 0;
}

/**
 * @param baseCheckIn 위약금 기준이 되는 체크인('YYYY-MM-DD') — 보통 변경 전(직전) 체크인.
 * @param totalAmount 총 결제금액(원, 옵션 포함). 모르면 null.
 * @param todayISO 기준일(기본: 한국시간 오늘).
 */
export function refundForChange(
  baseCheckIn: string,
  totalAmount: number | null,
  todayISO: string = kstTodayISO(),
): RefundInfo {
  const daysBefore = daysUntil(baseCheckIn, todayISO);
  const refundRate = refundRateForDaysBefore(daysBefore);
  const amountKnown = totalAmount != null;
  const penalty = amountKnown
    ? Math.round((totalAmount as number) * (1 - refundRate))
    : null;
  const refundable =
    amountKnown && penalty != null ? (totalAmount as number) - penalty : null;
  return {
    daysBefore,
    refundRate,
    refundable,
    penalty,
    hasPenalty: refundRate < 1,
    amountKnown,
  };
}
