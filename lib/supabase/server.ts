import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getSupabaseUrl, getSupabaseAnonKey } from './config';

// 서버 컴포넌트/서버 액션용. 쿠키의 세션으로 인증된 사용자로 접속 —
// RLS 정책("authed full ...")이 이 컨텍스트에서 그대로 적용된다(4인 동일 풀권한).
// service role이 아니므로 인증 안 된 요청은 RLS에 막힌다.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options: CookieOptions }[],
      ) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component에서 호출되면 쓰기가 무시됨(미들웨어가 세션 갱신 담당) — 정상.
        }
      },
    },
  });
}
