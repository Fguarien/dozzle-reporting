import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { clientIp, configFromEnv, hashBreakglass, inCidrs, Limiter, parseCidrs, sign, unsign, verifyBreakglass } from "../src/auth/oidc-gate.ts";

const req = (peer: string, xff?: string) => ({ socket: { remoteAddress: peer }, headers: xff ? { "x-forwarded-for": xff } : {} }) as unknown as IncomingMessage;

describe("CIDR", () => {
  const tail = parseCidrs("100.64.0.0/10");
  it("matches the tailnet and nothing else", () => {
    expect(inCidrs("100.64.0.7", tail)).toBe(true);
    expect(inCidrs("100.127.255.255", tail)).toBe(true);
    expect(inCidrs("100.128.0.1", tail)).toBe(false);
    expect(inCidrs("10.234.1.185", tail)).toBe(false);
    expect(inCidrs("::ffff:100.64.0.7", tail)).toBe(true);
  });
  it("handles IPv6", () => {
    expect(inCidrs("::1", parseCidrs("::1/128"))).toBe(true);
    expect(inCidrs("fd7a:115c:a1e0::5", parseCidrs("fd7a:115c:a1e0::/48"))).toBe(true);
  });
});

describe("clientIp", () => {
  const trusted = parseCidrs("127.0.0.1/32,172.18.255.250/32");
  it("ignores X-Forwarded-For from an untrusted peer (no spoofing from the Docker network)", () => {
    expect(clientIp(req("172.18.0.9", "100.64.0.7"), trusted)).toBe("172.18.0.9");
  });
  it("believes X-Forwarded-For from a trusted proxy", () => {
    expect(clientIp(req("172.18.255.250", "100.64.0.7"), trusted)).toBe("100.64.0.7");
  });
  it("takes the right-most untrusted hop", () => {
    expect(clientIp(req("172.18.255.250", "100.64.0.7, 1.2.3.4"), trusted)).toBe("1.2.3.4");
  });
});

describe("signed cookies", () => {
  const s = "x".repeat(40);
  it("round-trips and rejects tampering", () => {
    const v = sign(s, { a: 1 });
    expect(unsign(s, v)).toEqual({ a: 1 });
    expect(unsign(s, v.replace(/^./, "A"))).toBeUndefined();
    expect(unsign("y".repeat(40), v)).toBeUndefined();
  });
});

describe("break-glass hash", () => {
  it("verifies a hash made by the Python oidc_gate (same format)", async () => {
    const py = "scrypt:32768:8:1:MDEyMzQ1Njc4OWFiY2RlZg:rgbbbMn1rmpqmC_IA82fj8cpYpE2U__nbwWT7R3f0GU";
    expect(await verifyBreakglass("jetable-test", py)).toBe(true);
    expect(await verifyBreakglass("wrong", py)).toBe(false);
  });
  it("round-trips its own hash", async () => {
    const h = await hashBreakglass("abc", 2 ** 10);
    expect(await verifyBreakglass("abc", h)).toBe(true);
  });
});

describe("Limiter", () => {
  it("5 per IP, 20 total, per 15 min", () => {
    const l = new Limiter();
    for (let i = 0; i < 5; i++) l.fail("a", 0);
    expect(l.blocked("a", 1)).toBe(true);
    expect(l.blocked("b", 1)).toBe(false);
    expect(l.blocked("a", 900_001)).toBe(false);
  });
});

describe("configFromEnv", () => {
  it("refuses a break-glass CIDR that covers a forbidden address (WAN edge)", () => {
    Object.assign(process.env, {
      OIDC_ISSUER: "https://idp.example/app/",
      OIDC_CLIENT_ID: "id",
      OIDC_CLIENT_SECRET: "s",
      SESSION_SECRET: "z".repeat(40),
      OIDC_BREAKGLASS_CIDRS: "10.0.0.0/8",
      OIDC_BREAKGLASS_FORBIDDEN_IPS: "10.234.1.185",
    });
    expect(() => configFromEnv("https://x", "/r")).toThrow(/covers 10.234.1.185/);
    process.env["OIDC_BREAKGLASS_CIDRS"] = "100.64.0.0/10";
    expect(configFromEnv("https://x", "/r")?.breakglass.cidrs.length).toBe(1);
    for (const k of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "SESSION_SECRET", "OIDC_BREAKGLASS_CIDRS", "OIDC_BREAKGLASS_FORBIDDEN_IPS"]) delete process.env[k];
  });
});
