import { describe, it, expect, vi } from 'vitest';
import { attachResync } from './resync';

// document/window 대신 최소 EventTarget 목을 주입해 node 환경에서 검증한다.
function makeTarget<T extends Record<string, unknown> = Record<string, never>>(extra?: T) {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const target = {
    ...(extra ?? {}),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      handlers.get(type)?.delete(fn);
    },
    emit: (type: string, e: unknown = {}) => {
      handlers.get(type)?.forEach((fn) => fn(e));
    },
    listenerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
  return target;
}

// 실사례(2026-09): 폰/PC 화면이 서로 다름 — 탭·앱이 백그라운드/절전에서 돌아와도 실시간 연결이
// 끊긴 채 옛 화면 그대로였고 새로고침해야 맞았다. 복귀·네트워크 복구 때 재조회해야 한다.
describe('attachResync', () => {
  it('탭이 다시 보이면(visibilityState=visible) 재조회한다', () => {
    const doc = makeTarget({ visibilityState: 'visible' });
    const win = makeTarget();
    const onResync = vi.fn();
    attachResync({ doc, win, onResync, minIntervalMs: 0 });

    doc.emit('visibilitychange');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('탭이 숨겨질 때(hidden)는 재조회하지 않는다', () => {
    const doc = makeTarget({ visibilityState: 'hidden' });
    const win = makeTarget();
    const onResync = vi.fn();
    attachResync({ doc, win, onResync, minIntervalMs: 0 });

    doc.emit('visibilitychange');
    expect(onResync).not.toHaveBeenCalled();
  });

  it('네트워크가 복구되면(online) 재조회한다', () => {
    const doc = makeTarget({ visibilityState: 'visible' });
    const win = makeTarget();
    const onResync = vi.fn();
    attachResync({ doc, win, onResync, minIntervalMs: 0 });

    win.emit('online');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('bfcache 복원(pageshow persisted=true)이면 재조회, 일반 로드(persisted=false)는 안 함', () => {
    const doc = makeTarget({ visibilityState: 'visible' });
    const win = makeTarget();
    const onResync = vi.fn();
    attachResync({ doc, win, onResync, minIntervalMs: 0 });

    win.emit('pageshow', { persisted: false });
    expect(onResync).not.toHaveBeenCalled();
    win.emit('pageshow', { persisted: true });
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('창 포커스 복귀(focus)도 재조회한다', () => {
    const doc = makeTarget({ visibilityState: 'visible' });
    const win = makeTarget();
    const onResync = vi.fn();
    attachResync({ doc, win, onResync, minIntervalMs: 0 });

    win.emit('focus');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('최소 간격 안의 연속 이벤트는 1회로 합친다(visibilitychange+focus 동시 발생 등)', () => {
    const doc = makeTarget({ visibilityState: 'visible' });
    const win = makeTarget();
    const onResync = vi.fn();
    let t = 1_000_000;
    attachResync({ doc, win, onResync, minIntervalMs: 15_000, now: () => t });

    doc.emit('visibilitychange');
    win.emit('focus');
    win.emit('online');
    expect(onResync).toHaveBeenCalledTimes(1);

    t += 14_999;
    win.emit('focus');
    expect(onResync).toHaveBeenCalledTimes(1);

    t += 2; // 15초 경과
    win.emit('focus');
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it('반환된 해제 함수를 부르면 리스너가 모두 제거되고 더는 호출되지 않는다', () => {
    const doc = makeTarget({ visibilityState: 'visible' });
    const win = makeTarget();
    const onResync = vi.fn();
    const detach = attachResync({ doc, win, onResync, minIntervalMs: 0 });
    expect(doc.listenerCount() + win.listenerCount()).toBeGreaterThan(0);

    detach();
    expect(doc.listenerCount() + win.listenerCount()).toBe(0);
    doc.emit('visibilitychange');
    win.emit('online');
    expect(onResync).not.toHaveBeenCalled();
  });
});
