'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { createClient } from '../lib/supabase/client';
import type { Reservation, BlockTask, ReservationChange } from '../lib/db-types';
import { DepositQueue } from './DepositQueue';
import { BlockWorklist } from './BlockWorklist';
import { ReservationList } from './ReservationList';
import { ReservationChangeQueue } from './ReservationChangeQueue';
import { RoomCalendar } from './RoomCalendar';
import { WeeklyOverview } from './WeeklyOverview';
import { Statistics } from './Statistics';
import { DoubleBookingAlert } from './DoubleBookingAlert';
import { ManualReservationForm } from './ManualReservationForm';
import {
  toggleBlockTask,
  confirmDeposit,
  createManualBlock,
  cancelManualBlock,
  cancelReservation,
  updateReservationNotes,
  createManualReservation,
  keepReservationChange,
  confirmReservationChange,
  confirmCancelReview,
  confirmUncancelReview,
} from '../lib/actions';
import type { Channel, PaymentStatus, ReservationOption } from '../lib/types';

// 서버(page.tsx)가 초기 데이터를 fetch해 내려주고, 이 컴포넌트는 realtime 구독으로
// 4대 폰 간 즉시 반영을 담당한다(design doc 멀티유저 요구). 뮤테이션은 낙관적 업데이트 +
// 서버 액션 호출 → 곧이어 realtime이 authoritative 값(감사 필드 포함)으로 재동기화.

function upsertById<T extends { id: string }>(list: T[], row: T): T[] {
  const idx = list.findIndex((x) => x.id === row.id);
  if (idx === -1) return [row, ...list];
  const copy = [...list];
  copy[idx] = row;
  return copy;
}

