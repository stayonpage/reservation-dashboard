import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase 쿼리 빌더(.from().select().eq()...)는 체이닝 후 최종적으로 await되는 thenable —
// 체이닝 메서드는 전부 this를 반환하다가 select 결과를 담은 프라미스로 resolve되게 모킹한다.
let mockReservations: unknown[] = [];
let mockQueryError: unknown = null;
const mockRpc = vi.fn().mockResolvedValue({ error: null });

function makeQueryBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = ['select', 'eq', 'neq', 'gte', 'returns'];
  for (const m of chain) {
    builder[m] = vi.fn(() => builder);
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
    expect(result.cancelledCount).toBe(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('ICS에서 사라진 예약번호는 cancel_reservation RPC로 취소한다', async () => {
    mockReservations = [
      { id: 'r2', channel_reservation_id: '999999999', room_name: 'page26 - 시가 내려앉는 순간' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR' }),
    );

    const result = await reconcileStayfolioCancellations();

    expect(result.cancelledCount).toBe(1);
    expect(mockRpc).toHaveBeenCalledWith('cancel_reservation', {
      p_id: 'r2',
      p_reason: 'stayfolio_ics_missing',
    });
  });

  it('★ 안전장치: ICS 조회가 실패한 방은 취소 처리하지 않고 건너뛴다', async () => {
    mockReservations = [
      { id: 'r3', channel_reservation_id: '123123123', room_name: 'page26 - 시가 내려앉는 순간' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await reconcileStayfolioCancellations();

    expect(result.skippedRooms).toContain('page26');
    expect(result.cancelledCount).toBe(0);
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
    expect(result.cancelledCount).toBe(0);
  });

  it('쿼리 자체가 실패하면 예외를 던진다', async () => {
    mockQueryError = { message: 'db down' };
    await expect(reconcileStayfolioCancellations()).rejects.toBeTruthy();
  });
});
