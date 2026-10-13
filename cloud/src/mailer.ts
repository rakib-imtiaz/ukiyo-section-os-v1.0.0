// Sign-in emails. Production sends through Resend's HTTP API; without RESEND_API_KEY (dev) the
// message is printed to the console instead, so a local Cloud needs no mail account.
import type { CloudConfig } from './config';
import type { CloudLog } from './context';

export interface MailMessage { to: string; subject: string; text: string; html: string; }
export interface Mailer { send(message: MailMessage): Promise<void>; }

export function createMailer(config: CloudConfig, log: CloudLog): Mailer {
  if (!config.mail.resendApiKey) {
    return {
      async send(message) {
        console.log(`\n[cloud] (dev mail — RESEND_API_KEY not set) to ${message.to}: ${message.subject}\n${message.text}\n`);
      },
    };
  }
  return {
    async send(message) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.mail.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.mail.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        // Resend's error body names the problem (bad key, unverified domain); it never contains the code.
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        log.error('mail send failed', { status: response.status, detail });
        throw new Error(`Resend returned ${response.status}`);
      }
    },
  };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function layout(heading: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6fb;font:15px/1.5 -apple-system,'Segoe UI',sans-serif;color:#0f1b3d">
<div style="max-width:440px;margin:32px auto;background:#fff;border:1px solid #dfe5f0;border-radius:16px;padding:28px">
<h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(heading)}</h1>${body}
<p style="margin:20px 0 0;color:#6b7690;font-size:13px">If you didn't ask for this, you can ignore this email.</p>
</div></body></html>`;
}

export function loginCodeEmail(to: string, code: string): MailMessage {
  return {
    to,
    subject: `${code} is your ThemeBot sign-in code`,
    text: `Your ThemeBot sign-in code is ${code}\n\nEnter it in the ThemeBot app within 10 minutes.\n\nIf you didn't ask for this, you can ignore this email.`,
    html: layout('Your ThemeBot sign-in code', `<p style="margin:0 0 8px">Enter this code in the ThemeBot app:</p>
<p style="margin:0 0 8px;font:600 30px/1.2 ui-monospace,Menlo,monospace;letter-spacing:6px">${escapeHtml(code)}</p>
<p style="margin:0;color:#6b7690">It works for 10 minutes.</p>`),
  };
}

/** Sent instead of a code when the account exists but its plan isn't active. */
export function inactiveAccountEmail(to: string): MailMessage {
  return {
    to,
    subject: 'Your ThemeBot plan is not active',
    text: 'Someone (hopefully you) tried to sign in to ThemeBot with this email, but the plan on this account is not active.\n\nRenew your plan to keep using ThemeBot, or contact whoever sold you ThemeBot.',
    html: layout('Your ThemeBot plan is not active', '<p style="margin:0">Someone (hopefully you) tried to sign in to ThemeBot with this email, but the plan on this account is not active. Renew your plan to keep using ThemeBot, or contact whoever sold you ThemeBot.</p>'),
  };
}
