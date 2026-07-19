import { describe, it, expect } from 'vitest';
import { parseImwebEmail } from './imweb-email';

// 실제 아임웹 예약 알림 메일(2026-07 확보, Gmail API로 원문 HTML 조회 → html-to-text 변환)을
// 그대로 유지하되, 고객명만 가상 값으로 치환한 픽스처. 옵션(추가상품) 있는 접수 메일과
// 옵션 없는 취소 메일 두 종류를 모두 실샘플로 확보해 커버한다.

const REQUEST_WITH_OPTIONS = `스테이 온 페이지 무통장 입금 확인 안내

아래와 같은 정보로 고객이 예약을 하였으며, 예약을 확정하기 위해 입금확인을 해주셔야 합니다.
입금계좌: 아이엠뱅크 15443030 박영희 (스테이)

고객명 홍길동 예약번호 202607158517921 예약일자 2026-07-15 15:39

결제정보 총 예약금액 342,000원 결제 수단 무통장입금 최종 결제금액 342,000원

예약상품

[https://cdn.imweb.me/thumbnail/20230223/6392b5ba477c6.jpg]http://stayonpage.com/reservation/?idx=2
오마이쿡이 매주 화요일 휴무(공휴일 제외)로 인해 조식,석식 선택시 확인해 주세요.

사색 사서

네가지 색상과 네가지 주제를 가지는 북스테이 공간입니다.

page26 - 분홍 마음을 울리는 시인선

문학동네 시인선집이 가득한 공간입니다.

기준 인원 : 2인
page 26   - 2인
page 452 - 3인
page 8    - 3인
page 127 - 3인 (단, 가족 4인 예약전 문의)

[http://stayonpage.com/reservation/?idx=2]
1박(2026년 08월 05일~08월 06일) [http://stayonpage.com/reservation/?idx=2]

주문금액 260,000원 굿바이 키트 1명 [http://stayonpage.com/reservation/?idx=2] 20,000원 조식_달콤하루 1인 2명 [http://stayonpage.com/reservation/?idx=2] 24,000원 석식룸서비스_선데이로스트 1인 1명 [http://stayonpage.com/reservation/?idx=2] 22,000원 석식룸서비스_굿데이라이스 1인 1명 [http://stayonpage.com/reservation/?idx=2] 16,000원 최종 결제금액 342,000원

예약관리 하기 [http://stayonpage.com/admin/booking/order]

© 스테이 온 페이지`;

const CANCELLED_NO_OPTIONS = `스테이 온 페이지 예약이 취소되었습니다.

고객명 홍길동 예약번호 202607151326342 예약일자 2026-07-15 14:40

결제정보 총 예약금액 260,000원 결제 수단 무통장입금 최종 결제금액 260,000원

예약상품

[https://cdn.imweb.me/thumbnail/20230223/6392b5ba477c6.jpg]http://stayonpage.com/reservation/?idx=2

사색 사서

page26 - 분홍 마음을 울리는 시인선

기준 인원 : 2인
page 26 - 2인
page 452 - 3인
page 8 - 3인
page 127 - 3인 (단, 가족 4인 예약전 문의)

[http://stayonpage.com/reservation/?idx=2]
1박(2026년 07월 29일~07월 30일) [http://stayonpage.com/reservation/?idx=2]

주문금액 260,000원 최종 결제금액 260,000원

예약관리 하기 [http://stayonpage.com/admin/booking/order]

© 스테이 온 페이지`;

