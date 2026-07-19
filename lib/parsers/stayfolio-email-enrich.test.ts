import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseStayfolioEmailWithRealId } from './stayfolio-email-enrich';

const SAMPLE = `스테이온페이지(page26 - 시가 내려앉는 순간) 2026년 7월 29일 ~ 2026년 7월 30일

Guest Information 성함 홍길동 연락처 +821000000000 이메일 test.guest@example.com 객실명 page26 - 시가
내려앉는 순간 투숙인원 성인: 2명 체크인 2026년 7월 29일 오후 3시 체크아웃 2026년 7월 30일
오전 10시 옵션 조식_멋진하루 1인 (￦12000) * 1 요청사항 요청사항이 없습니다.

결제정보 결제금액 434,000원 결제방법 네이버페이`;

const ICS_WITH_MATCH = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260729
DTEND;VALUE=DATE:20260730
DESCRIPTION:Reservation URL: https://host.stayfolio.com/bookings/999888777\\n Phone Number (Last 4 Digits): 0000
SUMMARY:Reserved
END:VEVENT
END:VCALENDAR`;

const ICS_NO_MATCH = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20990101
DTEND;VALUE=DATE:20990102
DESCRIPTION:Reservation URL: https://host.stayfolio.com/bookings/111\\n Phone Number (Last 4 Digits): 1234
SUMMARY:Reserved
END:VEVENT
END:VCALENDAR`;

describe('parseStayfolioEmailWithRealId', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('ICS에서 매칭되면 합성키 대신 진짜 예약번호를 쓴다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => ICS_WITH_MATCH }),
    );

    const r = await parseStayfolioEmailWithRealId(SAMPLE);
    expect(r!.channel_reservation_id).toBe('999888777');
  });

  it('ICS에 매칭되는 날짜가 없으면 합성키로 폴백한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => ICS_NO_MATCH }),
    );

    const r = await parseStayfolioEmailWithRealId(SAMPLE);
    expect(r!.channel_reservation_id).toBe(
      'test.guest@example.com|2026-07-29|2026-07-30|page26 - 시가 내려앉는 순간',
    );
  });

  it('ICS 조회 자체가 실패해도(네트워크 오류) 감지는 계속되고 합성키로 폴백한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const r = await parseStayfolioEmailWithRealId(SAMPLE);
    expect(r).not.toBeNull();
    expect(r!.channel_reservation_id).toContain('test.guest@example.com');
  });

  it('ICS가 200이 아니면(예: 만료) 합성키로 폴백한다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const r = await parseStayfolioEmailWithRealId(SAMPLE);
    expect(r!.channel_reservation_id).toContain('|');
  });

  it('이메일 자체가 파싱 실패하면 ICS 조회 없이 null', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const r = await parseStayfolioEmailWithRealId('관련 없는 텍스트');
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
