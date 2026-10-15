import { describe, it, expect, vi, beforeEach } from 'vitest';

// Supabase 전부 목 — lib/ingest.test.ts 와 같은 방식. 멱등/재시도 분기와 저장 값만 검증한다.

const responses = {
  insert: null as { code?: string; message?: string } | null,
  selectStatusSingle: { data: null as { status: string } | null, error: null as unknown },
  upsert: null as { message: string } | null,
};

const ingestLogSelectBuilder = {
  match: vi.fn(() => ingestLogSelectBuilder),
  single: vi.fn(() => Promise.resolve(responses.selectStatusSingle)),
};
const ingestLogUpdateBuilder = { match: vi.fn(() => Promise.resolve({ error: null })) };
const ingestLogBuilder = {
  insert: vi.fn(() => Promise.resolve({ error: responses.insert })),
  select: vi.fn(() => ingestLogSelectBuilder),
  update: vi.fn(() => ingestLogUpdateBuilder),
};
const subscriptionsBuilder = {
  upsert: vi.fn(() => Promise.resolve({ error: responses.upsert })),
};
const mockClient = {
  from: vi.fn((table: string) => {
    if (table === 'ingest_log') return ingestLogBuilder;
    if (table === 'subscriptions') return subscriptionsBuilder;
    throw new Error(`unexpected table: ${table}`);
  }),
};

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => mockClient) }));

const { handleSubscriptionIncoming } = await import('./ingest-subscription');

const body = (plan: number) => `제목: [스테이 온 페이지] 월간구독${plan}개월 신청에 새 응답이 접수되었습니다.
등록위치월간구독${plan}개월 신청 응답
이름
홍길동
연락처
01012345678
주소
(38334)
경북 청도군 화양읍 동천3길 67 (교촌리)
오마이뷱
`;
const applied = new Date('2026-10-14T23:53:08Z'); // KST 10/15 → 시작달 2026-11

describe('handleSubscriptionIncoming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responses.insert = null;
    responses.selectStatusSingle = { data: null, error: null };
    responses.upsert = null;
  });

  it('신규 4개월: pending 으로 저장, 금액 10만, 시작 2026-11 ~ 마침 2027-02, external_id 접두어', async () => {
    const res = await handleSubscriptionIncoming({ externalId: '<m1>', raw: body(4), appliedAt: applied });
    expect(res).toEqual({ status: 'parsed' });
    expect(ingestLogBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'imweb_email', external_id: 'subscription:<m1>' }),
    );
    expect(subscriptionsBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '홍길동',
        phone: '01012345678',
        address: '(38334) 경북 청도군 화양읍 동천3길 67 (교촌리)',
        address_detail: '오마이뷱',
        plan_months: 4,
        amount: 100000,
        status: 'pending',
        start_month: '2026-11',
        end_month: '2027-02',
        applied_at: '2026-10-14T23:53:08.000Z',
        source_external_id: 'subscription:<m1>',
      }),
      { onConflict: 'source_external_id', ignoreDuplicates: true },
    );
    expect(ingestLogBuilder.update).toHaveBeenCalledWith({ status: 'parsed' });
  });

  it('8개월: 금액 20만, 마침 2027-06', async () => {
    await handleSubscriptionIncoming({ externalId: '<m2>', raw: body(8), appliedAt: applied });
    expect(subscriptionsBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ plan_months: 8, amount: 200000, end_month: '2027-06' }),
      expect.anything(),
    );
  });

  it('★ 이미 parsed 인 메일(23505)은 duplicate — 저장 안 함', async () => {
    responses.insert = { code: '23505', message: 'dup' };
    responses.selectStatusSingle = { data: { status: 'parsed' }, error: null };
    const res = await handleSubscriptionIncoming({ externalId: '<m1>', raw: body(4), appliedAt: applied });
    expect(res).toEqual({ status: 'duplicate' });
    expect(subscriptionsBuilder.upsert).not.toHaveBeenCalled();
  });

  it('★ 이전 시도가 실패(23505 + parse_failed)했다면 재시도해서 저장한다(영구 유실 방지)', async () => {
    responses.insert = { code: '23505', message: 'dup' };
    responses.selectStatusSingle = { data: { status: 'parse_failed' }, error: null };
    const res = await handleSubscriptionIncoming({ externalId: '<m1>', raw: body(4), appliedAt: applied });
    expect(res).toEqual({ status: 'parsed' });
    expect(subscriptionsBuilder.upsert).toHaveBeenCalled();
  });

  it('★ 6개월 메일은 parse_failed — 저장하지 않고 로그에 남긴다', async () => {
    const res = await handleSubscriptionIncoming({ externalId: '<m3>', raw: body(6), appliedAt: applied });
    expect(res).toEqual({ status: 'parse_failed' });
    expect(subscriptionsBuilder.upsert).not.toHaveBeenCalled();
    expect(ingestLogBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'parse_failed' }),
    );
  });

  it('저장 오류는 parse_failed 로 기록하고 던진다(다음 폴링에서 재시도)', async () => {
    responses.upsert = { message: 'timeout' };
    await expect(
      handleSubscriptionIncoming({ externalId: '<m4>', raw: body(4), appliedAt: applied }),
    ).rejects.toMatchObject({ message: 'timeout' });
    expect(ingestLogBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'parse_failed', error: 'timeout' }),
    );
  });

  it('ingest_log insert 의 23505 외 오류는 그대로 던진다', async () => {
    responses.insert = { code: '500', message: 'boom' };
    await expect(
      handleSubscriptionIncoming({ externalId: '<m5>', raw: body(4), appliedAt: applied }),
    ).rejects.toMatchObject({ message: 'boom' });
  });
});
