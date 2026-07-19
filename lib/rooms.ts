// 대시보드 달력용 방 목록 — 2개 프로퍼티, 총 6개 방.
// "스테이 온 페이지"(4개, page26·452·8·127)는 3채널(네이버·스테이폴리오·아임웹) 전부에 있고,
// "게스트하우스"(오마이북, 2개: 서쪽·남쪽)는 네이버·아임웹에만 있다(운영자 확인, 2026-07).
//
// 채널마다 같은 방을 다른 텍스트로 부른다(실메일로 확인) — 네이버는 "객실 서쪽",
// 아임웹은 "서쪽방". code는 네이버 쪽 텍스트를 그대로 canonical 값으로 쓰고(기존 저장값과
// 호환), aliases에 다른 채널 표기를 추가해 매칭한다.

export interface RoomDef {
  code: string;
  label: string;
  property: string;
  aliases: string[];
}

export const ROOMS: RoomDef[] = [
  { code: 'page26', label: '페이지26', property: '스테이 온 페이지', aliases: [] },
  { code: 'page452', label: '페이지452', property: '스테이 온 페이지', aliases: [] },
  { code: 'page8', label: '페이지8', property: '스테이 온 페이지', aliases: [] },
  { code: 'page127', label: '페이지127', property: '스테이 온 페이지', aliases: [] },
  { code: '객실 서쪽', label: '게스트 서쪽', property: '게스트하우스', aliases: ['서쪽방'] },
  { code: '객실 남쪽', label: '게스트 남쪽', property: '게스트하우스', aliases: ['남쪽방'] },
];

const PAGE_CODES = ROOMS.filter((r) => r.code.startsWith('page')).map((r) => r.code);
const GUESTHOUSE_ROOMS = ROOMS.filter((r) => !r.code.startsWith('page'));

/** room_name(예: 'page26 - 시가 내려앉는 순간', '객실 서쪽', '서쪽방') → ROOMS의 code(canonical). */
export function roomCodeOf(roomName: string | null): string | null {
  if (!roomName) return null;

  for (const r of GUESTHOUSE_ROOMS) {
    if (roomName.startsWith(r.code) || r.aliases.some((a) => roomName.startsWith(a))) {
      return r.code;
    }
  }

  // page 계열은 'page26'과 'page127' 같은 접두어 오매칭을 막기 위해 숫자 경계를 확인한다.
  const normalized = roomName.replace(/page\s*(\d+)/i, 'page$1');
  for (const c of PAGE_CODES) {
    if (!normalized.startsWith(c)) continue;
    const next = normalized[c.length];
    if (next === undefined || !/\d/.test(next)) return c;
  }

  return null;
}
