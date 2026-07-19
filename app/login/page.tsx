'use client';

import { useActionState } from 'react';
import { signIn } from './actions';

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(signIn, {
    error: null,
  });

  return (
    <main style={{ maxWidth: 360, paddingTop: 80 }}>
      <div className="header">
        <h1>Reservation_Dashboard 로그인</h1>
        <p className="sync-row" style={{ marginTop: 4 }}>
          직원 4명 계정으로 로그인하세요. 계정은 관리자가 미리 생성합니다.
        </p>
      </div>

      <form action={formAction} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ fontSize: 13, fontWeight: 600 }}>
          이메일
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            style={inputStyle}
          />
        </label>
        <label style={{ fontSize: 13, fontWeight: 600 }}>
          비밀번호
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            style={inputStyle}
          />
        </label>

        {state.error && (
          <div style={{ color: 'var(--st-awaiting)', fontSize: 13 }}>
            {state.error}
          </div>
        )}

        <button
          type="submit"
          disabled={pending}
          className="deeplink"
          style={{ marginTop: 4, textAlign: 'center', cursor: 'pointer' }}
        >
          {pending ? '로그인 중…' : '로그인'}
        </button>
      </form>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontSize: 14,
};
