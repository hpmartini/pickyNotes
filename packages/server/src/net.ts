const v4 = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m || m.slice(1).some((o) => +o > 255)) return null;
  return ((+m[1]! << 24) | (+m[2]! << 16) | (+m[3]! << 8) | +m[4]!) >>> 0;
};

/** IPv4 CIDR / exact-address match. IPv6 only matches exactly or by the Tailscale ULA prefix. */
export function ipMatches(rawIp: string, rule: string): boolean {
  const ip = rawIp.replace(/^::ffff:/i, "");
  const [net, bits] = rule.split("/");
  const a = v4(ip);
  const b = v4(net!);
  if (a === null || b === null) return ip.toLowerCase() === rule.toLowerCase();
  const mask = bits === undefined ? 0xffffffff : bits === "0" ? 0 : (0xffffffff << (32 - +bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export const TAILSCALE_RULES = ["100.64.0.0/10", "fd7a:115c:a1e0::"];
export const isTailscaleOrAllowed = (ip: string | undefined, allow: string[]) =>
  !!ip && ([...TAILSCALE_RULES, ...allow].some((r) => ipMatches(ip, r)) || ip.toLowerCase().startsWith("fd7a:115c:a1e0:"));
