import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isSupabaseConfigured } from './lib/supabase/config';

// 요청마다 세션 쿠키 갱신 + 미인증 사용자를 /login 으로.
// Supabase 미설정(최초 셋업) 시에는 우회 — app/page.tsx 가 "설정 필요" 화면을 보여줌.
export async function middleware(request: NextRequest) {
  // 이 프로젝트는 App Router만 쓰고 pages 라우터 데이터 라우트가 없는데, 일부 브라우저(웨일 등)의
  // 프리페치 기능이 /_next/data/[build id]/*.json 형태 요청을 계속 보낸다 — 이 경로가 Next.js
  // 자체의 내부 처리로 넘어가면 서버 함수가 JavaScript heap out of memory로 죽는 게 실사례로
  // 확인됨(build id는 최신 배포 걸 정확히 따라오므로 "오래된 캐시" 문제가 아니라 이 경로 자체가
  // 문제). Supabase 세션 체크도, Next.js 내부 핸들러도 타지 않도록 미들웨어 맨 앞에서 가볍게 차단.
  if (request.nextUrl.pathname.startsWith('/_next/data/')) {
    return new NextResponse(null, { status: 404 });
  }

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
  // /_next/data는 매처에 그대로 포함 — 함수 맨 앞의 조기 차단 로직을 반드시 거치게 하기 위함
  // (매처에서 아예 빼면 Next.js 자체 내부 핸들러로 넘어가 버려서 오히려 더 위험함).
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon-.*\\.png|api/).*)',
  ],
};
