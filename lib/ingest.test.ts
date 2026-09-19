import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ParsedReservation } from './types';

// Supabase 는 전부 목(mock) — 실제 접속 없이 handleIncoming 의 멱등/재시도 분기만 검증한다.
// 실사례(2026-09): 박재홍님 10/2 예약 메일이 ingest_reservation RPC 의 일시적
// "Gateway Timeout" 으로 실패했는데, ingest_log 행이 이미 insert 돼 있어서 다음 폴링부터
// 계속 "중복"으로 오인돼 재시도가 아예 안 되고 예약이 영구 유실됐다(직원이 수기 등록).

const responses = {
  insert: null as { code?: string; message?: string } | null,
  selectStatusSingle: { data: null as { status: string } | null, error: null as unknown },
  update: null as unknown,
  rpc: { data: 'reservation-id-1' as string | null, error: null as { message: string } | null },
};

const ingestLogSelectBuilder = {
  match: vi.fn(() => ingestLogSelectBuilder),
  single: vi.fn(() => Promise.resolve(responses.selectStatusSingle)),
};
const ingestLogUpdateBuilder = {
  match: vi.fn(() => Promise.resolve({ error: responses.update })),
};
const ingestLogBuilder = {
  insert: vi.fn(() => Promise.resolve({ error: responses.insert })),
  select: vi.fn(() => ingestLogSelectBuilder),
  update: vi.fn(() => ingestLogUpdateBuilder),
};

const reservationsSelectBuilder = {
  eq: vi.fn(() => reservationsSelectBuilder),
  single: vi.fn(() => Promise.resolve({ data: { notes: null }, error: null })),
};
const reservationsUpdateBuilder = { eq: vi.fn(() => Promise.resolve({ error: null })) };
const reservationsBuilder = {
  select: vi.fn(() => reservationsSelectBuilder),
  update: vi.fn(() => reservationsUpdateBuilder),
};

const mockClient = {
  from: vi.fn((table: string) => {
    if (table === 'ingest_log') return ingestLogBuilder;
    if (table === 'reservations') return reservationsBuilder;
    throw new Error(`unexpected table: ${table}`);
  }),
  rpc: vi.fn(() => Promise.resolve(responses.rpc)),
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockClient),
}));

const { handleIncoming } = await import('./ingest');

const naverParsed: ParsedReservation = {
  channel: 'naver',
  channel_reservation_id: '1349787941',
  guest_name: '박재홍',
  guest_phone: null,
  room_name: '객실 남쪽',
  check_in: '2026-10-02',
  check_out: '2026-10-03',
  amount: 164000,
  options: [],
  payment_method: 'cash',
  payment_status: 'pending',
  cancelled: false,
  guest_request: null,
  raw_payload: { text: 'raw' },
};

describe('handleIncoming — 멱등/재시도', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responses.insert = null;
    responses.selectStatusSingle = { data: null, error: null };
    responses.update = null;
    responses.rpc = { data: 'reservation-id-1', error: null };
  });

  it('신규 메일: insert 성공 → 파싱·RPC 진행', async () => {
    const result = await handleIncoming({
      source: 'naver_email',
      externalId: '<new-1>',
      raw: 'raw text',
      parse: () => naverParsed,
    });

    expect(result).toEqual({ status: 'parsed', reservationId: 'reservation-id-1' });
    expect(mockClient.rpc).toHaveBeenCalledTimes(1);
  });

  it("진짜 중복(이전 시도가 이미 'parsed' 완료) → 재파싱 없이 duplicate", async () => {
    responses.insert = { code: '23505' };
    responses.selectStatusSingle = { data: { status: 'parsed' }, error: null };
    const parseFn = vi.fn(() => naverParsed);

    const result = await handleIncoming({
      source: 'naver_email',
      externalId: '<already-parsed>',
      raw: 'raw text',
      parse: parseFn,
    });

    expect(result).toEqual({ status: 'duplicate' });
    expect(parseFn).not.toHaveBeenCalled();
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });

  it("이전 시도가 RPC 일시 오류(Gateway Timeout)로 실패해 'parse_failed' 로 남아있으면 → 재시도해서 성공시킨다 (실사례 재발 방지)", async () => {
    responses.insert = { code: '23505' };
    responses.selectStatusSingle = { data: { status: 'parse_failed' }, error: null };
    const parseFn = vi.fn(() => naverParsed);

    const result = await handleIncoming({
      source: 'naver_email',
      externalId: '<1349787941-retry>',
      raw: 'raw text',
      parse: parseFn,
    });

    expect(parseFn).toHaveBeenCalledTimes(1);
    expect(mockClient.rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'parsed', reservationId: 'reservation-id-1' });
    // insert 대신 update 로 기존 로그 행을 'parsed' 로 갱신했는지
    expect(ingestLogBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'parsed', parsed_reservation_id: 'reservation-id-1' }),
    );
  });

  it("이전 시도가 중간에 끊겨 'received' 상태로만 남아있어도 재시도한다", async () => {
    responses.insert = { code: '23505' };
    responses.selectStatusSingle = { data: { status: 'received' }, error: null };
    const parseFn = vi.fn(() => naverParsed);

    const result = await handleIncoming({
      source: 'naver_email',
      externalId: '<interrupted>',
      raw: 'raw text',
      parse: parseFn,
    });

    expect(parseFn).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('parsed');
  });

  it('재시도했는데 이번에도 RPC 가 실패하면 여전히 parse_failed 로 기록하고 던진다', async () => {
    responses.insert = { code: '23505' };
    responses.selectStatusSingle = { data: { status: 'parse_failed' }, error: null };
    responses.rpc = { data: null, error: { message: 'Gateway Timeout' } };

    await expect(
      handleIncoming({
        source: 'naver_email',
        externalId: '<still-failing>',
        raw: 'raw text',
        parse: () => naverParsed,
      }),
    ).rejects.toEqual({ message: 'Gateway Timeout' });

    expect(ingestLogBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'parse_failed', error: 'Gateway Timeout' }),
    );
  });

  it('insert 충돌인데 23505 이외의 에러면 그대로 던진다', async () => {
    responses.insert = { code: '42501', message: 'permission denied' };

    await expect(
      handleIncoming({
        source: 'naver_email',
        externalId: '<perm-denied>',
        raw: 'raw text',
        parse: () => naverParsed,
      }),
    ).rejects.toBeTruthy();
  });

  it('파서가 null 반환 → parse_failed (신규 insert 경로, 기존 동작 유지)', async () => {
    const result = await handleIncoming({
      source: 'naver_email',
      externalId: '<unparseable>',
      raw: 'raw text',
      parse: () => null,
    });

    expect(result).toEqual({ status: 'parse_failed' });
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });
});
