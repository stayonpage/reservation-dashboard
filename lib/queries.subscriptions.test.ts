import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSubscriptions, getSubscriptionShipments } from './queries';

// 배포 순서 슬립(0029 미적용)으로 테이블이 없을 때 대시보드 전체가 500 나면 안 된다.
// 실제 PostgREST 는 테이블 없음을 'PGRST205'(schema cache)로 돌려준다(2026-10-15 빌드에서 확인) —
// Postgres 원본 코드 '42P01' 만 막으면 운영 대시보드가 크래시한다.

function fakeClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.order = vi.fn(() => Promise.resolve(result));
  builder.then = (resolve: (v: unknown) => unknown) => resolve(result); // order 없이 await 되는 경우
  return { from: vi.fn(() => builder) } as unknown as SupabaseClient;
}

describe.each([
  ['getSubscriptions', getSubscriptions],
  ['getSubscriptionShipments', getSubscriptionShipments],
])('%s — 테이블 없음 폴백', (_name, fn) => {
  it('★ PGRST205(PostgREST schema cache)면 빈 배열', async () => {
    const sb = fakeClient({ data: null, error: { code: 'PGRST205', message: 'Could not find the table' } });
    await expect(fn(sb)).resolves.toEqual([]);
  });

  it('42P01 이어도 빈 배열', async () => {
    const sb = fakeClient({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
    await expect(fn(sb)).resolves.toEqual([]);
  });

  it('그 외 오류는 그대로 던진다', async () => {
    const sb = fakeClient({ data: null, error: { code: 'PGRST303', message: 'JWT issued at future' } });
    await expect(fn(sb)).rejects.toMatchObject({ code: 'PGRST303' });
  });

  it('정상 데이터는 그대로 반환', async () => {
    const rows = [{ id: 'a' }];
    const sb = fakeClient({ data: rows, error: null });
    await expect(fn(sb)).resolves.toEqual(rows);
  });
});
