import { NextResponse } from 'next/server';
import {
  pollGmailStayfolioInbox,
  pollGmailImwebInbox,
} from '../../../../lib/mail/poll-gmail';
import { recordHeartbeat } from '../../../../lib/ingest';

// Vercel Cron(또는 수동 호출)으로 주기 실행. CRON_SECRET 공유키로 보호.
// 스테이폴리오·아임웹 알림 메일이 같은 지메일로 들어오므로 한 크론에서 순서대로 둘 다 처리한다.
// 한쪽이 실패해도 다른 쪽 결과는 보존되도록 개별 try/catch.
export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const errors: string[] = [];

  const stayfolio = await pollGmailStayfolioInbox().catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[poll-gmail:stayfolio] failed:', message);
    errors.push(`stayfolio: ${message}`);
    return null;
  });

  const imweb = await pollGmailImwebInbox().catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[poll-gmail:imweb] failed:', message);
    errors.push(`imweb: ${message}`);
    return null;
  });

  // 성공한 쪽만 하트비트 — 실패한 채널의 칩은 오래된 채로 남아 경고가 뜨게 둔다.
  if (stayfolio !== null) await recordHeartbeat('stayfolio_email');
  if (imweb !== null) await recordHeartbeat('imweb_email');

  return NextResponse.json({
    ok: errors.length === 0,
    stayfolio,
    imweb,
    errors,
  });
}
