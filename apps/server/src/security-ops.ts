import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { activateFrontendLockdown, redeemSecurityRecoveryCode } from "./security.js";

async function hiddenPrompt(label: string) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Run this command interactively with a TTY");
  }

  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("Cancelled"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
        } else if (byte >= 32 && byte <= 126) {
          value += String.fromCharCode(byte);
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Run this command interactively with: docker compose exec -it server npm --prefix apps/server run security:ops");
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("\nConfetti VPS security operations\n\n");
    stdout.write("1. Redeem a one-time recovery code\n");
    stdout.write("2. Activate complete frontend lockdown\n");
    stdout.write("3. Exit\n\n");
    const choice = (await prompt.question("Choose an operation: ")).trim();

    if (choice === "1") {
      prompt.pause();
      const code = await hiddenPrompt("Paste the one-time recovery code: ");
      const recovery = await redeemSecurityRecoveryCode(code);
      stdout.write(
        recovery.redeemed_action === "frontend_unlock"
          ? "Frontend lockdown revoked. Background services were left running.\n"
          : `Dashboard network block revoked for ${recovery.redeemed_network_key}.\n`
      );
      return;
    }

    if (choice === "2") {
      const confirmation = (await prompt.question(
        "Type LOCKDOWN to disable every frontend page, asset, login, and dashboard API: "
      )).trim();
      if (confirmation !== "LOCKDOWN") {
        stdout.write("Cancelled.\n");
        return;
      }
      const activated = await activateFrontendLockdown(
        "Manually activated from the interactive VPS security command",
        "interactive-vps-security-ops"
      );
      stdout.write(
        activated
          ? "Frontend lockdown activated. The one-time unlock code was sent to the owners security webhook.\n"
          : "Frontend lockdown was already active.\n"
      );
      return;
    }

    if (choice === "3") {
      stdout.write("No changes made.\n");
      return;
    }

    throw new Error("Unknown operation");
  } finally {
    prompt.close();
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
