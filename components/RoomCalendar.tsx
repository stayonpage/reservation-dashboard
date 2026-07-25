'use client';

import { useMemo, useState } from 'react';
import type { Reservation, BlockTask } from '../lib/db-types';
import { CHANNEL_LABEL } from '../lib/db-types';
import { ROOMS, roomCodeOf } from '../lib/rooms';
import { formatOptions, kstNow, stayNightLabel } from '../lib/format';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function toISODate(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// UTC 파싱+UTC 게터 — KST 파싱+로컬 게터를 섞으면 UTC 서버에서 날짜가 밀린다(lib/format.ts 참고).
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 체크아웃 당일은 비운 것으로 취급(그날 새 손님이 들어올 수 있음) — [check_in, check_out) 반개구간.
function isOccupied(checkIn: string, checkOut: string, date: string): boolean {
  return checkIn <= date && date < checkOut;
}

export function RoomCalendar({
  reservations,
  blockTasks,
  onCreateManualBlock,
  onCancelManualBlock,
  onCancelReservation,
  onUpdateNotes,
  id,
}: {
  reservations: Reservation[];
  blockTasks: BlockTask[];
  onCreateManualBlock: (
    roomCode: string,
    checkIn: string,
    checkOut: string,
    reason: string,
  ) => void;
  onCancelManualBlock: (group: string) => void;
  onCancelReservation: (reservationId: string) => void;
  onUpdateNotes: (reservationId: string, notes: string) => void;
  id?: string;
}) {
  // "오늘"은 한국시간 기준(서버 SSR이 UTC여도 동일하게) — kstNow는 getUTC* 게터로만 읽는다.
  const today = kstNow();
  const [cursor, setCursor] = useState({ y: today.getUTCFullYear(), m: today.getUTCMonth() });
  const [selected, setSelected] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);

  const handleCopyPhone = (reservationId: string, phone: string) => {
    navigator.clipboard.writeText(phone).then(() => {
      setCopiedId(reservationId);
      setTimeout(() => setCopiedId((cur) => (cur === reservationId ? null : cur)), 1500);
    });
  };

  const active = useMemo(
    () => reservations.filter((r) => r.status !== 'cancelled'),
    [reservations],
  );

  // 직접 막기는 채널 3곳에 각각 태스크가 생기지만 방 하나당 표시는 1개면 충분 — room_code로만 본다.
  const manualBlocks = useMemo(
    () => blockTasks.filter((t) => t.reservation_id === null && t.status !== 'skipped'),
    [blockTasks],
  );

  const { y, m } = cursor;
  const startWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayIso = toISODate(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  const cells: (string | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(toISODate(y, m, d));

  const roomsForDate = (date: string) =>
    ROOMS.map((room) => {
      const reservation =
        active.find(
          (r) =>
            roomCodeOf(r.room_name) === room.code &&
            isOccupied(r.check_in, r.check_out, date),
        ) ?? null;
      const manualBlock = reservation
        ? null
        : manualBlocks.find(
            (t) => t.room_code === room.code && isOccupied(t.check_in, t.check_out, date),
          ) ?? null;
      return { room, reservation, manualBlock };
    });

  const occupiedCount = (date: string) =>
    roomsForDate(date).filter((r) => r.reservation || r.manualBlock).length;

  const goPrevMonth = () => {
    setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }));
    setSelected(null);
  };
  const goNextMonth = () => {
    setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }));
    setSelected(null);
  };

  // 슬라이더 하나로 상태 전환: 꺼짐→켜짐은 새로 직접 막기(사유 입력), 켜짐→꺼짐은 종류에 따라
  // 예약 취소 또는 직접 막기 취소. 왼쪽(꺼짐)=빈 방, 오른쪽(켜짐)=막힘/예약됨.
  const handleToggle = (
    roomCode: string,
    reservation: Reservation | null,
    manualBlock: BlockTask | null,
  ) => {
    if (!selected) return;

    if (reservation) {
      if (
        window.confirm(
          `${reservation.guest_name ?? '이 손님'}의 예약을 취소하고 빈 방으로 표시할까요?`,
        )
      ) {
        onCancelReservation(reservation.id);
      }
      return;
    }

    if (manualBlock) {
      if (manualBlock.manual_block_group) {
        onCancelManualBlock(manualBlock.manual_block_group);
      }
      return;
    }

    const reason = window.prompt('막는 사유를 입력하세요 (예: 청소, 보수공사, 개인사용)');
    if (!reason || !reason.trim()) return;
    onCreateManualBlock(roomCode, selected, addDays(selected, 1), reason.trim());
  };

  return (
    <section id={id}>
      <div className="section-title">
        <h2>객실 달력</h2>
      </div>

      <div className="cal-nav">
        <button type="button" onClick={goPrevMonth} aria-label="이전 달">
          ‹
        </button>
        <div className="cal-month">
          {y}년 {m + 1}월
        </div>
        <button type="button" onClick={goNextMonth} aria-label="다음 달">
          ›
        </button>
      </div>

      <div className="cal-grid">
        {DOW.map((d) => (
          <div key={d} className="cal-dow">
            {d}
          </div>
        ))}
        {cells.map((date, i) => {
          if (!date) return <div key={`empty-${i}`} className="cal-cell empty" />;
          const day = Number(date.slice(-2));
          const count = occupiedCount(date);
          const cls = [
            'cal-cell',
            date === todayIso && 'today',
            date === selected && 'selected',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={date}
              type="button"
              className={cls}
              onClick={() => setSelected(date === selected ? null : date)}
            >
              <span className="cal-day">{day}</span>
              {count > 0 && (
                <span className="cal-count">{count}/{ROOMS.length}</span>
              )}
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="cal-detail">
          <div className="cal-detail-title">{selected} 객실 현황</div>
          {roomsForDate(selected).map(({ room, reservation, manualBlock }) => {
            const occupied = Boolean(reservation || manualBlock);
            return (
              <div key={room.code} className="cal-room-block">
                <div className="cal-room-row">
                  <span className="cal-room-label">{room.label}</span>
                  <span className="cal-room-status">
                    {reservation ? (
                      <span className="cal-room-guest-block">
                        <span className="cal-room-guest">
                          {reservation.guest_name ?? '이름 미상'} ·{' '}
                          {CHANNEL_LABEL[reservation.channel]}
                          {(() => {
                            const night = stayNightLabel(
                              reservation.check_in,
                              reservation.check_out,
                              selected,
                            );
                            return night && <span className="cal-room-night"> · {night}</span>;
                          })()}
                        </span>
                        {reservation.options.length > 0 && (
                          <span className="cal-room-options">
                            {formatOptions(reservation.options)}
                          </span>
                        )}
                      </span>
                    ) : manualBlock ? (
                      <span className="cal-room-blocked">직접 막음 · {manualBlock.reason}</span>
                    ) : (
                      <span className="cal-room-empty">비어있음</span>
                    )}
                  </span>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={occupied}
                      onChange={() => handleToggle(room.code, reservation, manualBlock)}
                      aria-label={`${room.label} ${occupied ? '비우기' : '막기'}`}
                    />
                    <span className="toggle-track" />
                  </label>
                </div>

                {reservation && (
                  <div className="cal-room-extra">
                    {reservation.guest_phone && (
                      <div className="cal-room-phone">
                        <span>{reservation.guest_phone}</span>
                        <button
                          type="button"
                          className="cal-copy-btn"
                          aria-label={copiedId === reservation.id ? '복사됨' : '전화번호 복사'}
                          onClick={() =>
                            handleCopyPhone(reservation.id, reservation.guest_phone!)
                          }
                        >
                          {copiedId === reservation.id ? '✅' : '📋'}
                        </button>
                      </div>
                    )}
                    {editingNotesId === reservation.id ? (
                      <textarea
                        className="cal-notes"
                        placeholder="비고(특이사항)를 입력하세요"
                        defaultValue={reservation.notes ?? ''}
                        autoFocus
                        onBlur={(e) => {
                          if (e.target.value !== (reservation.notes ?? '')) {
                            onUpdateNotes(reservation.id, e.target.value);
                          }
                          setEditingNotesId(null);
                        }}
                      />
                    ) : (
                      <div className="cal-notes-row">
                        {reservation.notes && (
                          <span className="cal-notes-preview">{reservation.notes}</span>
                        )}
                        <button
                          type="button"
                          className="cal-notes-btn"
                          onClick={() => setEditingNotesId(reservation.id)}
                        >
                          비고
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
