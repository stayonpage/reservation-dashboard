import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Supabase 쿼리 빌더(.from().select().eq()...)는 체이닝 후 최종적으로 await되는 thenable —
// 체이닝 메서드는 전부 this를 반환하다가 select 결과를 담은 프라미스로 resolve되게 모킹한다.
let mockReservations: unknown[] = [];
let mockQueryError: unknown = null;
const mockRpc = vi.fn().mockResolvedValue({ error: null });
let lastQueryCalls: Record<string, unknown[]> = {};

function makeQueryBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = ['select', 'eq', 'neq', 'gte', 'gt', 'returns'];
  for (const m of chain) {
    builder[m] = vi.fn((...args: unknown[]) => {
      lastQueryCalls[m] = args;
      return builder;
    });
  }
  builder.then = (resolve: (v: { data: unknown; error: unknown }) => void) =>
    resolve({ data: mockReservations, error: mockQueryError });
  return builder;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => makeQueryBuilder(),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

import { reconcileStayfolioCancellations } from './reconcile-stayfolio-ics';

describe('reconcileStayfolioCancellations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockReservations = [];
    mockQueryError = null;
    mockRpc.mockClear();
    mockRpc.mockResolvedValue({ error: null });
    lastQueryCalls = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('★ 안전장치: 대상 필터는 한국시간 기준 "오늘"을 쓰고, 체크아웃 당일 예약은 대사 대상에서 뺀다 — ' +
    '2026-07-25 실사고(스테이폴리오 ICS가 한국시간 자정에 체크아웃 당일 예약을 먼저 지워버려 ' +
    'UTC 자정 전까지 아직 안 걸러진 정상 예약을 취소로 오판) 재발 방지', async () => {
    // UTC 2026-07-25T16:00:00Z = KST 2026-07-26T01:00 — 위험 구간(한국 자정~UTC 자정 사이).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T16:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }));

    await reconcileStayfolioCancellations();

    expect(lastQueryCalls.gt).toEqual(['check_out', '2026-07-26']);
    expect(lastQueryCalls.gte).toBeUndefined();
  });

  it('ICS에 여전히 있는 예약번호는 건드리지 않는다', async () => {
    mockReservations = [
      { id: 'r1', channel_reservation_id: '148929870', room_name: 'page26 - 시가 내려앉는 순간' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          'BEGIN:VEVENT\nDTSTART;VALUE=DATE:20260716\nDTEND;VALUE=DATE:20260717\nDESCRIPTION:Reservation URL: https://host.stayfolio.com/bookings/148929870\nEND:VEVENT',
      }),
    );

    const result = await reconcileStayfolioCancellations();

    expect(result.checkedReservations).toBe(1);
    expect(result.enqueuedReviewCount).toBe(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('ICS에서 사라진 예약번호는 enqueue_ics_cancel_review RPC로 취소 검토 큐에 등록한다', async () => {
    mockReservations = [
      { id: 'r2', channel_reservation_id: '999999999', room_name: 'page26 - 시가 내려앉는 순간' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR' }),
    );

    const result = await reconcileStayfolioCancellations();

    expect(result.enqueuedReviewCount).toBe(1);
    expect(mockRpc).toHaveBeenCalledWith('enqueue_ics_cancel_review', {
      p_reservation_id: 'r2',
    });
  });

  it('★ 안전장치: ICS 조회가 실패한 방은 취소 처리하지 않고 건너뛴다', async () => {
    mockReservations = [
      { id: 'r3', channel_reservation_id: '123123123', room_name: 'page26 - 시가 내려앉는 순간' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await reconcileStayfolioCancellations();

    expect(result.skippedRooms).toContain('page26');
    expect(result.enqueuedReviewCount).toBe(0);
    expect(mockRpc).not.toHaveBeenCalled(); // 네트워크 오류를 "전부 취소"로 오판하지 않는다
  });

  it('★ 안전장치: ICS가 200이 아니면(예: 만료) 취소 대신 건너뛴다', async () => {
    mockReservations = [
      { id: 'r4', channel_reservation_id: '456456456', room_name: 'page26 - 시가 내려앉는 순간' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await reconcileStayfolioCancellations();

    expect(result.skippedRooms).toContain('page26');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('합성키(guest_email|...) 예약은 ICS와 대조할 수 없어 애초에 제외한다', async () => {
    mockReservations = [
      {
        id: 'r5',
        channel_reservation_id: 'guest@example.com|2026-07-01|2026-07-02|page26 - 방',
        room_name: 'page26 - 시가 내려앉는 순간',
      },
    ];
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await reconcileStayfolioCancellations();

    expect(result.checkedRooms).toBe(0); // 대상 자체가 없어 방 조회도 안 함
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('매핑에 없는 방 이름은 제외한다', async () => {
    mockReservations = [
      { id: 'r6', channel_reservation_id: '789789789', room_name: 'page999 - 없는 방' },
    ];
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await reconcileStayfolioCancellations();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.enqueuedReviewCount).toBe(0);
  });

  it('쿼리 자체가 실패하면 예외를 던진다', async () => {
    mockQueryError = { message: 'db down' };
    await expect(reconcileStayfolioCancellations()).rejects.toBeTruthy();
  });
});
