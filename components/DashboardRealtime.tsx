'use client';

import { useEffect, useState, useTransition } from 'react';
import { createClient } from '../lib/supabase/client';
import type { Reservation, BlockTask } from '../lib/db-types';
import { DepositQueue } from './DepositQueue';
import { BlockWorklist } from './BlockWorklist';
import { ReservationList } from './ReservationList';
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
}: {
  initialReservations: Reservation[];
  initialBlockTasks: BlockTask[];
}) {
  const [reservations, setReservations] = useState(initialReservations);
  const [blockTasks, setBlockTasks] = useState(initialBlockTasks);
  const [, startTransition] = useTransition();

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

  return (
    <>
      <DoubleBookingAlert
        reservations={reservations}
        onCancelReservation={handleCancelReservation}
      />
      <nav className="quick-nav">
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
      <ReservationList id="list" reservations={reservations} blockTasks={blockTasks} />
      <Statistics id="stats" reservations={reservations} />
    </>
  );
}
