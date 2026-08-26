import { z } from 'zod';

export const NativeNotificationEventSchema = z.strictObject({
  type: z.literal('notification:received'),
  message: z.string().optional(),
  notificationType: z.string().optional(),
});
export type NativeNotificationEvent = z.infer<typeof NativeNotificationEventSchema>;

export type NotificationEvent = NativeNotificationEvent;
export const NotificationEventSchema = NativeNotificationEventSchema;
