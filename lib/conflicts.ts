// 같은 방에 날짜가 겹치는 예약이 2건 이상 잡힌 경우(중복예약) 감지 — 순수 함수.
// 실사례(2026-07): 네이버 자체에서 같은 방·같은 날짜로 서로 다른 손님 예약이 둘 다 잡힘
// (호스트가 확정을 늦게 눌러 그 사이 다른 손님이 또 예약) — 채널간 "막기" 워크플로우로는
// 못 잡는 유형이라 별도 감지가 필요하다.

import type { Reservation } from './db-types';
import { ROOMS, roomCodeOf } from './rooms';

export interface RoomConflict {
  roomCode: string;
  roomLabel: string;
  reservations: Reservation[]; // 서로 겹치는 예약들(같은 방, 날짜 겹침)
}

function rangesOverlap(a: Reservation, b: Reservation): boolean {
  return a.check_in < b.check_out && b.check_in < a.check_out;
}

export function findRoomConflicts(reservations: Reservation[]): RoomConflict[] {
  const active = reservations.filter((r) => r.status !== 'cancelled');

  const byRoom = new Map<string, Reservation[]>();
  for (const r of active) {
    const code = roomCodeOf(r.room_name);
    if (!code) continue;
    if (!byRoom.has(code)) byRoom.set(code, []);
    byRoom.get(code)!.push(r);
  }

  const conflicts: RoomConflict[] = [];
  for (const [code, list] of byRoom) {
    if (list.length < 2) continue;

    const sorted = [...list].sort((a, b) => a.check_in.localeCompare(b.check_in));
    const overlappingIds = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (rangesOverlap(sorted[i], sorted[j])) {
          overlappingIds.add(sorted[i].id);
          overlappingIds.add(sorted[j].id);
        }
      }
    }

    if (overlappingIds.size > 0) {
      const room = ROOMS.find((r) => r.code === code);
      conflicts.push({
        roomCode: code,
        roomLabel: room?.label ?? code,
        reservations: sorted.filter((r) => overlappingIds.has(r.id)),
      });
    }
  }

  return conflicts;
}
