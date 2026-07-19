// 스테이폴리오 객실별 ICS(캘린더) 피드 매핑. 2026-07 운영자가 직접 확보(설정 > 추가서비스 >
// AIRBNB 연동 > 2단계 내보내기 링크 — 원래 에어비앤비용이지만 표준 iCal이라 그대로 구독 가능).
export const STAYFOLIO_ROOM_ICS_URLS: Record<string, string> = {
  page26: 'https://www.stayfolio.com/api/v1/icalendar/22392714.ics',
  page452: 'https://www.stayfolio.com/api/v1/icalendar/2843294.ics',
  page8: 'https://www.stayfolio.com/api/v1/icalendar/3448512.ics',
  page127: 'https://www.stayfolio.com/api/v1/icalendar/3040078.ics',
};

/** 'page26 - 시가 내려앉는 순간' 같은 이메일 객실명에서 방 코드를 뽑아 ICS URL을 찾는다.
 *  설명 문구가 바뀌어도 'pageNN' 접두어만 맞으면 매칭. 코드 뒤에 숫자가 더 이어지면
 *  다른 방(예: page1 vs page127)이므로 단어 경계를 확인해 오매칭을 막는다. */
export function findIcsUrlForRoom(roomName: string | null): string | null {
  if (!roomName) return null;
  const code = Object.keys(STAYFOLIO_ROOM_ICS_URLS).find((c) => {
    if (!roomName.startsWith(c)) return false;
    const nextChar = roomName[c.length];
    return nextChar === undefined || !/\d/.test(nextChar);
  });
  return code ? STAYFOLIO_ROOM_ICS_URLS[code] : null;
}
