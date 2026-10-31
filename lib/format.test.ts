import { describe, it, expect } from 'vitest';
import { formatWon, formatDateRange, isStale, timeAgo, stayNightLabel } from './format';

describe('formatWon', () => {
  it('천단위 콤마와 원 표시', () => {
    expect(formatWon(301000)).toBe('₩301,000');
    expect(formatWon(0)).toBe('₩0');
  });
  it('null은 대시', () => {
    expect(formatWon(null)).toBe('-');
  });
});

describe('formatDateRange', () => {
  it('요일 포함 짧은 형식', () => {
    // 2026-07-10은 금요일
    expect(formatDateRange('2026-07-10', '2026-07-11')).toBe(
      '7/10(금) ~ 7/11(토)',
    );
  });
});

describe('isStale', () => {
  const now = new Date('2026-07-09T15:00:00+09:00');

  it('임계값(3시간) 미만이면 정상', () => {
    expect(isStale('2026-07-09T13:30:00+09:00', now)).toBe(false);
  });

  it('임계값 이상이면 stale(무음유실 경고 대상)', () => {
    expect(isStale('2026-07-09T11:00:00+09:00', now)).toBe(true);
  });

  it('밤 휴식(22~06시)을 지난 아침 첫 폴링 직후는 정상', () => {
    // 어제 21:30 마지막 폴링 → 오늘 06:10, 실제 경과 8시간 40분이지만 휴식 8시간 제외
    expect(
      isStale('2026-07-08T21:30:00+09:00', new Date('2026-07-09T06:10:00+09:00')),
    ).toBe(false);
  });

  it('한밤중(03:00)에도 21:30 폴링이면 정상', () => {
    expect(
      isStale('2026-07-08T21:30:00+09:00', new Date('2026-07-09T03:00:00+09:00')),
    ).toBe(false);
  });

  it('아침 06:00 폴링이 빠져 09:30이 되면 stale', () => {
    // 21:30 이후 휴식 8시간을 빼도 3시간 30분 경과
    expect(
      isStale('2026-07-08T21:30:00+09:00', new Date('2026-07-09T09:30:00+09:00')),
    ).toBe(true);
  });
});

describe('stayNightLabel', () => {
  it('1박(연박 아님)이면 null', () => {
    expect(stayNightLabel('2026-07-18', '2026-07-19', '2026-07-18')).toBeNull();
  });

  it('연박이면 해당 날짜가 몇 박째인지 표시', () => {
    // 7/18 체크인 ~ 7/21 체크아웃 = 3박. 7/19는 2박째.
    expect(stayNightLabel('2026-07-18', '2026-07-21', '2026-07-18')).toBe('연박(1/3)');
    expect(stayNightLabel('2026-07-18', '2026-07-21', '2026-07-19')).toBe('연박(2/3)');
    expect(stayNightLabel('2026-07-18', '2026-07-21', '2026-07-20')).toBe('연박(3/3)');
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-07-09T15:00:00+09:00');
  it('1분 미만은 방금', () => {
    expect(timeAgo('2026-07-09T14:59:30+09:00', now)).toBe('방금');
  });
  it('분 단위', () => {
    expect(timeAgo('2026-07-09T14:45:00+09:00', now)).toBe('15분 전');
  });
  it('시간 단위', () => {
    expect(timeAgo('2026-07-09T12:00:00+09:00', now)).toBe('3시간 전');
  });
});
