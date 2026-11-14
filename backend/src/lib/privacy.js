// Privacy helpers: footprints are stored only as keyed hashes; memory text is scrubbed before storage.
import { createHmac } from "node:crypto";
import { config } from "../config.js";

if (!config.footprintSecret) throw new Error("Set FOOTPRINT_SECRET in backend/.env");

const ABBREVIATIONS = [
  [/\bstreet\b/g, "st"],
  [/\bavenue\b/g, "ave"],
  [/\broad\b/g, "rd"],
  [/\b(apartment|unit|suite|ste)\b/g, "apt"],
];

/** "12 Elm Street #4" and "12 Elm St Apt 4" normalize to the same string. */
export function normalizeAddress(address) {
  let a = address.toLowerCase().replace(/#\s*/g, " apt ");
  for (const [re, short] of ABBREVIATIONS) a = a.replace(re, short);
  return a.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Keyed hash so raw addresses/cards never touch the database and can't be brute-forced without the secret. */
export const hashFootprint = (kind, value) =>
  createHmac("sha256", config.footprintSecret).update(`${kind}:${value}`).digest("hex").slice(0, 32);

export const footprintHashes = ({ address, cardFingerprint, deviceId }) => ({
  addressHash: hashFootprint("address", normalizeAddress(address)),
  cardHash: hashFootprint("card", cardFingerprint),
  deviceHash: hashFootprint("device", deviceId),
});

/** Remove card numbers, emails and phone numbers before any text becomes a memory. */
export const scrubText = (text) =>
  text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[card]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
    .trim();
