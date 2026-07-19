import { describe, it, expect } from 'vitest';
import { parseNaverEmail } from './naver';

// 실제 네이버 예약 알림 메일(2026-07 확보) — 마스킹·전화번호 부재 특성 포함.
const SAMPLE = `새로운 예약이 접수 되었습니다.
예약자명 김*희님
예약신청 일시 2026.07.08. 23:48:53
예약번호 1287059074
예약상품 page 8 - 숨결같은 선율에 머무는 하루
이용일시 2026.08.03.(월)~2026.08.04.(화) (1박 2일)
결제상태 -
결제수단 -
결제예상금액 page 8 - 숨결같은 선율에 머무는 하루(1) 260,000원 + 웰컴키트(1) 3,000원 + 석식룸서비스_굿데이라이스 1인(1) 16,000원 + 석식룸서비스_선데이로스트 1인(1) 22,000원 = 301,000원
요청사항 -`;

describe('parseNaverEmail', () => {
  it('실샘플에서 모든 필드를 정확히 추출한다', () => {
    const r = parseNaverEmail(SAMPLE);
    expect(r).not.toBeNull();
    expect(r!.channel).toBe('naver');
    expect(r!.channel_reservation_id).toBe('1287059074');
    expect(r!.guest_name).toBe('김*희'); // 님 제거, 마스킹은 유지
    expect(r!.guest_phone).toBeNull(); // 네이버 메일엔 전화번호 없음
    expect(r!.room_name).toBe('page 8 - 숨결같은 선율에 머무는 하루');
    expect(r!.check_in).toBe('2026-08-03');
    expect(r!.check_out).toBe('2026-08-04');
    expect(r!.amount).toBe(301000); // = 뒤 총액
    expect(r!.payment_status).toBe('pending');
  });

  it('결제수단이 비어있으면(접수 단계) 방 코드로 카드/현금을 유추한다(page8=현금)', () => {
    // 운영자 확인(2026-07): page26·452는 카드 즉시결제, page8·127은 무통장입금/현장결제.
    expect(parseNaverEmail(SAMPLE)!.payment_method).toBe('cash');
  });

  it('옵션(결제내역)을 항목·수량·단가로 분해한다', () => {
    const r = parseNaverEmail(SAMPLE)!;
    expect(r.options).toHaveLength(4);
    expect(r.options[1]).toEqual({ name: '웰컴키트', qty: 1, price: 3000 });
    expect(r.options[2]).toEqual({
      name: '석식룸서비스_굿데이라이스 1인',
      qty: 1,
      price: 16000,
    });
  });

  it('예약번호·날짜 없으면 null (파싱 실패 → 호출부에서 parse_failed)', () => {
    expect(parseNaverEmail('관련 없는 텍스트')).toBeNull();
    expect(parseNaverEmail('예약번호 123')).toBeNull(); // 날짜 없음
  });

  it('접수 메일은 cancelled=false', () => {
    expect(parseNaverEmail(SAMPLE)!.cancelled).toBe(false);
  });
});

// 실제 취소 메일(2026-07 DB 수신분) — 접수 메일과 라벨이 다르다('결제금액', '예약취소 일시').
const CANCEL_SAMPLE = `스테이 온 페이지 북스테이
고객님이 예약을 취소 하셨습니다.
예약취소내역을 확인해 보세요.
예약자명 소*옥님
예약신청 일시 2026.06.13. 22:16:59
예약취소 일시 2026.06.13. 22:18:28
예약취소내역
예약번호 1264140444
예약상품 page 26 - 시가 내려앉는 순간
이용일시 2026.08.13.(목)~2026.08.14.(금) (1박 2일)
결제상태 환불완료
결제수단 신용카드 간편결제
환불금액 294,000원
환불수수료 0원(결제금액의 0%)
결제금액 page 26 - 시가 내려앉는 순간(1) 260,000원 + 조식_멋진하루 1인(1) 12,000원 + 조식_달콤하루 1인(1) 12,000원 + 다독다독(1) 10,000원 = 294,000원
매장방문결제
취소사유 카드로변경`;

