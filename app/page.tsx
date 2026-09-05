import { isSupabaseConfigured } from '../lib/supabase/config';
import { createClient } from '../lib/supabase/server';
import {
  getReservations,
  getBlockTasks,
  getLastSyncByChannel,
  getPendingReservationChanges,
} from '../lib/queries';
import { CHANNEL_LABEL } from '../lib/db-types';
import type { Channel } from '../lib/types';
import { isStale, timeAgo, kstTodayISO } from '../lib/format';
import { DashboardRealtime } from '../components/DashboardRealtime';
import { signOut } from './login/actions';

const CHANNELS: Channel[] = ['naver', 'stayfolio', 'imweb'];

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) {
    return (
      <main>
        <div className="header">
          <h1>Reservation_Dashboard</h1>
        </div>
        <div className="empty" style={{ textAlign: 'left', padding: 20 }}>
          <strong>Supabase 설정이 필요합니다.</strong>
          <p style={{ marginTop: 8, fontSize: 13 }}>
            <code>.env.local.example</code>을 <code>.env.local</code>로 복사하고,
            Supabase 프로젝트의 URL·anon key를 채운 뒤 서버를 재시작하세요.
          </p>
          <p style={{ marginTop: 8, fontSize: 13 }}>
            <code>supabase/migrations/*.sql</code>을 번호 순서대로 Supabase SQL
            에디터에서 실행해야 테이블·함수·정책이 준비됩니다.
          </p>
        </div>
      </main>
    );
  }

  const supabase = await createClient();
  // 계측: 4개 쿼리 중 무엇이 왜 실패하는지 Vercel 로그에 남긴다(Hobby 로그 보존 ~1h,
  // digest 만으론 범인 특정 불가). 실패는 그대로 던져 app/error.tsx 가 받게 둔다.
  const settled = await Promise.allSettled([
    getReservations(supabase),
    getBlockTasks(supabase),
    getLastSyncByChannel(supabase),
    getPendingReservationChanges(supabase),
  ]);
  const names = ['getReservations', 'getBlockTasks', 'getLastSyncByChannel', 'getPendingReservationChanges'] as const;
  const failed = settled.flatMap((r, i) =>
    r.status === 'rejected' ? [{ name: names[i], reason: r.reason }] : [],
  );
  if (failed.length > 0) {
    for (const f of failed) {
      const e = f.reason as { message?: string; code?: string; details?: string; hint?: string };
      console.error(
        `[page] ${f.name} 실패 — message=${e?.message} code=${e?.code} details=${e?.details} hint=${e?.hint}`,
      );
    }
    throw failed[0].reason;
  }
  const [reservations, blockTasks, lastSync, pendingChanges] = settled.map(
    (r) => (r as PromiseFulfilledResult<unknown>).value,
  ) as [
    Awaited<ReturnType<typeof getReservations>>,
    Awaited<ReturnType<typeof getBlockTasks>>,
    Awaited<ReturnType<typeof getLastSyncByChannel>>,
    Awaited<ReturnType<typeof getPendingReservationChanges>>,
  ];

  const now = new Date();
  // "오늘"은 서버에서 한 번만 확정 — 클라이언트가 각자 new Date() 하면 KST 자정 근처에
  // SSR/hydration 이 갈려 위약금 안내(D-day)가 순간 불일치한다.
  const todayISO = kstTodayISO();

  return (
    <main>
      <div className="header">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
          }}
        >
          <h1>Reservation_Dashboard</h1>
          <form action={signOut}>
            <button
              type="submit"
              className="deeplink"
              style={{ cursor: 'pointer' }}
            >
              로그아웃
            </button>
          </form>
        </div>
        <div className="sync-row">
          {CHANNELS.map((c) => {
            const sync = lastSync[c];
            const stale = !sync || isStale(sync, now);
            return (
              <span key={c} className={`sync-chip ${stale ? 'stale' : ''}`}>
                <span
                  className="dot"
                  style={{
                    background: stale
                      ? 'var(--st-awaiting)'
                      : 'var(--st-confirmed)',
                  }}
                />
                {CHANNEL_LABEL[c]} {sync ? timeAgo(sync, now) : '수신 기록 없음'}
                {stale && ' (동기화 확인 필요)'}
              </span>
            );
          })}
        </div>
      </div>

      <DashboardRealtime
        initialReservations={reservations}
        initialBlockTasks={blockTasks}
        initialChanges={pendingChanges}
        todayISO={todayISO}
      />
    </main>
  );
}