export function DashboardRealtime({
  initialReservations,
  initialBlockTasks,
  initialChanges,
  todayISO,
}: {
  initialReservations: Reservation[];
  initialBlockTasks: BlockTask[];
  initialChanges: ReservationChange[];
  todayISO: string;
}) {
  const [reservations, setReservations] = useState(initialReservations);
  const [blockTasks, setBlockTasks] = useState(initialBlockTasks);
  const [changes, setChanges] = useState(initialChanges);
  const [, startTransition] = useTransition();

  // realtime 핸들러가 최신 reservations 를 참조하되, 구독 useEffect 의 deps 는 [] 로 유지
  // (reservations 를 deps 에 넣으면 예약이 바뀔 때마다 재구독됨).
  const reservationsRef = useRef(reservations);
  useEffect(() => {
    reservationsRef.current = reservations;
  }, [reservations]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    // 세션(JWT)이 완전히 로드되기 전에 구독하면 realtime 소켓이 익명 권한으로 붙어
    // RLS(authenticated만 허용)에 막혀 이벤트가 조용히 안 온다 — 반드시 먼저 세션을 확보.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (session) supabase.realtime.setAuth(session.access_token);

      channel = supabase
        .channel('dashboard-changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'reservations' },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              const oldId = (payload.old as { id: string }).id;
              setReservations((prev) => prev.filter((r) => r.id !== oldId));
            } else {
              setReservations((prev) =>
                upsertById(prev, payload.new as Reservation),
              );
            }
          },
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'block_tasks' },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              const oldId = (payload.old as { id: string }).id;
              setBlockTasks((prev) => prev.filter((t) => t.id !== oldId));
            } else {
              // block_tasks 원본 페이로드엔 reservations 조인 필드가 없음 — 기존 항목과 병합해 보존.
              // (직접 막기는 room_code/reason이 block_tasks 자체 컬럼이라 조인 없이도 그대로 옴)
              const incoming = payload.new as Partial<BlockTask> & { id: string };
              setBlockTasks((prev) => {
                const existing = prev.find((t) => t.id === incoming.id);
                const merged: BlockTask = existing
                  ? { ...existing, ...incoming }
                  : ({
                      reservation_room_name: null,
                      reservation_guest_name: null,
                      reservation_channel: null,
                      ...incoming,
                    } as BlockTask);
                return upsertById(prev, merged);
              });
            }
          },
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'reservation_changes' },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              const oldId = (payload.old as { id: string }).id;
              setChanges((prev) => prev.filter((c) => c.id !== oldId));
              return;
            }
            const incoming = payload.new as Partial<ReservationChange> & {
              id: string;
              status: ReservationChange['status'];
              reservation_id: string;
            };
            // pending 이 아니게 되면(확정/유지/철회) 목록에서 제거.
            if (incoming.status !== 'pending') {
              setChanges((prev) => prev.filter((c) => c.id !== incoming.id));
              return;
            }
            // 원본 페이로드엔 reservations 조인이 없음 — 채널/notes 는 현재 예약 state 에서 보강.
            setChanges((prev) => {
              const res = reservationsRef.current.find(
                (r) => r.id === incoming.reservation_id,
              );
              const existing = prev.find((c) => c.id === incoming.id);
              const merged = {
                reservation_channel:
                  res?.channel ?? existing?.reservation_channel ?? 'naver',
                reservation_notes: res?.notes ?? existing?.reservation_notes ?? null,
                reservation_guest_request:
                  res?.guest_request ??
                  existing?.reservation_guest_request ??
                  null,
                kind: 'change' as const,
                cancel_reason: null,
                cancel_source: null,
                prev_options: [],
                new_options: [],
                ...existing,
                ...incoming,
              } as ReservationChange;
              const idx = prev.findIndex((c) => c.id === merged.id);
              if (idx === -1) return [merged, ...prev];
              const copy = [...prev];
              copy[idx] = merged;
              return copy;
            });
          },
        )
        // 무음 실패 방지: 구독이 실패/타임아웃해도 조용히 넘어가지 않고 콘솔에 남긴다.
        .subscribe((status, err) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.error('[realtime] 구독 실패:', status, err);
          }
        });
    });

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  const handleToggleBlock = (taskId: string, done: boolean) => {
    setBlockTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status: done ? 'done' : 'pending',
              done_at: done ? new Date().toISOString() : null,
            }
          : t,
      ),
    );
    startTransition(() => {
      toggleBlockTask(taskId, done).then((res) => {
        if (res.error) console.error('막기 상태 변경 실패:', res.error);
      });
    });
  };

  const handleConfirmDeposit = (reservationId: string) => {
    setReservations((prev) =>
      prev.map((r) =>
        r.id === reservationId ? { ...r, status: 'confirmed' } : r,
      ),
    );
    startTransition(() => {
      confirmDeposit(reservationId).then((res) => {
        if (res.error) console.error('입금확인 실패:', res.error);
      });
    });
  };

  // 낙관적 제거: 이 두 버튼은 카드(=조작 수단) 자체를 없애므로, 서버 액션이 실패하면
  // 되돌려 놓고 눈에 보이게 알린다(그냥 두면 새로고침 전까지 카드가 사라진 채로 남음).
  const resolveChange = (
    changeId: string,
    action: (id: string) => Promise<{ error: string | null }>,
    failMsg: string,
  ) => {
    const removed = changes.find((c) => c.id === changeId);
    setChanges((prev) => prev.filter((c) => c.id !== changeId));
    startTransition(() => {
      action(changeId).then((res) => {
        if (!res.error) return;
        console.error(failMsg, res.error);
        if (removed) {
          setChanges((prev) =>
            prev.some((c) => c.id === changeId) ? prev : [removed, ...prev],
          );
        }
        if (typeof window !== 'undefined') window.alert(failMsg);
      });
    });
  };

  const handleKeepChange = (changeId: string) =>
    resolveChange(changeId, keepReservationChange, '기존 예약 유지 처리에 실패했습니다. 다시 시도해 주세요.');

  const handleConfirmChange = (changeId: string) =>
    resolveChange(changeId, confirmReservationChange, '변경 확정에 실패했습니다. 다시 시도해 주세요.');

  const handleCancelConfirm = (id: string) =>
    resolveChange(id, confirmCancelReview, '취소 확정에 실패했습니다. 다시 시도해 주세요.');

  const handleUncancelConfirm = (id: string) =>
    resolveChange(id, confirmUncancelReview, '예약 되살리기에 실패했습니다. 다시 시도해 주세요.');

  const handleCreateManualBlock = (
    roomCode: string,
    checkIn: string,
    checkOut: string,
    reason: string,
  ) => {
    startTransition(() => {
      createManualBlock(roomCode, checkIn, checkOut, reason).then((res) => {
        if (res.error) console.error('직접 막기 실패:', res.error);
      });
    });
  };

  const handleCancelManualBlock = (group: string) => {
    setBlockTasks((prev) =>
      prev.map((t) =>
        t.manual_block_group === group ? { ...t, status: 'skipped' } : t,
      ),
    );
    startTransition(() => {
      cancelManualBlock(group).then((res) => {
        if (res.error) console.error('직접 막기 취소 실패:', res.error);
      });
    });
  };

  const handleCancelReservation = (reservationId: string) => {
    setReservations((prev) =>
      prev.map((r) => (r.id === reservationId ? { ...r, status: 'cancelled' } : r)),
    );
    startTransition(() => {
      cancelReservation(reservationId).then((res) => {
        if (res.error) console.error('예약 취소 실패:', res.error);
      });
    });
  };

  const handleUpdateNotes = (reservationId: string, notes: string) => {
    setReservations((prev) =>
      prev.map((r) => (r.id === reservationId ? { ...r, notes } : r)),
    );
    startTransition(() => {
      updateReservationNotes(reservationId, notes).then((res) => {
        if (res.error) console.error('비고 저장 실패:', res.error);
      });
    });
  };

  const handleCreateManualReservation = (params: {
    channel: Channel;
    roomName: string;
    guestName: string;
    guestPhone: string | null;
    checkIn: string;
    checkOut: string;
    amount: number | null;
    paymentStatus: PaymentStatus;
    options: ReservationOption[];
  }) => {
    startTransition(() => {
      createManualReservation(params).then((res) => {
        if (res.error) console.error('수동 예약 입력 실패:', res.error);
      });
    });
  };

  const depositCount = reservations.filter((r) => r.status === 'awaiting_deposit').length;
  const blockCount = blockTasks.filter((t) => t.status === 'pending').length;
  const changeCount = changes.filter((c) => c.status === 'pending').length;
  const pendingByKind = {
    change: new Set(
      changes
        .filter((c) => c.status === 'pending' && c.kind === 'change')
        .map((c) => c.reservation_id),
    ),
    cancel: new Set(
      changes
        .filter((c) => c.status === 'pending' && c.kind === 'cancel')
        .map((c) => c.reservation_id),
    ),
    uncancel: new Set(
      changes
        .filter((c) => c.status === 'pending' && c.kind === 'uncancel')
        .map((c) => c.reservation_id),
    ),
  };

  return (
    <>
      <DoubleBookingAlert
        reservations={reservations}
        onCancelReservation={handleCancelReservation}
      />
      <nav className="quick-nav">
        <a href="#changes">
          예약확인
          <span className={`n-count ${changeCount === 0 ? 'zero' : ''}`}>
            {changeCount}
          </span>
        </a>
        <a href="#deposit">
          입금확인
          <span className={`n-count ${depositCount === 0 ? 'zero' : ''}`}>
            {depositCount}
          </span>
        </a>
        <a href="#block">
          막기
          <span className={`n-count ${blockCount === 0 ? 'zero' : ''}`}>
            {blockCount}
          </span>
        </a>
        <a href="#calendar">달력</a>
        <a href="#week">일주일</a>
        <a href="#list">
          전체 예약
          <span className="n-count zero">{reservations.length}</span>
        </a>
        <a href="#stats">통계</a>
      </nav>

      <ReservationChangeQueue
        id="changes"
        changes={changes}
        onKeep={handleKeepChange}
        onConfirm={handleConfirmChange}
        onCancelConfirm={handleCancelConfirm}
        onUncancelConfirm={handleUncancelConfirm}
        todayISO={todayISO}
      />
      <DepositQueue id="deposit" reservations={reservations} onConfirm={handleConfirmDeposit} />
      <BlockWorklist id="block" tasks={blockTasks} onToggle={handleToggleBlock} />
      <RoomCalendar
        id="calendar"
        reservations={reservations}
        blockTasks={blockTasks}
        onCreateManualBlock={handleCreateManualBlock}
        onCancelManualBlock={handleCancelManualBlock}
        onCancelReservation={handleCancelReservation}
        onUpdateNotes={handleUpdateNotes}
      />
      <WeeklyOverview id="week" reservations={reservations} />
      <ManualReservationForm reservations={reservations} onSubmit={handleCreateManualReservation} />
      <ReservationList
        id="list"
        reservations={reservations}
        blockTasks={blockTasks}
        pendingByKind={pendingByKind}
      />
      <Statistics id="stats" reservations={reservations} />
    </>
  );
}