describe('parseNaverEmail — 취소 메일', () => {
  it('취소를 감지하고 같은 예약번호로 정규화한다', () => {
    const r = parseNaverEmail(CANCEL_SAMPLE);
    expect(r).not.toBeNull();
    expect(r!.cancelled).toBe(true);
    expect(r!.channel_reservation_id).toBe('1264140444'); // 접수 메일과 동일 → upsert로 취소 전환
    expect(r!.check_in).toBe('2026-08-13');
    expect(r!.check_out).toBe('2026-08-14');
  });

  it("'결제금액' 라벨에서도 총액·옵션을 추출한다(접수 메일의 '결제예상금액' 폴백)", () => {
    const r = parseNaverEmail(CANCEL_SAMPLE)!;
    expect(r.amount).toBe(294000);
    expect(r.options).toHaveLength(4);
    expect(r.options[3]).toEqual({ name: '다독다독', qty: 1, price: 10000 });
  });

  // 실사례 버그(2026-07): "환불수수료 0원(결제금액의 0%)" 문장 속 "결제금액" 글자를 실제
  // "결제금액" 라벨로 오인해서, 그 뒤 결제내역이 엉뚱하게 밀려 옵션 이름이 깨졌었다
  // ("의 0%) 결제금액 page 26 - 시가 내려앉는 순간"). 줄 시작 기준 라벨 매칭으로 수정됨.
  it('환불수수료 문장 속 "결제금액" 글자에 낚이지 않고 진짜 결제금액 라벨을 찾는다', () => {
    const r = parseNaverEmail(CANCEL_SAMPLE)!;
    expect(r.options[0]).toEqual({
      name: 'page 26 - 시가 내려앉는 순간',
      qty: 1,
      price: 260000,
    });
    expect(r.options.some((o) => o.name.includes('결제금액의'))).toBe(false);
  });

  it('환불완료 상태는 payment_status=none', () => {
    expect(parseNaverEmail(CANCEL_SAMPLE)!.payment_status).toBe('none');
  });

  it("결제수단에 '신용카드'가 명시돼 있으면(page26) 방 코드 유추 없이 바로 card", () => {
    expect(parseNaverEmail(CANCEL_SAMPLE)!.payment_method).toBe('card');
  });
});

// 실제 IMAP 수신 메일(2026-07, uid 91410)을 html-to-text로 변환한 결과 그대로 —
// 네이버 알림 메일이 HTML 전용(text/plain 파트 없음)이라는 게 실접속으로 확인됐고,
// html-to-text 변환 시 아웃룩 조건부 주석(<!--[if mso]-->)이 텍스트로 새는 것도 확인됨.
// 라벨 사이/값 안에 이런 주석 잡음이 끼어도 파싱이 안 깨지는지 검증하는 회귀 테스트.
const REAL_HTML_TO_TEXT_SAMPLE = `
<!-- 아웃룩용 max-width 핵 --> <!--[if (gte mso 9)|(IE)]> <table border="0" cellpadding="0" cellspacing="0"> <tr> <td width="595"> <![endif]-->




스테이 온 페이지 북스테이
새로운 예약이 확정 되었습니다.

예약내역을 확인해 보세요.



<!-- 고객 -->
예약자명 박*은님
예약신청 일시 2026.07.11. 01:29:08



<!--// 고객 --> <!-- 예약 상품 정보 -->
예약내역



예약번호 1289116946
예약상품 page 452 - 지금, 나를 세우는 시간
이용일시 2026.08.03.(월)~2026.08.04.(화) (1박 2일)
결제상태 결제완료
결제수단 신용카드 간편결제
결제금액 page 452 - 지금, 나를 세우는 시간(1) 260,000원 + 조식_멋진하루 1인(1) 12,000원 + 조식_달콤하루 1인(1) 12,000원 + 석식룸서비스_굿데이라이스 1인(1) 16,000원 + 석식룸서비스_선데이로스트 1인(1) 22,000원 + 다독다독(2) 20,000원 = 342,000원
<!-- 일반형, 뷰티형 현장결제 추가 --> 매장방문결제
<!-- //일반형, 뷰티형 현장결제 추가 --> 요청사항 -
`;

describe('parseNaverEmail — 실제 HTML 메일(주석 잡음 포함)', () => {
  it('HTML 주석이 라벨 값에 섞여도 핵심 필드는 정확히 추출된다', () => {
    const r = parseNaverEmail(REAL_HTML_TO_TEXT_SAMPLE);
    expect(r).not.toBeNull();
    expect(r!.channel_reservation_id).toBe('1289116946');
    expect(r!.guest_name).toBe('박*은');
    expect(r!.check_in).toBe('2026-08-03');
    expect(r!.check_out).toBe('2026-08-04');
    expect(r!.amount).toBe(342000); // 주석이 '=' 뒤에 섞여도 총액은 정확
    expect(r!.payment_status).toBe('paid'); // '결제완료' 감지
    expect(r!.payment_method).toBe('card'); // '신용카드 간편결제' 필드에서 직접 분류(page452)
    expect(r!.cancelled).toBe(false);
  });

  it('옵션 6개(본상품+옵션5개)를 정확히 분해한다', () => {
    const r = parseNaverEmail(REAL_HTML_TO_TEXT_SAMPLE)!;
    expect(r.options).toHaveLength(6);
    expect(r.options[5]).toEqual({ name: '다독다독', qty: 2, price: 20000 });
  });
});
