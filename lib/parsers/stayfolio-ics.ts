// 스테이폴리오 iCal 피드 파서 (설정 > 추가서비스 > AIRBNB 연동 > 2단계 내보내기 링크).
// 원래 에어비앤비 캘린더 동기화용이지만, 표준 iCal 형식이라 우리도 그대로 구독 가능.
//
// 이메일 알림에는 없는 "진짜 예약번호"가 여기 있다(DESCRIPTION의 /bookings/{id} URL).
// 용도 두 가지:
//   1) 이메일(날짜+객실)과 매칭해 합성키 대신 진짜 channel_reservation_id를 확보
//   2) 주기적으로 재조회해 "어제 있던 예약번호가 오늘 사라짐"을 취소로 추론
//      (스테이폴리오는 취소 이메일을 보내지 않음 — 운영자 확인, 2026-07)
//
// 실제 피드(2026-07, page26 방, 개인정보 없음 — 예약ID·날짜·전화번호 뒷4자리만 존재):
//   BEGIN:VEVENT
//   DTSTART;VALUE=DATE:20260713
//   DTEND;VALUE=DATE:20260714
//   DESCRIPTION:Reservation URL: https://host.stayfolio.com/bookings/775318868\n
//    Phone Number (Last 4 Digits): 3343
//   SUMMARY:Reserved
//   END:VEVENT
// 주의: 국제전화(+82로 시작)만 있고 뒷 4자리가 없는 경우도 있음(전화번호 완전 비공개) → null 처리.

export interface IcsBooking {
  bookingId: string;
  checkIn: string; // 'YYYY-MM-DD'
  checkOut: string;
  phoneLast4: string | null;
}

/** 'DESCRIPTION:...' 폴딩 라인(다음 줄이 공백으로 시작하면 이어붙임)을 먼저 펼친다. */
function unfoldLines(ics: string): string[] {
  const raw = ics.split(/\r\n|\n/);
  const out: string[] = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function icsDateToIso(d: string): string | null {
  const m = d.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function parseStayfolioIcs(ics: string): IcsBooking[] {
  const lines = unfoldLines(ics);
  const bookings: IcsBooking[] = [];

  let inEvent = false;
  let dtStart: string | null = null;
  let dtEnd: string | null = null;
  let description = '';

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      inEvent = true;
      dtStart = dtEnd = null;
      description = '';
      continue;
    }
    if (line.startsWith('END:VEVENT')) {
      if (inEvent && dtStart && dtEnd) {
        const checkIn = icsDateToIso(dtStart);
        const checkOut = icsDateToIso(dtEnd);
        const idMatch = description.match(/bookings\/(\d+)/);
        const phoneMatch = description.match(
          /Last 4 Digits\):\s*(\d{4})/,
        );
        if (checkIn && checkOut && idMatch) {
          bookings.push({
            bookingId: idMatch[1],
            checkIn,
            checkOut,
            phoneLast4: phoneMatch ? phoneMatch[1] : null,
          });
        }
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    if (line.startsWith('DTSTART')) {
      dtStart = line.split(':').pop() ?? null;
    } else if (line.startsWith('DTEND')) {
      dtEnd = line.split(':').pop() ?? null;
    } else if (line.startsWith('DESCRIPTION')) {
      description += line.slice(line.indexOf(':') + 1);
    }
  }

  return bookings;
}

/** 이메일에서 얻은 (체크인, 체크아웃, 전화번호)로 ICS 피드에서 진짜 예약번호를 찾는다.
 *  전화번호 뒷4자리가 일치하는 항목 우선, 없으면 날짜만으로(피드에 국제전화라 뒷4자리가
 *  없는 경우 대비). 여러 개 걸리면 매칭 실패로 취급(오배정 방지 — 합성키 폴백이 더 안전). */
export function matchIcsBooking(
  bookings: IcsBooking[],
  checkIn: string,
  checkOut: string,
  guestPhone: string | null,
): IcsBooking | null {
  const dateMatches = bookings.filter(
    (b) => b.checkIn === checkIn && b.checkOut === checkOut,
  );
  if (dateMatches.length === 0) return null;
  if (dateMatches.length === 1) return dateMatches[0];

  if (guestPhone) {
    const last4 = guestPhone.slice(-4);
    const phoneMatches = dateMatches.filter((b) => b.phoneLast4 === last4);
    if (phoneMatches.length === 1) return phoneMatches[0];
  }
  return null; // 애매하면 매칭 안 함 — 잘못된 예약번호를 붙이는 것보다 안전
}
