import { createClient } from '@supabase/supabase-js';

// 서버 전용 service-role 클라이언트. RLS 를 우회하므로 절대 클라이언트 번들에 넣지 말 것.
//
// 대시보드 초기 로드(app/page.tsx)의 읽기 전용 쿼리에 쓴다. 세션 쿠키 기반 클라이언트(사용자
// JWT)는 PostgREST 가 간헐적으로 "JWT issued at future"(PGRST303 — GoTrue/DB 시계 오차)로
// 거부해 대시보드 전체가 크래시하는 사례가 실제로 있었다(2026-09, digest 1564722520).
// 이 쿼리들이 읽는 테이블의 RLS 정책은 전부 "authenticated 전원 전체 권한"(using (true))이라
// 사용자별 필터링이 없고, 접근 자체는 middleware.ts 가 로그인 여부로 이미 게이트한다 —
// service role 로 바꿔도 보안이 낮아지지 않으면서 이 시계-오차 취약점 자체를 없앤다.
export function createAdminClient() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
