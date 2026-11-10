// Decrypts the database so you can open it locally. Handles split parts and older single files.
// Usage: node scripts/decrypt.mjs <folder>/users.db.age <out-file>
// For split files, keep all parts together and pass the name without the number (no .000).
// Needs LAST_FM_AGE_IDENTITY in the environment. Keep the output outside the repo.
import fs from "node:fs";
import { encryptedDbExists, readEncryptedDb } from "./db-store.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: node scripts/decrypt.mjs <folder>/users.db.age <out-file>");
const identity = process.env.LAST_FM_AGE_IDENTITY?.trim();
if (!identity) throw new Error("LAST_FM_AGE_IDENTITY is not set");
if (!encryptedDbExists(input)) throw new Error(`${input} not found`);

await readEncryptedDb(input, identity, output);
console.log(`Decrypted to ${output}`);
