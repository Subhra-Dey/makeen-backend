import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../../config/env.schema';
import type { EmailMessage, EmailProvider, OtpSms, SmsProvider } from './messaging';

/** Real email over SMTP (Mailpit in development, the company relay in production). */
export class SmtpEmailProvider implements EmailProvider {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(env: Env) {
    this.from = env.MAIL_FROM;
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } } : {}),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/**
 * DEV ONLY (refused in production by env validation): prints messages to the API console so
 * OTPs can be used locally without an SMTP server or SMS gateway. Bypasses the redacting logger
 * on purpose — that is its whole job.
 */
export class ConsoleEmailProvider implements EmailProvider {
  send(message: EmailMessage): Promise<void> {
    console.warn(`\n[DEV EMAIL] to ${message.to} — ${message.subject}\n${message.text}\n`);
    return Promise.resolve();
  }
}

export class ConsoleSmsProvider implements SmsProvider {
  sendOtp(message: OtpSms): Promise<void> {
    console.warn(
      `\n[DEV SMS] to ${message.to} — MAKEEN FM OTP ${message.code} (valid ${String(message.ttlMinutes)} min)\n`,
    );
    return Promise.resolve();
  }
}

/**
 * MSG91 (India) OTP SMS via a DLT-registered template (D-34). The template id and auth key come
 * from env; the template must contain the `##OTP##` variable.
 * API: POST https://control.msg91.com/api/v5/otp?template_id=…&mobile=91XXXXXXXXXX&otp=…
 */
export class Msg91SmsProvider implements SmsProvider {
  constructor(
    private readonly authKey: string,
    private readonly templateId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendOtp(message: OtpSms): Promise<void> {
    const mobile = `91${message.to.replace(/\D/g, '').slice(-10)}`;
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('template_id', this.templateId);
    url.searchParams.set('mobile', mobile);
    url.searchParams.set('otp', message.code);
    url.searchParams.set('otp_expiry', String(message.ttlMinutes));
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authkey: this.authKey, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { type?: unknown };
    if (!res.ok || body.type !== 'success') {
      throw new Error(`MSG91 rejected the OTP SMS (HTTP ${String(res.status)})`);
    }
  }
}

export function createEmailProvider(env: Env): EmailProvider {
  return env.EMAIL_PROVIDER === 'smtp' ? new SmtpEmailProvider(env) : new ConsoleEmailProvider();
}

export function createSmsProvider(env: Env): SmsProvider {
  if (env.SMS_PROVIDER === 'msg91') {
    return new Msg91SmsProvider(env.MSG91_AUTH_KEY ?? '', env.MSG91_OTP_TEMPLATE_ID ?? '');
  }
  return new ConsoleSmsProvider();
}
