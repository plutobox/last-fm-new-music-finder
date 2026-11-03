// Generates an age (X25519) identity and writes it to a file. Prints ONLY the public key.
// Usage: node scripts/gen-age-key.mjs <output-file>
import fs from "node:fs";
import { generateIdentity, identityToRecipient } from "age-encryption";

const out = process.argv[2];
if (!out) throw new Error("usage: node gen-age-key.mjs <output-file>");
if (fs.existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite`);

const identity = await generateIdentity();
fs.writeFileSync(out, identity + "\n", { mode: 0o600 });
console.log("Private key written to", out);
console.log("Public key:", await identityToRecipient(identity));
