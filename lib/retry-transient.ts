// Supabase 게이트웨이와 DB 의 시계가 순간적으로 어긋나면 요청마다 새로 발급되는 내부 JWT 가
// "JWT issued at future"(PGRST303)로 거부된다. 요청마다 토큰이 새로 만들어지므로 잠깐 뒤 재시도하면
// 통과한다 — 이 에러에 한해서만 재시도한다(권한·문법 오류는 재시도해도 소용없으니 바로 던짐).
const TRANSIENT_CODES = new Set(['PGRST303']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 250 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (attempt >= attempts || !code || !TRANSIENT_CODES.has(code)) throw e;
      console.warn(`[retry] ${code} — ${attempt}/${attempts - 1}번째 재시도`);
      await sleep(delayMs * attempt);
    }
  }
}
