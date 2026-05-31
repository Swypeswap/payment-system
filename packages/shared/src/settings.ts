export interface GlobalSettings {
  global_threshold_usd: number | string;
  global_manager_percent: number | string;
  global_company_percent: number | string;
  global_sol_reserve: number | string;
  privacy_cash_enabled: boolean;
  privacy_min_delay_hours: number | string;
  privacy_max_delay_hours: number | string;
  min_swap_usd: number | string;
  max_price_impact_pct: number | string;
  min_organic_score: number | string;
  swaps_enabled: boolean;
  live_payouts_enabled: boolean;
  emergency_paused: boolean;
}

export interface WebsiteOverrides {
  threshold_usd: number | string | null;
  manager_percent: number | string | null;
  company_percent: number | string | null;
  sol_reserve: number | string | null;
}

export interface EffectiveWebsiteSettings {
  thresholdUsd: number;
  managerPercent: number;
  companyPercent: number;
  solReserve: number;
  privacyCashEnabled: boolean;
  privacyMinDelayHours: number;
  privacyMaxDelayHours: number;
  minSwapUsd: number;
  maxPriceImpactPct: number;
  minOrganicScore: number;
  swapsEnabled: boolean;
  livePayoutsEnabled: boolean;
  emergencyPaused: boolean;
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric setting: ${String(value)}`);
  }
  return parsed;
}

export function effectiveWebsiteSettings(
  global: GlobalSettings,
  website: WebsiteOverrides
): EffectiveWebsiteSettings {
  const managerPercent = numberValue(
    website.manager_percent ?? global.global_manager_percent
  );
  const companyPercent = numberValue(
    website.company_percent ?? global.global_company_percent
  );
  if (Math.abs(managerPercent + companyPercent - 100) > 0.000001) {
    throw new Error("Manager and company payout percentages must add up to 100");
  }

  const privacyMinDelayHours = numberValue(global.privacy_min_delay_hours);
  const privacyMaxDelayHours = numberValue(global.privacy_max_delay_hours);
  if (privacyMinDelayHours < 24 || privacyMaxDelayHours < privacyMinDelayHours) {
    throw new Error("Privacy Cash payout delay must be at least 24 hours with a valid range");
  }

  return {
    thresholdUsd: numberValue(website.threshold_usd ?? global.global_threshold_usd),
    managerPercent,
    companyPercent,
    solReserve: numberValue(website.sol_reserve ?? global.global_sol_reserve),
    privacyCashEnabled: global.privacy_cash_enabled,
    privacyMinDelayHours,
    privacyMaxDelayHours,
    minSwapUsd: numberValue(global.min_swap_usd),
    maxPriceImpactPct: numberValue(global.max_price_impact_pct),
    minOrganicScore: numberValue(global.min_organic_score),
    swapsEnabled: global.swaps_enabled,
    livePayoutsEnabled: global.live_payouts_enabled,
    emergencyPaused: global.emergency_paused
  };
}
