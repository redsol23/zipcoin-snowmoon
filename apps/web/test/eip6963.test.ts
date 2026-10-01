import { describe, expect, it, vi } from "vitest";

import { discoverWallets, legacyInjected, parseAnnouncement, safeIcon } from "../src/lib/eip6963";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
const provider = () => ({ request: vi.fn(async () => ["0x0000000000000000000000000000000000000001"]) });
const announce = (t: EventTarget, info: Record<string, unknown>, p: unknown = provider()) =>
  t.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider: p }) }));

describe("EIP-6963 discovery", () => {
  it("asks for providers once on start, and again on request()", () => {
    const t = new EventTarget();
    const asked = vi.fn();
    t.addEventListener("eip6963:requestProvider", asked);
    const d = discoverWallets(t);
    expect(asked).toHaveBeenCalledTimes(1);
    d.request();
    expect(asked).toHaveBeenCalledTimes(2);
    d.stop();
  });

  it("collects announcements in order, one per rdns, and notifies subscribers", () => {
    const t = new EventTarget();
    // A wallet that answers every request, like real extensions do
    t.addEventListener("eip6963:requestProvider", () => announce(t, { uuid: "u-mm", name: "MetaMask", icon: PNG, rdns: "io.metamask" }));
    const d = discoverWallets(t);
    const seen = vi.fn();
    d.subscribe(seen);
    announce(t, { uuid: "u-rabby", name: "Rabby Wallet", icon: SVG, rdns: "io.rabby" });
    expect(d.list().map((w) => w.info.name)).toEqual(["MetaMask", "Rabby Wallet"]);
    expect(seen).toHaveBeenCalledTimes(1);
    // A re-announcement with a new provider replaces the old entry rather than adding one
    announce(t, { uuid: "u-rabby-2", name: "Rabby Wallet", icon: SVG, rdns: "io.rabby" });
    expect(d.list()).toHaveLength(2);
    expect(d.list()[1].info.uuid).toBe("u-rabby-2");
    d.stop();
    announce(t, { uuid: "u-x", name: "Late", icon: PNG, rdns: "com.late" });
    expect(d.list()).toHaveLength(2);
  });

  it("the list is a stable snapshot between changes (for useSyncExternalStore)", () => {
    const t = new EventTarget();
    const d = discoverWallets(t);
    announce(t, { uuid: "a", name: "A", icon: PNG, rdns: "com.a" });
    expect(d.list()).toBe(d.list());
  });

  it("drops malformed announcements", () => {
    expect(parseAnnouncement(null)).toBeNull();
    expect(parseAnnouncement({ info: { uuid: "a", name: "A", rdns: "com.a" } })).toBeNull(); // no provider
    expect(parseAnnouncement({ info: { uuid: "a", name: "A", rdns: "com.a" }, provider: {} })).toBeNull(); // no request()
    expect(parseAnnouncement({ info: { uuid: "a", name: "", rdns: "com.a" }, provider: provider() })).toBeNull();
    expect(parseAnnouncement({ info: { uuid: "a", name: "A", rdns: "not a domain" }, provider: provider() })).toBeNull();
    expect(parseAnnouncement({ info: { name: "A", rdns: "com.a" }, provider: provider() })).toBeNull();
  });

  it("cleans names and keeps only data:image/* icons", () => {
    const w = parseAnnouncement({ info: { uuid: "a", name: "  Wallet\n  X ", rdns: "COM.Example", icon: "https://tracker.example/i.png" }, provider: provider() });
    expect(w?.info).toEqual({ uuid: "a", name: "Wallet X", rdns: "com.example", icon: null });
    expect(safeIcon(PNG)).toBe(PNG);
    expect(safeIcon(SVG)).toBe(SVG);
    expect(safeIcon("data:image/webp;base64,AAAA")).not.toBeNull();
    for (const bad of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "http://x/i.png", "blob:https://x/1", `data:image/png;base64,${"A".repeat(300_000)}`, 42, null]) {
      expect(safeIcon(bad)).toBeNull();
    }
  });

  it("falls back to window.ethereum", () => {
    const eth = provider();
    expect(legacyInjected({ ethereum: eth })).toBe(eth);
    expect(legacyInjected({})).toBeNull();
    expect(legacyInjected({ ethereum: { foo: 1 } })).toBeNull();
    expect(legacyInjected(undefined)).toBeNull();
  });
});
