import { NextResponse } from 'next/server';
import { pollNaverInbox } from '../../../../lib/mail/poll-naver';
import { recordHeartbeat } from '../../../../lib/ingest';

// Vercel Cron(또는 수동 호출)으로 주기 실행. CRON_SECRET 공유키로 보호 —
// 이 엔드포인트가 공개되면 누구나 우리 메일함을 폴링시킬 수 있으므로 반드시 막아야 함.
export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await pollNaverInbox();
    await recordHeartbeat('naver_email');
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[poll-naver] failed (full):', JSON.stringify(e, Object.getOwnPropertyNames(e as object)));
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
