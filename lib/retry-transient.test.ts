import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTransientRetry } from './retry-transient';

const jwtSkew = () => ({ code: 'PGRST303', message: 'JWT issued at future' });

describe('withTransientRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('성공하면 재시도 없이 값을 돌려준다', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withTransientRetry(fn, { delayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('★ PGRST303(JWT issued at future — Supabase 게이트웨이/DB 시계 순간 어긋남)이면 재시도해서 성공한다 — ' +
    '2026-11-14 실사고(digest 2515174361): 쿼리 7개 중 getSubscriptions 하나만 이 에러로 실패해도 대시보드 전체가 크래시', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValueOnce(jwtSkew()).mockResolvedValue('ok');
    await expect(withTransientRetry(fn, { delayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('계속 실패하면 최대 시도 횟수 후 마지막 에러를 그대로 던진다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValue(jwtSkew());
    await expect(withTransientRetry(fn, { attempts: 3, delayMs: 0 })).rejects.toEqual(jwtSkew());
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('일시 오류가 아닌 에러(예: 권한·문법)는 재시도하지 않고 바로 던진다', async () => {
    const err = { code: '42501', message: 'permission denied' };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withTransientRetry(fn, { delayMs: 0 })).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
