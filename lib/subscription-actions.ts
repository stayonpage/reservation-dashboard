'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from './supabase/server';
import { planAmount, endMonthOf, isPlanMonths, type ManualSubscriptionInput } from './subscription';

// 월간구독 뮤테이션. 인증된 사용자 컨텍스트(RLS) — lib/actions.ts 와 같은 방식.
// 상태 전이(입금확인/되돌리기/종료)는 RPC(0029)가 잘못된 전이를 조용히 무시한다.

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
type Result = Promise<{ error: string | null }>;

export async function confirmSubscription(id: string): Result {
  const supabase = await createClient();
  const { error } = await supabase.rpc('confirm_subscription', { p_id: id });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function unconfirmSubscription(id: string): Result {
  const supabase = await createClient();
  const { error } = await supabase.rpc('unconfirm_subscription', { p_id: id });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function setSubscriptionEnded(id: string, ended: boolean): Result {
  const supabase = await createClient();
  const { error } = await supabase.rpc('end_subscription', { p_id: id, p_ended: ended });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function updateSubscription(
  id: string,
  patch: {
    start_month?: string;
    end_month?: string;
    notes?: string | null;
    stay_discount_used?: boolean;
  },
): Result {
  if (patch.start_month !== undefined && !MONTH_RE.test(patch.start_month)) {
    return { error: '시작달 형식이 올바르지 않습니다.' };
  }
  if (patch.end_month !== undefined && !MONTH_RE.test(patch.end_month)) {
    return { error: '마치는 달 형식이 올바르지 않습니다.' };
  }
  const supabase = await createClient();
  const { error } = await supabase.from('subscriptions').update(patch).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function saveShipmentMemo(subscriptionId: string, month: string, memo: string): Result {
  if (!MONTH_RE.test(month)) return { error: '월 형식이 올바르지 않습니다.' };
  const supabase = await createClient();
  const { error } = await supabase
    .from('subscription_shipments')
    .upsert(
      { subscription_id: subscriptionId, month, memo, updated_at: new Date().toISOString() },
      { onConflict: 'subscription_id,month' },
    );
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function createManualSubscription(input: ManualSubscriptionInput): Result {
  const name = input.name.trim();
  if (!name) return { error: '이름을 입력해 주세요.' };
  if (!isPlanMonths(input.planMonths)) return { error: '4개월 또는 8개월만 선택할 수 있습니다.' };
  if (!MONTH_RE.test(input.startMonth)) return { error: '시작달 형식이 올바르지 않습니다.' };
  const supabase = await createClient();
  const { error } = await supabase.from('subscriptions').insert({
    name,
    phone: input.phone.replace(/\D/g, '') || null,
    address: input.address.trim() || null,
    address_detail: input.addressDetail.trim() || null,
    plan_months: input.planMonths,
    amount: planAmount(input.planMonths),
    status: 'pending',
    start_month: input.startMonth,
    end_month: endMonthOf(input.startMonth, input.planMonths),
  });
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}

export async function deleteSubscription(id: string): Result {
  const supabase = await createClient();
  const { error } = await supabase.from('subscriptions').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/');
  return { error: null };
}
