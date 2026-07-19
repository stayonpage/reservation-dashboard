'use server';

import { redirect } from 'next/navigation';
import { createClient } from '../../lib/supabase/server';

// 계정은 자체가입이 아니라 Supabase 대시보드에서 4명을 미리 생성해둔다(개별 로그인=감사 목적).
export async function signIn(
  _prevState: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) return { error: '이메일 또는 비밀번호가 올바르지 않습니다.' };

  // profiles 행이 없으면(트리거 미실행/구계정) 최초 로그인 시 보정.
  const user = data.user;
  if (user) {
    await supabase.from('profiles').upsert(
      {
        id: user.id,
        display_name: user.email?.split('@')[0] ?? '직원',
      },
      { onConflict: 'id', ignoreDuplicates: true },
    );
  }

  redirect('/');
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
