import { BlockList, isIP } from "node:net";

/** Non-public ranges: [network address, prefix length, family]. */
export const NON_PUBLIC_RANGES: readonly (readonly [string, number, "ipv4" | "ipv6"])[] = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["::ffff:0:0", 96, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["fec0::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
];

// The lists are separate: IPv4 in a BlockList matches ::ffff:0:0/96, and otherwise all IPv4 addresses would become non-public.
const lists = { ipv4: new BlockList(), ipv6: new BlockList() };
for (const [net, prefix, family] of NON_PUBLIC_RANGES) lists[family].addSubnet(net, prefix, family);

export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 0 || address.includes("%")) return false; // interface zone: BlockList silently drops it
  return !lists[v === 4 ? "ipv4" : "ipv6"].check(address, v === 4 ? "ipv4" : "ipv6");
}
