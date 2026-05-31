export interface PrivacyCashFeeConfig {
  withdrawFeeRate: number;
  withdrawBaseFeeLamports: number;
}

export interface PrivacyCashWithdrawalPlan {
  recipientKind: "owner_1" | "owner_2" | "owner_3" | "manager";
  legIndex: number;
  netLamports: bigint;
  grossLamports: bigint;
  estimatedFeeLamports: bigint;
}

export interface PrivacyCashDistributionPlan {
  netDistributionLamports: bigint;
  grossDistributionLamports: bigint;
  estimatedFeeLamports: bigint;
  dustLamports: bigint;
  withdrawals: PrivacyCashWithdrawalPlan[];
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Lamport amount exceeds JavaScript safe integer range");
  }
  return Number(value);
}

function validateFeeConfig(config: PrivacyCashFeeConfig) {
  if (
    !Number.isFinite(config.withdrawFeeRate) ||
    config.withdrawFeeRate < 0 ||
    config.withdrawFeeRate >= 1
  ) {
    throw new Error("Privacy Cash withdrawal fee rate must be between 0 and 1");
  }
  if (
    !Number.isSafeInteger(config.withdrawBaseFeeLamports) ||
    config.withdrawBaseFeeLamports < 0
  ) {
    throw new Error("Privacy Cash withdrawal base fee must be a non-negative integer");
  }
}

export function privacyCashNetFromGross(
  grossLamports: bigint,
  config: PrivacyCashFeeConfig
): bigint {
  validateFeeConfig(config);
  const gross = safeNumber(grossLamports);
  const fee = Math.floor(gross * config.withdrawFeeRate + config.withdrawBaseFeeLamports);
  return BigInt(gross - fee);
}

export function grossUpPrivacyCashWithdrawal(
  netLamports: bigint,
  config: PrivacyCashFeeConfig
): bigint {
  validateFeeConfig(config);
  if (netLamports <= 0n) {
    throw new Error("Privacy Cash withdrawal net amount must be positive");
  }
  const net = safeNumber(netLamports);
  let gross = Math.ceil(
    (net + config.withdrawBaseFeeLamports) / (1 - config.withdrawFeeRate)
  );
  while (privacyCashNetFromGross(BigInt(gross), config) < netLamports) gross += 1;
  while (gross > 1 && privacyCashNetFromGross(BigInt(gross - 1), config) >= netLamports) {
    gross -= 1;
  }
  if (privacyCashNetFromGross(BigInt(gross), config) !== netLamports) {
    throw new Error("Could not calculate an exact Privacy Cash net withdrawal");
  }
  return BigInt(gross);
}

export function planPrivacyCashDistribution(
  shieldLamports: bigint,
  config: PrivacyCashFeeConfig,
  recipientLegWeights: number[][] = [[1], [1], [1], [1]]
): PrivacyCashDistributionPlan {
  validateFeeConfig(config);
  if (shieldLamports <= 0n) {
    throw new Error("Privacy Cash shield amount must be positive");
  }

  if (
    recipientLegWeights.length !== 4 ||
    recipientLegWeights.some((weights) =>
      weights.length < 1 ||
      weights.some((weight) => !Number.isSafeInteger(weight) || weight <= 0)
    )
  ) {
    throw new Error("Privacy Cash recipient leg weights must contain four positive integer groups");
  }

  const splitByWeights = (total: bigint, weights: number[]) => {
    const totalWeight = BigInt(weights.reduce((sum, weight) => sum + weight, 0));
    let assigned = 0n;
    return weights.map((weight, index) => {
      const value =
        index === weights.length - 1
          ? total - assigned
          : total * BigInt(weight) / totalWeight;
      assigned += value;
      return value;
    });
  };

  const withdrawalsForUnits = (units: bigint): PrivacyCashWithdrawalPlan[] => {
    const managerNet = units;
    const ownerNet = units * 3n;
    return ([
      ["owner_1", ownerNet],
      ["owner_2", ownerNet],
      ["owner_3", ownerNet],
      ["manager", managerNet]
    ] as const).flatMap(([recipientKind, recipientNetLamports], recipientIndex) =>
      splitByWeights(recipientNetLamports, recipientLegWeights[recipientIndex] ?? []).map(
        (netLamports, legIndex) => {
      const grossLamports = grossUpPrivacyCashWithdrawal(netLamports as bigint, config);
      return {
        recipientKind,
        legIndex,
        netLamports: netLamports as bigint,
        grossLamports,
        estimatedFeeLamports: grossLamports - (netLamports as bigint)
      };
        }
      )
    );
  };

  const costForUnits = (units: bigint) =>
    withdrawalsForUnits(units).reduce((total, item) => total + item.grossLamports, 0n);

  let low = 0n;
  let high = shieldLamports / 10n;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (costForUnits(middle) <= shieldLamports) {
      low = middle;
    } else {
      high = middle - 1n;
    }
  }
  if (low === 0n) {
    throw new Error("Shielded balance is too small to cover four Privacy Cash withdrawals");
  }

  const withdrawals = withdrawalsForUnits(low);
  const grossDistributionLamports = withdrawals.reduce(
    (total, item) => total + item.grossLamports,
    0n
  );
  const netDistributionLamports = low * 10n;
  return {
    netDistributionLamports,
    grossDistributionLamports,
    estimatedFeeLamports: grossDistributionLamports - netDistributionLamports,
    dustLamports: shieldLamports - grossDistributionLamports,
    withdrawals
  };
}
