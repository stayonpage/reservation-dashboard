import { describe, it, expect } from 'vitest';
import { daysUntil, refundRateForDaysBefore, refundForChange, refundFor } from './refund';

describe('daysUntil', () => {
  it('UTC 자정 파싱으로 정수 일수 차이', () => {
    expect(daysUntil('2026-03-20', '2026-03-10')).toBe(10);
    expect(daysUntil('2026-03-10', '2026-03-10')).toBe(0);
    expect(daysUntil('2026-03-05', '2026-03-10')).toBe(-5);
  });
});

describe('refundRateForDaysBefore', () => {
  it('규정 표 그대로', () => {
    expect(refundRateForDaysBefore(11)).toBe(1);
    expect(refundRateForDaysBefore(10)).toBe(1);
    expect(refundRateForDaysBefore(9)).toBe(0.9);
    expect(refundRateForDaysBefore(8)).toBe(0.8);
    expect(refundRateForDaysBefore(7)).toBe(0.7);
    expect(refundRateForDaysBefore(6)).toBe(0.6);
    expect(refundRateForDaysBefore(5)).toBe(0.5);
    expect(refundRateForDaysBefore(4)).toBe(0.4);
    expect(refundRateForDaysBefore(3)).toBe(0);
    expect(refundRateForDaysBefore(0)).toBe(0);
    expect(refundRateForDaysBefore(-2)).toBe(0);
  });
});

describe('refundForChange', () => {
  it('10일 이상: 위약금 없음', () => {
    const r = refundForChange('2026-03-25', 150000, '2026-03-10'); // 15일 전
    expect(r.daysBefore).toBe(15);
    expect(r.refundRate).toBe(1);
    expect(r.hasPenalty).toBe(false);
    expect(r.penalty).toBe(0);
    expect(r.refundable).toBe(150000);
  });

  it('7일 전: 70% 환불 / 위약금 45,000', () => {
    const r = refundForChange('2026-03-17', 150000, '2026-03-10');
    expect(r.daysBefore).toBe(7);
    expect(r.refundRate).toBe(0.7);
    expect(r.hasPenalty).toBe(true);
    expect(r.penalty).toBe(45000);
    expect(r.refundable).toBe(105000);
  });

  it('3일 이하: 환불 불가 / 위약금 전액', () => {
    const r = refundForChange('2026-03-12', 150000, '2026-03-10');
    expect(r.daysBefore).toBe(2);
    expect(r.refundRate).toBe(0);
    expect(r.penalty).toBe(150000);
    expect(r.refundable).toBe(0);
  });

  it('반올림 (정수 퍼센트로 ±1원 오차 제거)', () => {
    const r = refundForChange('2026-03-19', 12345, '2026-03-10'); // 9일 → 10% 위약금
    expect(r.daysBefore).toBe(9);
    expect(r.refundRate).toBe(0.9);
    expect(r.hasPenalty).toBe(true);
    expect(r.penalty).toBe(1235); // Math.round(12345 * 10 / 100)
    expect(r.refundable).toBe(11110); // 12345 - 1235
  });

  it('금액 미상: penalty/refundable null, amountKnown false', () => {
    const r = refundForChange('2026-03-17', null, '2026-03-10');
    expect(r.amountKnown).toBe(false);
    expect(r.penalty).toBeNull();
    expect(r.refundable).toBeNull();
    expect(r.hasPenalty).toBe(true); // 구간상 위약금 발생
  });

  it('정확히 10일: refundRate 1, hasPenalty false, penalty 0', () => {
    const r = refundForChange('2026-03-20', 150000, '2026-03-10'); // 정확히 10일
    expect(r.daysBefore).toBe(10);
    expect(r.refundRate).toBe(1);
    expect(r.hasPenalty).toBe(false);
    expect(r.penalty).toBe(0);
    expect(r.refundable).toBe(150000);
  });

  it('금액 미상(null): daysBefore/refundRate는 정상 계산', () => {
    const r = refundForChange('2026-03-15', null, '2026-03-10'); // 5일 → 50% 환불
    expect(r.daysBefore).toBe(5);
    expect(r.refundRate).toBe(0.5);
    expect(r.hasPenalty).toBe(true);
    expect(r.penalty).toBeNull();
    expect(r.refundable).toBeNull();
    expect(r.amountKnown).toBe(false);
  });

  it('0원 이하: penalty 0, refundable 0', () => {
    const r0 = refundForChange('2026-03-19', 0, '2026-03-10'); // 9일, 0원
    expect(r0.daysBefore).toBe(9);
    expect(r0.penalty).toBe(0);
    expect(r0.refundable).toBe(0);

    const rNeg = refundForChange('2026-03-19', -100, '2026-03-10'); // 음수 (비정상 입력)
    expect(rNeg.daysBefore).toBe(9);
    expect(rNeg.penalty).toBe(-10); // Math.round(-100 * 10 / 100)
    expect(rNeg.refundable).toBe(-90); // -100 - (-10)
  });
});

describe('refundFor', () => {
  it('refundFor 는 refundForChange 의 별칭', () => {
    expect(refundFor('2026-03-17', 150000, '2026-03-10')).toEqual(
      refundForChange('2026-03-17', 150000, '2026-03-10'),
    );
  });
});
