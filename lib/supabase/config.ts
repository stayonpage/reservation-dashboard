// Supabase 프로젝트가 아직 연결 안 됐을 수 있다(로컬 개발/최초 셋업).
// 이 경우 크래시 대신 명확한 "설정 필요" 화면을 보여주기 위한 체크.
// 실제 프로젝트 URL/키는 .env.local(gitignore됨)에 넣는다 — .env.local.example 참고.

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

export function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  return url;
}

export function getSupabaseAnonKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set');
  return key;
}
