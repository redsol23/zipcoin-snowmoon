import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The WalletConnect SDK is mocked: these tests never open a socket
const h = vi.hoisted(() => ({ instances: [] as unknown[], initOpts: [] as unknown[], approve: null as null | ((p: unknown) => unknown), stored: null as unknown }));

vi.mock("@walletconnect/universal-provider", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeProvider extends EventEmitter {
    session: any = h.stored ?? undefined;
    default = "";
    requests: { args: unknown; chain?: string }[] = [];
    static async init(opts: unknown) {
      h.initOpts.push(opts);
      const p = new FakeProvider();
      h.instances.push(p);
      return p;
    }
    async connect(params: any) {
      this.emit("display_uri", "wc:abc@2?relay-protocol=irn&symKey=00");
      this.session = h.approve!(params);
      return this.session;
    }
    setDefaultChain(c: string) {
      this.default = c;
    }
    async request(args: unknown, chain?: string) {
      this.requests.push({ args, chain });
      return "0xsig";
    }
    async disconnect() {
      this.session = undefined;
    }
  }
  return { UniversalProvider: FakeProvider, default: FakeProvider };
});

const ADDR = "0x00000000000000000000000000000000000000aa";
const CFG = { projectId: "0123456789abcdef0123456789abcdef", chains: [{ id: 1, rpcUrl: "https://rpc.public.example" }] };
const session = (chain = 1, redirect?: { native?: string; universal?: string }) => ({
  topic: "t",
  namespaces: { eip155: { accounts: [`eip155:${chain}:${ADDR}`], methods: ["personal_sign"], events: [] } },
  peer: { metadata: { name: "Rainbow", description: "", url: "https://rainbow.me", icons: ["https://rainbow.me/icon.png"], redirect } },
});

const win = { location: { origin: "https://app.zipcoin.org", href: "https://app.zipcoin.org/wallet" }, open: vi.fn() };

beforeEach(() => {
  vi.resetModules();
  h.instances = [];
  h.initOpts = [];
  h.stored = null;
  h.approve = () => session();
  win.open.mockReset();
  win.location.href = "https://app.zipcoin.org/wallet";
  vi.stubGlobal("window", win);
});
afterEach(() => vi.unstubAllGlobals());

const load = () => import("../src/lib/walletconnect");

describe("WalletConnect (mocked provider)", () => {
  it("inits with telemetry off, our metadata and storage prefix", async () => {
    const wc = await load();
    await wc.connect(CFG, () => {}, false);
    expect(h.initOpts[0]).toMatchObject({
      projectId: CFG.projectId,
      telemetryEnabled: false,
      customStoragePrefix: "zipnet",
      metadata: { url: "https://app.zipcoin.org", icons: ["https://app.zipcoin.org/icon.svg"] },
    });
    expect(JSON.stringify(h.initOpts[0])).not.toMatch(/analytics|onramp|swaps|email|social/i);
  });

  it("proposes only our chains, with our RPC, and hands the pairing URI to the page", async () => {
    const wc = await load();
    let proposed: any;
    h.approve = (p) => ((proposed = p), session());
    const onUri = vi.fn();
    const conn = await wc.connect(CFG, onUri, false);
    expect(onUri).toHaveBeenCalledWith(expect.stringMatching(/^wc:/));
    expect(proposed.optionalNamespaces.eip155).toMatchObject({ chains: ["eip155:1"], rpcMap: { "eip155:1": "https://rpc.public.example", "1": "https://rpc.public.example" } });
    expect(proposed.namespaces).toBeUndefined();
    expect(conn).toMatchObject({ account: ADDR, chainId: 1, peerName: "Rainbow" });
    expect((h.instances[0] as any).default).toBe("eip155:1");
  });

  it("requests go to the session's chain", async () => {
    const wc = await load();
    const conn = await wc.connect(CFG, () => {}, false);
    expect(await conn.provider.request({ method: "personal_sign", params: ["0x00", ADDR] })).toBe("0xsig");
    expect((h.instances[0] as any).requests[0]).toEqual({ args: { method: "personal_sign", params: ["0x00", ADDR] }, chain: "eip155:1" });
  });

  it("refuses a session without our chain, and disconnects it", async () => {
    const wc = await load();
    h.approve = () => session(137);
    await expect(wc.connect(CFG, () => {}, false)).rejects.toThrow(/didn't approve chain 1/);
    expect((h.instances[0] as any).session).toBeUndefined();
  });

  it("restores a stored session without prompting, and returns null when there is none", async () => {
    let wc = await load();
    expect(await wc.restore(CFG, false)).toBeNull();
    vi.resetModules();
    h.stored = session();
    wc = await load();
    const conn = await wc.restore(CFG, false);
    expect(conn?.account).toBe(ADDR);
  });

  it("disconnect ends the session; the wallet ending it is reported", async () => {
    const wc = await load();
    const conn = await wc.connect(CFG, () => {}, false);
    const seen = vi.fn();
    conn.onChange(seen);
    const up = h.instances[0] as any;
    up.emit("accountsChanged", ["0x00000000000000000000000000000000000000bb"]);
    expect(seen).toHaveBeenLastCalledWith({ kind: "account", account: "0x00000000000000000000000000000000000000bb" });
    up.emit("session_delete", { topic: "t" });
    expect(seen).toHaveBeenLastCalledWith({ kind: "disconnect" });
    await conn.disconnect();
    expect(up.session).toBeUndefined();
  });

  it("on a phone, a signature request switches to the wallet app by its own scheme", async () => {
    vi.useFakeTimers();
    const wc = await load();
    h.approve = () => session(1, { native: "rainbow://", universal: "https://rnbwapp.com" });
    const conn = await wc.connect(CFG, () => {}, true);
    await conn.provider.request({ method: "personal_sign", params: [] });
    vi.runAllTimers();
    expect(win.location.href).toBe("rainbow://");
    vi.useRealTimers();
  });

  it("wallet-supplied links: https or an app scheme only", async () => {
    const wc = await load();
    expect(wc.safeWalletLink("rainbow://")).toBe("rainbow://");
    expect(wc.safeWalletLink("https://metamask.app.link")).toBe("https://metamask.app.link/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "http://x.example", "blob:x", "file:///etc/passwd", "not a url", 5]) expect(wc.safeWalletLink(bad)).toBeNull();
  });

  it("draws the pairing URI as a square QR matrix, locally", async () => {
    const wc = await load();
    const m = wc.qrMatrix("wc:abc@2?relay-protocol=irn&symKey=" + "0".repeat(64));
    expect(m.length).toBeGreaterThan(20);
    expect(m.every((r) => r.length === m.length)).toBe(true);
    expect(wc.mobileLinks("wc:x")[0]).toEqual({ name: "Open a wallet app", href: "wc:x" });
    expect(wc.mobileLinks("wc:x@2?a=b").slice(1).every((l) => l.href.startsWith("https://") && l.href.endsWith("wc%3Ax%402%3Fa%3Db"))).toBe(true);
  });
});
