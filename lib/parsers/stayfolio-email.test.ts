import { describe, it, expect } from 'vitest';
import { parseStayfolioEmail, withStayfolioSubject } from './stayfolio-email';

// 실제 스테이폴리오 예약 알림 이메일 형식(2026-07 확보, Gmail IMAP 직접 조회)을 그대로 유지하되,
// 개인정보(이름·전화번호·이메일)는 가상 값으로 치환한 픽스처.
// 구글 캘린더 서비스 중단 후 이메일로 전환됨. 예약번호는 본문에 없음(운영자 확인:
// "신청 메일만 온다" — 별도 확정/취소 메일 없음, 이 메일 자체가 이미 결제완료 상태).
const SAMPLE = `스테이온페이지(page26 - 시가 내려앉는 순간) 2026년 7월 29일 ~ 2026년 7월 30일


안녕하세요. 스테이폴리오입니다. [https://www.stayfolio.com/static/mail_asset/resv-title.png]



Guest Information 성함 홍길동 연락처 +821000000000 이메일 test.guest@example.com 객실명 page26 - 시가
내려앉는 순간 투숙인원 성인: 2명 / 아동: 0명 / 영아: 0명 체크인 2026년 7월 29일 오후 3시 체크아웃 2026년 7월 30일
오전 10시 옵션 조식_멋진하루 1인 (￦12000) * 1 석식룸서비스_선데이로스트 1인 (￦22000) * 1
기념일패키지_석식2인(매장이용) (￦140000) * 1 요청사항 요청사항이 없습니다.



결제정보 결제금액 434,000원 결제방법 네이버페이 중개수수료 퍼센트 11.0% 중개수수료 47,740원 정산금액 386,260원 정산 입금일
매월 2회 정산되며, 15일과 말일의 다음 영업일에 정산 및 지급됩니다.`;

describe('parseStayfolioEmail', () => {
  it('실샘플 형식에서 모든 필드를 정확히 추출한다', () => {
    const r = parseStayfolioEmail(SAMPLE);
    expect(r).not.toBeNull();
    expect(r!.channel).toBe('stayfolio');
    expect(r!.guest_name).toBe('홍길동');
    expect(r!.guest_phone).toBe('01000000000'); // +82 정규화
    expect(r!.room_name).toBe('page26 - 시가 내려앉는 순간');
    expect(r!.check_in).toBe('2026-07-29'); // '2026년 7월 29일' → 파싱
    expect(r!.check_out).toBe('2026-07-30');
    expect(r!.amount).toBe(434000);
  });

  it('예약번호가 없어 guest_email|checkin|checkout|room 합성키를 사용한다', () => {
    const r = parseStayfolioEmail(SAMPLE)!;
    expect(r.channel_reservation_id).toBe(
      'test.guest@example.com|2026-07-29|2026-07-30|page26 - 시가 내려앉는 순간',
    );
  });

  it('전각 원화기호(￦)로 표시된 옵션 3개를 정확히 분해한다(괄호 포함 이름도 보존)', () => {
    const r = parseStayfolioEmail(SAMPLE)!;
    expect(r.options).toHaveLength(3);
    expect(r.options[0]).toEqual({ name: '조식_멋진하루 1인', qty: 1, price: 12000 });
    expect(r.options[1]).toEqual({
      name: '석식룸서비스_선데이로스트 1인',
      qty: 1,
      price: 22000,
    });
    // 이름 안에 자체 괄호 '(매장이용)'가 있어도 가격 괄호와 혼동하지 않는다.
    expect(r.options[2]).toEqual({
      name: '기념일패키지_석식2인(매장이용)',
      qty: 1,
      price: 140000,
    });
  });

  it('네이버페이는 전자결제로 card 취급, 신청 시점에 이미 결제완료로 간주한다', () => {
    const r = parseStayfolioEmail(SAMPLE)!;
    expect(r.payment_method).toBe('card');
    expect(r.payment_status).toBe('paid'); // → ingest 시 바로 confirmed
    expect(r.cancelled).toBe(false);
  });

  it('체크인/체크아웃 날짜 없으면 null', () => {
    expect(parseStayfolioEmail('관련 없는 텍스트')).toBeNull();
  });

  it('"요청사항이 없습니다." 는 guest_request null', () => {
    expect(parseStayfolioEmail(SAMPLE)!.guest_request).toBeNull();
  });

  it('요청사항 내용이 있으면 그대로 담는다', () => {
    const withReq = SAMPLE.replace(
      '요청사항 요청사항이 없습니다.',
      '요청사항 아기 침대 요청드립니다',
    );
    expect(parseStayfolioEmail(withReq)!.guest_request).toBe(
      '아기 침대 요청드립니다',
    );
  });
});

