import { describe, it, expect } from 'vitest';
import { isSubscriptionSubject, parseSubscriptionEmail } from './subscription-email';

// 실메일(2026-10-15 도착, Gmail API 로 원문 HTML 조회 → html-to-text 변환) 그대로의 본문 형식.
// 이름·연락처만 가상값으로 치환. 라벨(이름/연락처/주소)은 각각 독립된 줄, 주소 값은 여러 줄,
// 주소 끝은 빈 줄로 구분된다.
const SUBJECT = '[스테이 온 페이지] 월간구독4개월 신청에 새 응답이 접수되었습니다.';
const BODY = `스테이 온 페이지 새 입력폼 응답이 접수되었습니다.

등록자비회원 등록위치월간구독4개월 신청 등록시각2026-10-15 08:52 응답
이름
홍길동
연락처
01012345678
주소
(38334)
경북 청도군 화양읍 동천3길 67 (교촌리)
오마이뷱



입력폼 관리하기 [http://stayonpage.com/admin/contents/form]

© 스테이 온 페이지

[https://mail.naver.com/readReceipt/notify/?img=abc.gif]`;

const raw = (subject: string, body = BODY) => `제목: ${subject}\n${body}`;

describe('isSubscriptionSubject', () => {
  it('월간구독N개월 제목만 true', () => {
    expect(isSubscriptionSubject(SUBJECT)).toBe(true);
    expect(isSubscriptionSubject('[스테이 온 페이지] 월간구독 8개월 신청에 새 응답이')).toBe(true);
    expect(isSubscriptionSubject('[스테이 온 페이지] 예약이 접수되어 입금 확인이 필요합니다.')).toBe(false);
    expect(isSubscriptionSubject(undefined)).toBe(false);
    expect(isSubscriptionSubject(null)).toBe(false);
  });
});

describe('parseSubscriptionEmail', () => {
  it('실메일 형식: 이름·연락처·주소(우편번호+도로명)·상세주소·4개월', () => {
    expect(parseSubscriptionEmail(raw(SUBJECT))).toEqual({
      name: '홍길동',
      phone: '01012345678',
      address: '(38334) 경북 청도군 화양읍 동천3길 67 (교촌리)',
      address_detail: '오마이뷱',
      plan_months: 4,
    });
  });

  it('8개월 제목이면 plan_months 8', () => {
    const r = parseSubscriptionEmail(raw('[스테이 온 페이지] 월간구독8개월 신청에 새 응답이 접수되었습니다.', BODY.replace('월간구독4개월', '월간구독8개월')));
    expect(r?.plan_months).toBe(8);
  });

  it('★ 4·8 이외 개월 수(6개월)는 금액을 추측하지 않고 null', () => {
    expect(parseSubscriptionEmail(raw('[스테이 온 페이지] 월간구독6개월 신청에 새 응답이 접수되었습니다.', BODY.replace('월간구독4개월', '월간구독6개월')))).toBeNull();
  });

  it('구독 메일이 아니면(예약 메일 등) null', () => {
    expect(parseSubscriptionEmail('제목: [스테이 온 페이지] 예약이 취소되었습니다.\n고객명 홍길동 예약번호 1')).toBeNull();
  });

  it('★ 상세주소 없음 — 우편번호+도로명만', () => {
    const body = BODY.replace('오마이뷱\n', '');
    const r = parseSubscriptionEmail(raw(SUBJECT, body));
    expect(r?.address).toBe('(38334) 경북 청도군 화양읍 동천3길 67 (교촌리)');
    expect(r?.address_detail).toBeNull();
  });

  it('★ 우편번호 없음 — 첫 줄이 주소, 나머지는 상세주소', () => {
    const body = BODY.replace('(38334)\n', '');
    const r = parseSubscriptionEmail(raw(SUBJECT, body));
    expect(r?.address).toBe('경북 청도군 화양읍 동천3길 67 (교촌리)');
    expect(r?.address_detail).toBe('오마이뷱');
  });

  it('상세주소가 여러 줄이면 공백으로 합친다', () => {
    const body = BODY.replace('오마이뷱', '101동\n202호');
    expect(parseSubscriptionEmail(raw(SUBJECT, body))?.address_detail).toBe('101동 202호');
  });

  it('★ 연락처 누락 — phone null, 나머지는 정상(죽지 않음)', () => {
    const body = BODY.replace('연락처\n01012345678\n', '');
    const r = parseSubscriptionEmail(raw(SUBJECT, body));
    expect(r?.phone).toBeNull();
    expect(r?.name).toBe('홍길동');
  });

  it('연락처의 하이픈·공백은 제거해 숫자만 저장', () => {
    const body = BODY.replace('01012345678', '010-1234 5678');
    expect(parseSubscriptionEmail(raw(SUBJECT, body))?.phone).toBe('01012345678');
  });

  it('이름이 없으면 null (parse_failed 로 가시화)', () => {
    const body = BODY.replace('이름\n홍길동\n', '');
    expect(parseSubscriptionEmail(raw(SUBJECT, body))).toBeNull();
  });
});
