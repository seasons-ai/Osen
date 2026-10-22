// Test encoders for single-byte code pages, built by inverting the platform decoder.
function table(label: string): Map<string, number> {
  const bytes = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);
  const chars = [...new TextDecoder(label).decode(bytes)];
  return new Map(chars.map((c, i) => [c, 0x80 + i]));
}
const T1251 = table("windows-1251");
const TKOI8 = table("koi8-r");

function encode(t: Map<string, number>, s: string): Buffer {
  return Buffer.from([...s].map((c) => {
    if (c.charCodeAt(0) < 0x80) return c.charCodeAt(0);
    const b = t.get(c);
    if (b === undefined) throw new Error(`not encodable: ${c}`);
    return b;
  }));
}
export const enc1251 = (s: string): Buffer => encode(T1251, s);
export const encKoi8r = (s: string): Buffer => encode(TKOI8, s);
export const utf16le = (s: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
export const utf16be = (s: string): Buffer => {
  const le = Buffer.from(s, "utf16le");
  le.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
};
