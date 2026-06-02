export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const PAYOUT_FEE_BUFFER_LAMPORTS = 10_000;

export const NOTIFICATION_KINDS = [
  "website_request",
  "website_activation",
  "deposit",
  "payout",
  "security_alert",
  "worker_error",
  "revenue_deposit_received",
  "revenue_swap_completed",
  "revenue_split_completed",
  "unsafe_spl_detected",
  "awaiting_sol_for_fees",
  "performer_configuration_invalid",
  "swap_failed",
  "company_threshold_reached",
  "company_privacy_cash_deposited",
  "company_privacy_cash_payout_released",
  "company_wallet_rotation_due",
  "company_wallet_rotated",
  "company_wallet_generation_failed",
  "retired_revenue_wallet_deletion_due",
  "retired_revenue_wallet_deleted",
  "retired_revenue_wallet_deletion_expired",
  "erased_revenue_wallet_received_funds",
  "archived_company_wallet_deletion_due",
  "archived_company_wallet_deleted",
  "archived_company_wallet_deletion_expired"
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const CONFETTI_WEBHOOK_AVATAR_URL = "https://files.catbox.moe/kxol69.png";

export const CONFETTI_WEBHOOK_NAMES: Record<NotificationKind, string> = {
  website_request: "Confetti Website Request",
  website_activation: "Confetti Website Activated",
  deposit: "Confetti Deposit",
  payout: "Confetti Payout",
  security_alert: "Confetti Security Alert",
  worker_error: "Confetti Worker Error",
  revenue_deposit_received: "Confetti Revenue Deposit",
  revenue_swap_completed: "Confetti Revenue Swap",
  revenue_split_completed: "Confetti Revenue Split",
  unsafe_spl_detected: "Confetti Unsafe Token Alert",
  awaiting_sol_for_fees: "Confetti Fee Balance Alert",
  performer_configuration_invalid: "Confetti Performer Alert",
  swap_failed: "Confetti Swap Failure",
  company_threshold_reached: "Confetti Company Threshold",
  company_privacy_cash_deposited: "Confetti Privacy Cash Deposit",
  company_privacy_cash_payout_released: "Confetti Owner Payout",
  company_wallet_rotation_due: "Confetti Company Rotation",
  company_wallet_rotated: "Confetti Company Wallet Rotated",
  company_wallet_generation_failed: "Confetti Company Wallet Failure",
  retired_revenue_wallet_deletion_due: "Confetti Revenue Wallet Deletion",
  retired_revenue_wallet_deleted: "Confetti Revenue Wallet Deleted",
  retired_revenue_wallet_deletion_expired: "Confetti Revenue Wallet Deletion Expired",
  erased_revenue_wallet_received_funds: "Confetti Irrecoverable Funds Alert",
  archived_company_wallet_deletion_due: "Confetti Company Wallet Deletion",
  archived_company_wallet_deleted: "Confetti Company Wallet Deleted",
  archived_company_wallet_deletion_expired: "Confetti Company Wallet Deletion Expired"
};
