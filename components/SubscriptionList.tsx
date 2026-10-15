'use client';

import { useState } from 'react';
import type { Subscription, SubscriptionShipment } from '../lib/db-types';
import {
  SUBSCRIPTION_STATUS_LABEL,
  sortSubscriptions,
  monthsBetween,
  endMonthOf,
  defaultStartMonth,
  kstDateOf,
  formatContactText,
  type ManualSubscriptionInput,
  type PlanMonths,
} from '../lib/subscription';
import { formatWon } from '../lib/format';

// 월간구독 섹션. 상태는 부모(DashboardRealtime)가 소유 — 이 컴포넌트는 표시 + 콜백만.
// 정렬: 입금대기 → 확정 → 종료(종료는 맨 뒤). 접어서 5건만 보이고 "더 보기".
const COLLAPSED_COUNT = 5;

// 클립보드 복사. 브라우저/PWA 가 navigator.clipboard 를 막으면(비보안 컨텍스트 등) 선택 복사로,
// 그것도 안 되면 prompt 로 직접 복사하게 한다 — 복사가 조용히 실패하면 안 된다.
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // 아래 대체 경로로
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) window.prompt('아래 내용을 복사하세요', text);
}

export function SubscriptionList({
  subscriptions,
  shipments,
  onConfirm,
  onUnconfirm,
  onSetEnded,
  onUpdate,
  onSaveShipment,
  onCreate,
  onDelete,
  id,
}: {
  subscriptions: Subscription[];
  shipments: SubscriptionShipment[];
  onConfirm: (id: string) => void;
  onUnconfirm: (id: string) => void;
  onSetEnded: (id: string, ended: boolean) => void;
  onUpdate: (
    id: string,
    patch: {
      start_month?: string;
      end_month?: string;
      notes?: string | null;
      stay_discount_used?: boolean;
    },
  ) => void;
  onSaveShipment: (subscriptionId: string, month: string, memo: string) => void;
  onCreate: (input: ManualSubscriptionInput) => void;
  onDelete: (id: string) => void;
  id?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    phone: '',
    address: '',
    addressDetail: '',
    planMonths: 4 as PlanMonths,
    startMonth: defaultStartMonth(new Date().toISOString()),
  });

  const sorted = sortSubscriptions(subscriptions);
  const shown = expanded ? sorted : sorted.slice(0, COLLAPSED_COUNT);
  const hiddenCount = sorted.length - shown.length;
  const memoOf = (subId: string, month: string) =>
    shipments.find((s) => s.subscription_id === subId && s.month === month)?.memo ?? '';

  return (
    <section id={id}>
      <div className="section-title">
        <h2>월간구독</h2>
        <span className="count-pill">{subscriptions.length}명</span>
      </div>

      {sorted.length === 0 ? (
        <div className="empty">구독 신청 없음</div>
      ) : (
        shown.map((s) => {
          const open = !!openIds[s.id];
          return (
            <div key={s.id} className="card">
              <div className="card-top">
                <div>
                  <div className="card-title">
                    {s.name} · {s.plan_months}개월
                  </div>
                  <div className="card-meta">
                    {s.phone ?? '연락처 없음'}
                    <br />
                    {s.address ?? '주소 없음'}
                    {s.address_detail && ` ${s.address_detail}`}
                    <br />
                    <label>
                      시작{' '}
                      <input
                        type="month"
                        value={s.start_month}
                        onChange={(e) =>
                          e.target.value &&
                          onUpdate(s.id, {
                            start_month: e.target.value,
                            end_month: endMonthOf(e.target.value, s.plan_months),
                          })
                        }
                      />
                    </label>{' '}
                    <label>
                      종료{' '}
                      <input
                        type="month"
                        value={s.end_month}
                        onChange={(e) => e.target.value && onUpdate(s.id, { end_month: e.target.value })}
                      />
                    </label>
                    <br />
                    신청 {kstDateOf(s.applied_at)}
                    {s.confirmed_at && ` · 입금확인 ${kstDateOf(s.confirmed_at)}`}
                  </div>
                </div>
                <div className="amount">{formatWon(s.amount)}</div>
              </div>

              <div className="badge-row">
                <span className={`sub-badge sub-${s.status}`}>{SUBSCRIPTION_STATUS_LABEL[s.status]}</span>
                {s.status === 'pending' && (
                  <button type="button" className="btn-primary" onClick={() => onConfirm(s.id)}>
                    입금확인
                  </button>
                )}
                {s.status === 'confirmed' && (
                  <>
                    <label className="sub-end-check">
                      <input type="checkbox" checked={false} onChange={() => onSetEnded(s.id, true)} /> 종료
                    </label>
                    <button type="button" className="deeplink" onClick={() => onUnconfirm(s.id)}>
                      입금확인 취소
                    </button>
                  </>
                )}
                {s.status === 'ended' && (
                  <label className="sub-end-check">
                    <input type="checkbox" checked onChange={() => onSetEnded(s.id, false)} /> 종료
                  </label>
                )}
                <label className="sub-end-check">
                  <input
                    type="checkbox"
                    checked={s.stay_discount_used}
                    onChange={(e) => onUpdate(s.id, { stay_discount_used: e.target.checked })}
                  />{' '}
                  숙박 할인 받음
                </label>
                <button
                  type="button"
                  className="deeplink"
                  onClick={() => {
                    copyText(formatContactText(s)).then(() => {
                      setCopiedId(s.id);
                      setTimeout(() => setCopiedId((cur) => (cur === s.id ? null : cur)), 1500);
                    });
                  }}
                >
                  {copiedId === s.id ? '복사됨 ✓' : '정보 복사'}
                </button>
                <button
                  type="button"
                  className="deeplink"
                  onClick={() => setOpenIds((prev) => ({ ...prev, [s.id]: !open }))}
                >
                  {open ? '접기' : '발송 메모'}
                </button>
                <button
                  type="button"
                  className="reservation-cancel-btn"
                  onClick={() => {
                    if (window.confirm(`${s.name} 구독을 삭제할까요? 발송 메모도 함께 사라집니다.`)) {
                      onDelete(s.id);
                    }
                  }}
                >
                  삭제
                </button>
              </div>

              {open && (
                <div className="sub-memo-panel">
                  {monthsBetween(s.start_month, s.end_month).map((m) => {
                    const saved = memoOf(s.id, m);
                    return (
                      <label key={`${s.id}-${m}-${saved}`} className="sub-memo-row">
                        <span>{m}</span>
                        <input
                          type="text"
                          defaultValue={saved}
                          placeholder="발송한 책 / 특산물"
                          onBlur={(e) => {
                            if (e.target.value !== saved) onSaveShipment(s.id, m, e.target.value);
                          }}
                        />
                      </label>
                    );
                  })}
                  <label className="sub-memo-row">
                    <span>메모</span>
                    <input
                      key={`${s.id}-notes-${s.notes ?? ''}`}
                      type="text"
                      defaultValue={s.notes ?? ''}
                      placeholder="자유 메모"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (s.notes ?? '')) onUpdate(s.id, { notes: v || null });
                      }}
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })
      )}

      {hiddenCount > 0 && (
        <button type="button" className="block-more-btn" onClick={() => setExpanded(true)}>
          {hiddenCount}명 더 보기
        </button>
      )}
      {expanded && sorted.length > COLLAPSED_COUNT && (
        <button type="button" className="block-more-btn" onClick={() => setExpanded(false)}>
          접기
        </button>
      )}

      <details className="sub-manual">
        <summary>구독자 직접 추가</summary>
        <div className="sub-manual-grid">
          <input placeholder="이름" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="연락처" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input placeholder="주소" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <input placeholder="상세주소" value={form.addressDetail} onChange={(e) => setForm({ ...form, addressDetail: e.target.value })} />
          <select value={form.planMonths} onChange={(e) => setForm({ ...form, planMonths: Number(e.target.value) as PlanMonths })}>
            <option value={4}>4개월 (10만원)</option>
            <option value={8}>8개월 (20만원)</option>
          </select>
          <input type="month" value={form.startMonth} onChange={(e) => setForm({ ...form, startMonth: e.target.value })} />
          <button
            type="button"
            className="btn-primary"
            disabled={!form.name.trim() || !form.startMonth}
            onClick={() => {
              onCreate(form);
              setForm({ ...form, name: '', phone: '', address: '', addressDetail: '' });
            }}
          >
            추가
          </button>
        </div>
      </details>
    </section>
  );
}