// 2026-10-11 실사례: 김민주님이 26호 예약 → 확정 전 취소 → 452호 재예약. 취소 메일은 본문이 예약 메일과
// 같은 형식(결제금액만 0원)이고 "취소"는 제목에만 있어서, 본문만 보는 파서가 취소로 못 알아봤다.
describe('withStayfolioSubject — 제목의 취소 표시를 본문 앞에 붙인다', () => {
  const BOOKING_SUBJECT =
    '스테이폴리오 홍길동(test.guest@example.com)님의 예약내용입니다. - 스테이온페이지(page26 - 시가 내려앉는 순간) 2026년 7월 29일 ~ 2026년 7월 30일';
  const CANCEL_SUBJECT =
    '스테이폴리오 홍길동(test.guest@example.com)님이 확정 전 예약을 취소하였습니다. - 스테이온페이지(page26 - 시가 내려앉는 순간) 2026년 7월 29일 ~ 2026년 7월 30일';
  const CANCEL_BODY = SAMPLE.replace('결제금액 434,000원', '결제금액 0원');

  it('★ 취소 제목이면 취소로 파싱된다', () => {
    const r = parseStayfolioEmail(withStayfolioSubject(CANCEL_SUBJECT, CANCEL_BODY))!;
    expect(r.cancelled).toBe(true);
    expect(r.payment_status).toBe('none');
  });

  it('★ 취소 메일의 예약 키는 원래 예약 메일과 같다(같은 예약을 취소로 갱신)', () => {
    const booking = parseStayfolioEmail(withStayfolioSubject(BOOKING_SUBJECT, SAMPLE))!;
    const cancel = parseStayfolioEmail(withStayfolioSubject(CANCEL_SUBJECT, CANCEL_BODY))!;
    expect(cancel.channel_reservation_id).toBe(booking.channel_reservation_id);
    expect(cancel.room_name).toBe(booking.room_name);
    expect(cancel.guest_name).toBe('홍길동');
  });

  it('★ 회귀: 일반 예약 제목은 취소로 오인하지 않는다', () => {
    const r = parseStayfolioEmail(withStayfolioSubject(BOOKING_SUBJECT, SAMPLE))!;
    expect(r.cancelled).toBe(false);
    expect(r.payment_status).toBe('paid');
    expect(r.amount).toBe(434000);
  });

  it('제목이 없거나 비어 있으면 본문을 그대로 돌려준다', () => {
    expect(withStayfolioSubject(undefined, SAMPLE)).toBe(SAMPLE);
    expect(withStayfolioSubject('', SAMPLE)).toBe(SAMPLE);
  });

  it('"취소되었습니다" 표현도 취소로 본다', () => {
    const r = parseStayfolioEmail(
      withStayfolioSubject('스테이폴리오 홍길동님의 예약이 취소되었습니다. - 스테이온페이지(page26)', CANCEL_BODY),
    )!;
    expect(r.cancelled).toBe(true);
  });

  it('손님 이름에 "취소"가 들어 있어도 제목의 취소 문구 판정만 쓴다(예약 제목은 취소 아님)', () => {
    const r = parseStayfolioEmail(
      withStayfolioSubject('스테이폴리오 취소선(a@b.com)님의 예약내용입니다. - 스테이온페이지(page26)', SAMPLE),
    )!;
    expect(r.cancelled).toBe(false);
  });
});
