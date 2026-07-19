import { describe, it, expect } from 'vitest';
import { parseStayfolioSms } from './stayfolio';

// 실제 스테이폴리오 예약 알림 SMS(2026-07 확보) 형식 그대로 — 개인정보는 가상 값으로 치환.
const SAMPLE = `[Web발신]
[스테이폴리오, (page452 - 지금, 나를 세우는 시간) 예약신청]
스테이온페이지(page452 - 지금, 나를 세우는 시간)의 새로운 예약 신청이 접수 되었습니다.

예약날짜 : 2026.07.10(금) ~ 2026.07.11(토) (1박)
예약객실 : page452 - 지금, 나를 세우는 시간
예약자명 : 홍길동(100000001)
전화번호 : +821000000000
결제금액 : ₩176,000 (₩152,000 ₩24,000)
결제상태 : 카드 결제 결제완료
옵션 : 조식_멋진하루 1인 (₩12000) * 2
-
예약확정/취소 : https://host.stayfolio.com/bookings/100000001
전체신청내역 : https://host.stayfolio.com/places/stay-on-page/bookings`;

describe('parseStayfolioSms', () => {
  it('실샘플에서 모든 필드를 정확히 추출한다', () => {
    const r = parseStayfolioSms(SAMPLE);
    expect(r).not.toBeNull();
    expect(r!.channel).toBe('stayfolio');
    expect(r!.channel_reservation_id).toBe('100000001'); // URL에서
    expect(r!.guest_name).toBe('홍길동'); // 괄호 예약번호 제거
    expect(r!.guest_phone).toBe('01000000000'); // +82 정규화
    expect(r!.room_name).toBe('page452 - 지금, 나를 세우는 시간');
    expect(r!.check_in).toBe('2026-07-10');
    expect(r!.check_out).toBe('2026-07-11');
    expect(r!.amount).toBe(176000); // 내역 아닌 총액
  });

  it('카드 선결제(결제완료)를 card/paid로 분류한다', () => {
    const r = parseStayfolioSms(SAMPLE)!;
    expect(r.payment_method).toBe('card');
    expect(r.payment_status).toBe('paid'); // → ingest 시 바로 confirmed
  });

  it('옵션 (₩12000) * 2 형식을 분해한다', () => {
    const r = parseStayfolioSms(SAMPLE)!;
    expect(r.options).toHaveLength(1);
    expect(r.options[0]).toEqual({
      name: '조식_멋진하루 1인',
      price: 12000,
      qty: 2,
    });
  });

  it('예약번호·날짜 없으면 null', () => {
    expect(parseStayfolioSms('관련 없는 문자')).toBeNull();
  });
});
