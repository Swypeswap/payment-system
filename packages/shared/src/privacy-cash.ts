export interface PrivacyCashFeeConfig {
  withdrawFeeRate: number;
  withdrawBaseFeeLamports: number;
}

export interface PrivacyCashWithdrawalPlan {
  recipientKind: `owner_${number}` | "manager";
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

export interface OwnerPrivacyCashWithdrawalPlan {
  recipientKind: `owner_${number}`;
  legIndex: number;
  netLamports: bigint;
  grossLamports: bigint;
  estimatedFeeLamports: bigint;
}

export interface OwnerPrivacyCashDistributionPlan {
  netDistributionLamports: bigint;
  grossDistributionLamports: bigint;
  estimatedFeeLamports: bigint;
  dustLamports: bigint;
  withdrawals: OwnerPrivacyCashWithdrawalPlan[];
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
  recipientLegWeights: number[][] = [[1], [1], [1], [1]],
  ownerPercentages: number[] = [33, 33, 34]
): PrivacyCashDistributionPlan {
  validateFeeConfig(config);
  if (shieldLamports <= 0n) {
    throw new Error("Privacy Cash shield amount must be positive");
  }

  if (
    ownerPercentages.length < 2 ||
    ownerPercentages.length > 5 ||
    ownerPercentages.some((percentage) =>
      !Number.isFinite(percentage) || percentage <= 0 || percentage > 100
    )
  ) {
    throw new Error("Owner payout percentages must contain between two and five positive values");
  }
  const ownerPercentageUnits = ownerPercentages.map((percentage) =>
    Math.round(percentage * 10_000)
  );
  const totalOwnerPercentageUnits = ownerPercentageUnits.reduce(
    (sum, percentage) => sum + percentage,
    0
  );
  if (totalOwnerPercentageUnits !== 1_000_000) {
    throw new Error("Owner payout percentages must total exactly 100%");
  }
  if (
    recipientLegWeights.length !== ownerPercentages.length + 1 ||
    recipientLegWeights.some((weights) =>
      weights.length < 1 ||
      weights.some((weight) => !Number.isSafeInteger(weight) || weight <= 0)
    )
  ) {
    throw new Error("Privacy Cash leg weights must match the owner count plus the manager");
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
    const ownerPoolNet = units * 9n;
    let assignedOwnerNet = 0n;
    const recipients: Array<[PrivacyCashWithdrawalPlan["recipientKind"], bigint]> =
      ownerPercentageUnits.map((percentage, ownerIndex) => {
        const ownerNet =
          ownerIndex === ownerPercentageUnits.length - 1
            ? ownerPoolNet - assignedOwnerNet
            : ownerPoolNet * BigInt(percentage) / BigInt(totalOwnerPercentageUnits);
        assignedOwnerNet += ownerNet;
        return [`owner_${ownerIndex + 1}`, ownerNet];
      });
    recipients.push(["manager", managerNet]);
    return recipients.flatMap(([recipientKind, recipientNetLamports], recipientIndex) =>
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

export function planOwnerPrivacyCashDistribution(
  shieldLamports: bigint,
  config: PrivacyCashFeeConfig,
  recipientPercentages: number[] = [33, 33, 34],
  recipientLegWeights: number[][] = recipientPercentages.map(() => [1])
): OwnerPrivacyCashDistributionPlan {
  validateFeeConfig(config);
  if (shieldLamports <= 0n) {
    throw new Error("Shielded balance must be positive");
  }
  if (
    recipientPercentages.length < 2 ||
    recipientPercentages.length > 5 ||
    recipientPercentages.some((percentage) =>
      !Number.isFinite(percentage) || percentage <= 0 || percentage > 100
    )
  ) {
    throw new Error("Owner payout percentages must contain between two and five positive values");
  }
  const percentageUnits = recipientPercentages.map((percentage) =>
    Math.round(percentage * 10_000)
  );
  const totalPercentageUnits = percentageUnits.reduce((sum, percentage) => sum + percentage, 0);
  if (totalPercentageUnits !== 1_000_000) {
    throw new Error("Owner payout percentages must total exactly 100%");
  }
  if (
    recipientLegWeights.length !== recipientPercentages.length ||
    recipientLegWeights.some((weights) =>
      weights.length < 1 ||
      weights.some((weight) => !Number.isSafeInteger(weight) || weight <= 0)
    )
  ) {
    throw new Error("Owner payout leg weights must match the configured owner count");
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

  const withdrawalsForNetTotal = (netTotal: bigint): OwnerPrivacyCashWithdrawalPlan[] => {
    let assigned = 0n;
    return percentageUnits.flatMap((percentageUnitsForOwner, recipientIndex) => {
      const recipientNetLamports =
        recipientIndex === percentageUnits.length - 1
          ? netTotal - assigned
          : netTotal * BigInt(percentageUnitsForOwner) / BigInt(totalPercentageUnits);
      assigned += recipientNetLamports;
      const recipientKind = `owner_${recipientIndex + 1}` as const;
      return (
      splitByWeights(recipientNetLamports, recipientLegWeights[recipientIndex] ?? []).map(
        (netLamports, legIndex) => {
          const grossLamports = grossUpPrivacyCashWithdrawal(netLamports, config);
          return {
            recipientKind,
            legIndex,
            netLamports,
            grossLamports,
            estimatedFeeLamports: grossLamports - netLamports
          };
        }
      )
      );
    });
  };

  const costForNetTotal = (netTotal: bigint) => {
    try {
      return withdrawalsForNetTotal(netTotal).reduce(
        (total, item) => total + item.grossLamports,
        0n
      );
    } catch {
      return shieldLamports + 1n;
    }
  };

  let low = 0n;
  let high = shieldLamports;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (costForNetTotal(middle) <= shieldLamports) {
      low = middle;
    } else {
      high = middle - 1n;
    }
  }
  if (low === 0n) {
    throw new Error("Shielded balance is too small to cover owner Privacy Cash withdrawals");
  }

  const withdrawals = withdrawalsForNetTotal(low);
  const grossDistributionLamports = withdrawals.reduce(
    (total, item) => total + item.grossLamports,
    0n
  );
  const netDistributionLamports = low;
  return {
    netDistributionLamports,
    grossDistributionLamports,
    estimatedFeeLamports: grossDistributionLamports - netDistributionLamports,
    dustLamports: shieldLamports - grossDistributionLamports,
    withdrawals
  };
}
