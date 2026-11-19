import type {
  EmailMessage,
  EmailProvider,
  OtpSms,
  SmsProvider,
} from '../../src/infra/messaging/messaging';

/** Records outgoing messages so tests can read the OTP that would have been delivered. */
export class CaptureEmail implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  lastCode(): string {
    const m = /OTP is (\d{6})/.exec(this.sent.at(-1)?.text ?? '');
    if (!m?.[1]) throw new Error('no OTP email captured');
    return m[1];
  }
}

export class CaptureSms implements SmsProvider {
  readonly sent: OtpSms[] = [];
  sendOtp(message: OtpSms): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  lastCode(): string {
    const code = this.sent.at(-1)?.code;
    if (!code) throw new Error('no OTP SMS captured');
    return code;
  }
}
