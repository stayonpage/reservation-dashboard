// 화면이 백그라운드/절전/네트워크 단절에서 돌아올 때 재조회를 트리거하는 이벤트 배선.
//
// 왜 필요한가(실사례 2026-09): 이 대시보드는 초기 로드 + realtime 구독으로만 화면을 갱신한다.
// 폰 홈화면 PWA(iOS)는 백그라운드에서 WebSocket 이 끊기고, PC 탭도 노트북 절전·와이파이 전환·
// 브라우저 탭 동결로 끊긴다. 끊긴 채 다시 보이면 마지막 화면 그대로 멈춰 있어서 폰/PC 화면이
// 서로 달라졌고, 새로고침해야 맞았다. 복귀·네트워크 복구 시점에 한 번 다시 불러온다.
//
// DOM 전역(document/window)을 직접 쓰지 않고 주입받아 node 환경(vitest)에서 검증 가능하게 한다.

interface Listenable {
  addEventListener(type: string, listener: (e: any) => void): void;
  removeEventListener(type: string, listener: (e: any) => void): void;
}

export function attachResync(opts: {
  doc: Listenable & { visibilityState?: string };
  win: Listenable;
  onResync: () => void;
  /** 이 간격 안의 연속 트리거는 1회로 합친다(visibilitychange+focus 동시 발생 등). 기본 15초. */
  minIntervalMs?: number;
  now?: () => number;
}): () => void {
  const { doc, win, onResync } = opts;
  const minIntervalMs = opts.minIntervalMs ?? 15_000;
  const now = opts.now ?? (() => Date.now());
  let last = Number.NEGATIVE_INFINITY;

  const trigger = () => {
    const t = now();
    if (t - last < minIntervalMs) return;
    last = t;
    onResync();
  };

  const onVisibility = () => {
    if (doc.visibilityState === 'visible') trigger();
  };
  const onOnline = () => trigger();
  const onFocus = () => trigger();
  const onPageShow = (e: { persisted?: boolean }) => {
    if (e?.persisted) trigger(); // bfcache 복원 — 일반 로드는 SSR 이 이미 최신
  };

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('online', onOnline);
  win.addEventListener('focus', onFocus);
  win.addEventListener('pageshow', onPageShow);

  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('online', onOnline);
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('pageshow', onPageShow);
  };
}