// 실제 게스트하우스(오마이북) 예약 메일(2026-07 확보) — 방 이름 표기가 스테이 온 페이지와
// 완전히 다르다("서쪽방" 단독, 'pageNN - ...' 형식이 아님). 예약자명은 실메일 그대로 '관리자'
// (테스트 예약이라 이미 가상 값).
const GUESTHOUSE_REQUEST = `스테이 온 페이지 무통장 입금 확인 안내

아래와 같은 정보로 고객이 예약을 하였으며, 예약을 확정하기 위해 입금확인을 해주셔야 합니다.
입금계좌: 아이엠뱅크 15443030 박영희 (스테이)

고객명 관리자 예약번호 202607184617652 예약일자 2026-07-18 19:25

결제정보 총 예약금액 123,000원 결제 수단 무통장입금 최종 결제금액 123,000원

예약상품

[https://cdn.imweb.me/thumbnail/20230303/04bc8fee8999a.jpg]http://stayonpage.com/reservation/?idx=6

오마이쿡이 매주 화요일 휴무(공휴일 제외)로 인해 조식,석식 선택시 확인해 주세요.
월요일 입실 고객님은 조식 신청하실 수 없습니다.



서쪽방

오마이북 2층 통창에서 보는 석양이 일품입니다.

높은 건물이 없어 탁 트인 뷰를 즐길수 있는 공간이기도 합니다.

좀 더 개방적인 방을 원하신다면 서쪽방을 추천 드려요.

체크인 : 15시~21시 - 오마이북


기준 인원 : 1인
최대 인원 : 2인 (초과 인원 입실 불가)
24개월 이상 아이가 있으신 3인 이상 가족 분들은 남쪽 서쪽 두 군데 예약 부탁 드릴께요.
[http://stayonpage.com/reservation/?idx=6]
1박(2026년 07월 20일~07월 21일) [http://stayonpage.com/reservation/?idx=6]

주문금액 100,000원 굿바이 키트 1명 [http://stayonpage.com/reservation/?idx=6] 20,000원 웰컴 키트 1명 [http://stayonpage.com/reservation/?idx=6] 3,000원 최종 결제금액 123,000원

예약관리 하기 [http://stayonpage.com/admin/booking/order]

© 스테이 온 페이지`;

describe('parseImwebEmail', () => {
  it('접수(무통장입금 대기) 메일에서 모든 필드를 정확히 추출한다', () => {
    const r = parseImwebEmail(REQUEST_WITH_OPTIONS);
    expect(r).not.toBeNull();
    expect(r!.channel).toBe('imweb');
    expect(r!.channel_reservation_id).toBe('202607158517921');
    expect(r!.guest_name).toBe('홍길동');
    expect(r!.guest_phone).toBeNull();
    expect(r!.room_name).toBe('page26 - 분홍 마음을 울리는 시인선');
    expect(r!.check_in).toBe('2026-08-05');
    expect(r!.check_out).toBe('2026-08-06');
    expect(r!.amount).toBe(342000);
  });

  it('추가상품 4개를 정확히 분해한다(방 기본요금·총액은 옵션에서 제외)', () => {
    const r = parseImwebEmail(REQUEST_WITH_OPTIONS)!;
    expect(r.options).toEqual([
      { name: '굿바이 키트 1명', qty: 1, price: 20000 },
      { name: '조식_달콤하루 1인 2명', qty: 1, price: 24000 },
      { name: '석식룸서비스_선데이로스트 1인 1명', qty: 1, price: 22000 },
      { name: '석식룸서비스_굿데이라이스 1인 1명', qty: 1, price: 16000 },
    ]);
  });

  it('무통장입금은 cash로 분류하고 입금확인 전까지 pending 상태로 둔다', () => {
    const r = parseImwebEmail(REQUEST_WITH_OPTIONS)!;
    expect(r.payment_method).toBe('cash');
    expect(r.payment_status).toBe('pending');
    expect(r.cancelled).toBe(false);
  });

  it('취소 메일은 같은 예약번호로 cancelled=true, 옵션 없으면 빈 배열', () => {
    const r = parseImwebEmail(CANCELLED_NO_OPTIONS);
    expect(r).not.toBeNull();
    expect(r!.channel_reservation_id).toBe('202607151326342');
    expect(r!.cancelled).toBe(true);
    expect(r!.payment_status).toBe('none');
    expect(r!.options).toEqual([]);
    expect(r!.check_in).toBe('2026-07-29');
    expect(r!.check_out).toBe('2026-07-30');
  });

  it('방 이름은 강조 문구(공백 없는 pageNN)를 쓰고 정원안내 목록(공백 있는 page NN)과 혼동하지 않는다', () => {
    const r = parseImwebEmail(CANCELLED_NO_OPTIONS)!;
    expect(r.room_name).toBe('page26 - 분홍 마음을 울리는 시인선');
  });

  it('예약번호나 체크인/체크아웃 날짜가 없으면 null', () => {
    expect(parseImwebEmail('관련 없는 텍스트')).toBeNull();
  });

  it('게스트하우스 방("서쪽방")은 pageNN 형식이 아니어도 정확히 추출한다', () => {
    const r = parseImwebEmail(GUESTHOUSE_REQUEST);
    expect(r).not.toBeNull();
    expect(r!.room_name).toBe('서쪽방');
    expect(r!.check_in).toBe('2026-07-20');
    expect(r!.check_out).toBe('2026-07-21');
    expect(r!.amount).toBe(123000);
    // 본문 뒤쪽에 "남쪽 서쪽"이 다시 나와도(방 이름과 다른 형태) 처음 매치인 "서쪽방"을 쓴다.
  });
});
