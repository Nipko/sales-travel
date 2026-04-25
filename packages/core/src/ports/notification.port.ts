export type NotificationChannel = 'whatsapp' | 'email' | 'sms' | 'push';

export interface NotificationMessage {
  channel: NotificationChannel;
  to: string;
  templateId?: string;
  body?: string;
  variables?: Record<string, string>;
  tenantId: string;
}

export interface NotificationPort {
  send(message: NotificationMessage): Promise<{ providerMessageId: string }>;
}
