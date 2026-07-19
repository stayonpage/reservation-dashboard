import { NextResponse } from 'next/server';
import { reconcileStayfolioCancellations } from '../../../../lib/mail/reconcile-stayfolio-ics';

// Vercel Cron(또는 수동 호출)으로 주기 실행. CRON_SECRET 공유키로 보호.
// 스테이폴리오는 취소 이메일을 안 보내므로, ICS 캘린더 재조회로 취소를 간접 감지한다.
export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await reconcileStayfolioCancellations();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[reconcile-stayfolio] failed:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
