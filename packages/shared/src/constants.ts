export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const PAYOUT_FEE_BUFFER_LAMPORTS = 10_000;

export const NOTIFICATION_KINDS = [
  "website_request",
  "website_activation",
  "deposit",
  "payout",
  "security_alert",
  "worker_error"
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
