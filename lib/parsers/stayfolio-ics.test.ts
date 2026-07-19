import { describe, it, expect } from 'vitest';
import { parseStayfolioIcs, matchIcsBooking } from './stayfolio-ics';

// 실제 스테이폴리오 ICS 피드(2026-07, page26 방, 에어비앤비 연동용 내보내기 링크로 확보).
// 개인정보 없음 — 예약ID(플랫폼 공개 URL)·날짜·전화번호 뒷4자리만 포함된 원본 그대로.
const REAL_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Stayfolio Inc//Hosting Calendar 1.0//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
DTSTAMP:20260713T031125Z
UID:b9abd47a-1b82-4cf4-8a46-5f79785e6088
DTSTART;VALUE=DATE:20260713
DTEND;VALUE=DATE:20260714
DESCRIPTION:Reservation URL: https://host.stayfolio.com/bookings/775318868\\
 nPhone Number (Last 4 Digits): +82
SUMMARY:Reserved
END:VEVENT
BEGIN:VEVENT
DTSTAMP:20260713T031125Z
UID:4e290ca8-b40a-4189-a5ee-d6cf6c66b9c4
DTSTART;VALUE=DATE:20260716
DTEND;VALUE=DATE:20260717
DESCRIPTION:Reservation URL: https://host.stayfolio.com/bookings/148929870\\
 nPhone Number (Last 4 Digits): 3343
SUMMARY:Reserved
END:VEVENT
BEGIN:VEVENT
DTSTAMP:20260713T031125Z
UID:264c58ee-a5be-4aec-9b1f-cae4167e9dc7
DTSTART;VALUE=DATE:20260717
DTEND;VALUE=DATE:20260719
DESCRIPTION:Reservation URL: https://host.stayfolio.com/bookings/767099198\\
 nPhone Number (Last 4 Digits): 0267
SUMMARY:Reserved
END:VEVENT
BEGIN:VEVENT
DTSTAMP:20260713T031125Z
UID:607ea513-8b7c-4022-bd26-f2f226ad9528
DTSTART;VALUE=DATE:20260802
DTEND;VALUE=DATE:20260804
DESCRIPTION:Reservation URL: https://host.stayfolio.com/bookings/613864575\\
 nPhone Number (Last 4 Digits): 1323
SUMMARY:Reserved
END:VEVENT
END:VCALENDAR`;

describe('parseStayfolioIcs', () => {
  it('실제 피드에서 예약 4건을 정확히 추출한다', () => {
    const bookings = parseStayfolioIcs(REAL_ICS);
    expect(bookings).toHaveLength(4);
    expect(bookings[0]).toEqual({
      bookingId: '775318868',
      checkIn: '2026-07-13',
      checkOut: '2026-07-14',
      phoneLast4: null, // '+82'만 있고 뒷4자리 없음 → null
    });
    expect(bookings[1]).toEqual({
      bookingId: '148929870',
      checkIn: '2026-07-16',
      checkOut: '2026-07-17',
      phoneLast4: '3343',
    });
  });

  it('1박이 아닌 2박(DTSTART~DTEND 차이 2일)도 정확히 처리한다', () => {
    const bookings = parseStayfolioIcs(REAL_ICS);
    const twoNight = bookings.find((b) => b.bookingId === '767099198');
    expect(twoNight).toEqual({
      bookingId: '767099198',
      checkIn: '2026-07-17',
      checkOut: '2026-07-19',
      phoneLast4: '0267',
    });
  });

  it('빈 피드는 빈 배열', () => {
    expect(parseStayfolioIcs('BEGIN:VCALENDAR\nEND:VCALENDAR')).toEqual([]);
  });
});

describe('matchIcsBooking', () => {
  const bookings = parseStayfolioIcs(REAL_ICS);

  it('날짜가 유일하게 일치하면 전화번호 없이도 매칭된다', () => {
    const m = matchIcsBooking(bookings, '2026-07-16', '2026-07-17', null);
    expect(m?.bookingId).toBe('148929870');
  });

  it('날짜가 일치하지 않으면 null', () => {
    expect(matchIcsBooking(bookings, '2099-01-01', '2099-01-02', null)).toBeNull();
  });

  it('동일 날짜에 여러 건이면 전화번호 뒷4자리로 구분한다', () => {
    // 동일 체크인/아웃 2건을 가진 가짜 목록으로 구분 로직만 검증.
    const dup = [
      { bookingId: 'A', checkIn: '2026-01-01', checkOut: '2026-01-02', phoneLast4: '1111' },
      { bookingId: 'B', checkIn: '2026-01-01', checkOut: '2026-01-02', phoneLast4: '2222' },
    ];
    expect(matchIcsBooking(dup, '2026-01-01', '2026-01-02', '010000002222')?.bookingId).toBe('B');
  });

  it('동일 날짜 여러 건인데 전화번호도 매칭 안 되면 오배정 방지를 위해 null', () => {
    const dup = [
      { bookingId: 'A', checkIn: '2026-01-01', checkOut: '2026-01-02', phoneLast4: '1111' },
      { bookingId: 'B', checkIn: '2026-01-01', checkOut: '2026-01-02', phoneLast4: '2222' },
    ];
    expect(matchIcsBooking(dup, '2026-01-01', '2026-01-02', '01099999999')).toBeNull();
  });
});
