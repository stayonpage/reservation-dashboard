import { describe, it, expect } from 'vitest';
import { validateDateChange, defaultCheckOut, addDaysISO } from './change-dates';

describe('addDaysISO', () => {
  it('월/연 경계를 넘겨 더한다', () => {
    expect(addDaysISO('2026-12-18', 1)).toBe('2026-12-19');
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('defaultCheckOut', () => {
  it('기존 박수를 유지한 체크아웃 날짜를 제안한다(11/20~11/22 2박 → 12/18 이면 12/20)', () => {
    expect(defaultCheckOut('2026-11-20', '2026-11-22', '2026-12-18')).toBe('2026-12-20');
  });
  it('기존 박수가 0 이하이면 1박으로 제안한다', () => {
    expect(defaultCheckOut('2026-11-20', '2026-11-20', '2026-12-18')).toBe('2026-12-19');
  });
});

describe('validateDateChange', () => {
  const cur = { check_in: '2026-11-20', check_out: '2026-11-21' };
  it('정상 변경은 null(오류 없음)', () => {
    expect(validateDateChange(cur, '2026-12-18', '2026-12-19')).toBeNull();
  });
  it('날짜가 비어 있으면 오류', () => {
    expect(validateDateChange(cur, '', '2026-12-19')).toMatch(/날짜/);
  });
  it('체크아웃이 체크인보다 늦지 않으면 오류', () => {
    expect(validateDateChange(cur, '2026-12-19', '2026-12-19')).toMatch(/체크아웃/);
    expect(validateDateChange(cur, '2026-12-19', '2026-12-18')).toMatch(/체크아웃/);
  });
  it('현재와 같은 날짜면 오류', () => {
    expect(validateDateChange(cur, '2026-11-20', '2026-11-21')).toMatch(/같은/);
  });
});
