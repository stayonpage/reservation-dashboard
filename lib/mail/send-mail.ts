// IMAP 수신(poll-gmail.ts 등)과 같은 Gmail 앱 비밀번호 자격증명을 SMTP 발신에도 재사용한다
// (Gmail 앱 비밀번호는 IMAP·SMTP 공용). 긴급 알림(today-page-alert.ts)처럼 "지금 당장
// 사람에게 닿아야 하는" 용도에만 쓴다 — 일반 안내 메일 발송용 아님.

import nodemailer from 'nodemailer';

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_MAIL_USER;
  const pass = process.env.GMAIL_MAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return transporter;
}

export async function sendMail(args: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const t = getTransporter();
  const user = process.env.GMAIL_MAIL_USER;
  if (!t || !user) {
    console.error('[send-mail] GMAIL_MAIL_USER/APP_PASSWORD 미설정 — 발송 생략:', args.subject);
    return;
  }
  await t.sendMail({ from: user, to: args.to, subject: args.subject, text: args.text });
}
