import fs from "node:fs";
import path from "node:path";
import { formatEther, parseAbiItem, type Address } from "viem";

import { cfg, pub } from "./config";

/**
 * Doorstep notifications (Snowmoon ch. 20: "Her watch buzzed. She got a notification: 50 zipcoins have just been
 * burned. 🔥"). People subscribe an address to a Telegram chat or a webhook; when someone knocks at that door the
 * courier pushes it. Subscriptions live with the courier the user chose, never on-chain.
 */

type Sub = { address: string; telegramChatId?: string; webhook?: string };
const FILE = path.join(cfg.dataDir, "subscriptions.json");
const subs: Sub[] = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : [];

export function subscribe(s: Sub) {
  const address = s.address.toLowerCase();
  const i = subs.findIndex((x) => x.address === address && x.telegramChatId === s.telegramChatId && x.webhook === s.webhook);
  if (i < 0) subs.push({ ...s, address });
  fs.writeFileSync(FILE, JSON.stringify(subs));
}

async function push(sub: Sub, text: string, payload: unknown) {
  if (sub.telegramChatId && cfg.telegramToken) {
    await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: sub.telegramChatId, text }),
    }).catch(() => undefined);
  }
  if (sub.webhook) {
    await fetch(sub.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => undefined);
  }
}

const knocked = parseAbiItem(
  "event Knocked(address indexed door, address indexed knocker, uint256 nullifierHash, uint256 burned, uint256 gift, uint256 fee, string message)",
);

export function startNotify() {
  pub.watchEvent({
    address: cfg.dep.doorstep,
    event: knocked,
    onLogs: async (logs) => {
      for (const l of logs) {
        const door = (l.args.door as Address).toLowerCase();
        const who = l.args.knocker === "0x0000000000000000000000000000000000000000" ? "Someone anonymous" : l.args.knocker;
        const gift = l.args.gift ? ` and left a gift of ${formatEther(l.args.gift)} ZC` : "";
        const text = `🔥 ${who} burned ${formatEther(l.args.burned!)} zipcoins at your door${gift}.\n\n${l.args.message ?? ""}`;
        for (const s of subs.filter((x) => x.address === door)) {
          await push(s, text, { type: "knock", door, burned: String(l.args.burned), gift: String(l.args.gift), message: l.args.message, tx: l.transactionHash });
        }
      }
    },
  });
}
