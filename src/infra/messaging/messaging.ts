/** Outbound message ports. Implementations are chosen by env (EMAIL_PROVIDER / SMS_PROVIDER). */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export interface OtpSms {
  /** 10-digit Indian mobile number from KEKA. */
  to: string;
  code: string;
  ttlMinutes: number;
}

export interface SmsProvider {
  sendOtp(message: OtpSms): Promise<void>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
