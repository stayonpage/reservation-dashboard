import { isSupabaseConfigured } from '../lib/supabase/config';
import { createClient } from '../lib/supabase/server';
import {
  getReservations,
  getBlockTasks,
  getLastSyncByChannel,
} from '../lib/queries';
import { CHANNEL_LABEL } from '../lib/db-types';
import type { Channel } from '../lib/types';
import { isStale, timeAgo } from '../lib/format';
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
  const [reservations, blockTasks, lastSync] = await Promise.all([
    getReservations(supabase),
    getBlockTasks(supabase),
    getLastSyncByChannel(supabase),
  ]);

  const now = new Date();

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
      />
    </main>
  );
}
