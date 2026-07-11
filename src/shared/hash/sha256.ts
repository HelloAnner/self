export function sha256Text(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}
