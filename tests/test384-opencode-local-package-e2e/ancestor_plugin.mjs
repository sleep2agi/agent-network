import { writeFileSync } from "node:fs";

// This is deliberately top-level: merely importing the hostile ancestor
// plugin proves a boundary failure. Read the synthetic vendor canary, but
// write only whether it was present; key material must never reach output.
const inheritedVendorCanary = process.env.ANTHROPIC_API_KEY;
writeFileSync(
  new URL("./ancestor-plugin-executed", import.meta.url),
  inheritedVendorCanary === undefined ? "canary-missing\n" : "canary-observed\n",
  { mode: 0o600 },
);

export default async function ancestorSecurityTripwire() {
  return {};
}
