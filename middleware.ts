import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isSupabaseConfigured } from './lib/supabase/config';

// 요청마다 세션 쿠키 갱신 + 미인증 사용자를 /login 으로.
// Supabase 미설정(최초 셋업) 시에는 우회 — app/page.tsx 가 "설정 필요" 화면을 보여줌.
export async function middleware(request: NextRequest) {
  if (!isSupabaseConfigured()) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
        ) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLoginPage = request.nextUrl.pathname.startsWith('/login');

  if (!user && !isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  if (user && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // /api/* 제외: 크론(CRON_SECRET)·웹훅(자체 서명 검증) 라우트는 세션 쿠키가 아니라
  // 각자의 방식으로 인증한다 — 여기서 걸리면 curl/외부 서비스가 전부 /login으로 튕긴다.
  // /_next/data 제외: 이 프로젝트는 App Router만 쓰고 pages 라우터 데이터 라우트가 없는데,
  // 일부 브라우저(웨일 등)의 프리페치 기능이 이전 배포의 build id로 이 경로를 계속 요청해서
  // 미들웨어가 매번 붙잡고 처리하다 서버 함수가 죽는 문제(OOM)가 실사례로 확인됨 — 애초에
  // 이 경로엔 인증 게이트가 필요 없으므로 완전히 우회시킨다.
  matcher: [
    '/((?!_next/static|_next/data|_next/image|favicon.ico|manifest.webmanifest|icon-.*\\.png|api/).*)',
  ],
};
