export type RenewalNotificationKind = "sign_in_required";

export interface RenewalNotification {
  title: string;
  body: string;
}

export interface RenewalNotificationSender {
  send(notification: RenewalNotification): Promise<void>;
}

export const RENEWAL_NOTIFICATIONS: Record<RenewalNotificationKind, RenewalNotification> = {
  sign_in_required: {
    title: "Moodle MCP needs sign-in",
    body: "Your Moodle session expired. Run `moodle mcp login` to restore remote access.",
  },
};

export async function sendRenewalNotification(
  kind: RenewalNotificationKind,
  sender: RenewalNotificationSender,
): Promise<void> {
  await sender.send({ ...RENEWAL_NOTIFICATIONS[kind] });
}
