import { describe, it, expect } from 'vitest';
import {
  omaibookPromoEligible,
  appendPromoNote,
  OMAIBOOK_PROMO_NOTE,
} from './promo';

// 기본: 스테이폴리오, 확정메일 KST 2026-09-10, page8, 체크인 2026-11-10(화) — 직원추천 대상.
const base = {
  channel: 'stayfolio',
  roomName: 'page8 - 어떤 책',
  checkIn: '2026-11-10',
  cancelled: false,
  confirmedMailAt: new Date('2026-09-10T02:00:00Z'), // +9h → 2026-09-10
};
const run = (over: Partial<typeof base> = {}) =>
  omaibookPromoEligible({ ...base, ...over });

describe('omaibookPromoEligible — 직원추천', () => {
  it('9월 확정 + 평일 체크인 + 전 객실 → true', () => {
    expect(run()).toBe(true);
  });
  it('체크인 토요일(2026-11-07) → false', () => {
    expect(run({ checkIn: '2026-11-07' })).toBe(false);
  });
  it('체크인이 한글날(10/9) 전날 2026-10-08 → false', () => {
    expect(run({ checkIn: '2026-10-08' })).toBe(false);
  });
  it('체크인이 대체공휴일(9/28) 전날 2026-09-27 → false', () => {
    expect(run({ checkIn: '2026-09-27' })).toBe(false);
  });
  it('확정메일 KST 2026-08-31 → false (기간 전)', () => {
    expect(run({ confirmedMailAt: new Date('2026-08-31T03:00:00Z') })).toBe(false);
  });
  it('확정메일 KST 2026-10-01 + page8 → false (9월 지남, 웰니스 객실 아님)', () => {
    expect(run({ confirmedMailAt: new Date('2026-10-01T03:00:00Z') })).toBe(false);
  });
});

describe('omaibookPromoEligible — 웰니스', () => {
  it('KST 9/20 확정 + page26 + 체크인 토요일 → true (요일 무관)', () => {
    expect(
      run({
        confirmedMailAt: new Date('2026-09-20T03:00:00Z'),
        roomName: 'page26 - 시가 내려앉는 순간',
        checkIn: '2026-11-07',
      }),
    ).toBe(true);
  });
  it('KST 10/10 확정 + page8 → false (대상 객실 아님)', () => {
    expect(
      run({
        confirmedMailAt: new Date('2026-10-10T03:00:00Z'),
        roomName: 'page8 - x',
      }),
    ).toBe(false);
  });
  it('KST 10/19 확정 + page452 → false (기간 지남)', () => {
    expect(
      run({
        confirmedMailAt: new Date('2026-10-19T03:00:00Z'),
        roomName: 'page452 - y',
      }),
    ).toBe(false);
  });
});

describe('omaibookPromoEligible — 공통', () => {
  it('겹침 기간: KST 9/20 확정 + page452 + 평일 체크인 → true', () => {
    expect(
      run({
        confirmedMailAt: new Date('2026-09-20T03:00:00Z'),
        roomName: 'page452 - y',
      }),
    ).toBe(true);
  });
  it('체크인 2026-12-01 → false (11월까지 아님)', () => {
    expect(run({ checkIn: '2026-12-01' })).toBe(false);
  });
  it('channel=naver → false', () => {
    expect(run({ channel: 'naver' })).toBe(false);
  });
  it('cancelled=true → false', () => {
    expect(run({ cancelled: true })).toBe(false);
  });
});

describe('appendPromoNote', () => {
  it('null → 문구', () => {
    expect(appendPromoNote(null)).toBe(OMAIBOOK_PROMO_NOTE);
  });
  it('빈 문자열 → 문구', () => {
    expect(appendPromoNote('')).toBe(OMAIBOOK_PROMO_NOTE);
  });
  it('기존 메모 → 개행 후 이어붙임', () => {
    expect(appendPromoNote('직원 메모')).toBe(`직원 메모\n${OMAIBOOK_PROMO_NOTE}`);
  });
  it('이미 문구 포함 → null', () => {
    expect(appendPromoNote(`손님 주의\n${OMAIBOOK_PROMO_NOTE}`)).toBe(null);
  });
});
