'use client';

import { createBrowserClient } from '@supabase/ssr';
import { getSupabaseUrl, getSupabaseAnonKey } from './config';

// 클라이언트 컴포넌트용(realtime 구독, 로그인 폼). 익명 키만 사용 — service role 절대 금지.
export function createClient() {
  return createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey());
}
