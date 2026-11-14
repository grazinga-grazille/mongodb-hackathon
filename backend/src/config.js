// Central settings. Everything tunable lives here so the demo can be iterated without code hunts.
const num = (v, fallback) => (v === undefined || v === "" ? fallback : Number(v));

const provider = process.env.EMBEDDING_PROVIDER || (process.env.VOYAGE_API_KEY ? "voyage" : "local");

export const config = {
  port: num(process.env.PORT, 3000),

  embedding: {
    provider, // "local" | "voyage"
    local: { model: "Xenova/bge-small-en-v1.5", dims: 384 },
    voyage: { model: process.env.VOYAGE_MODEL || "voyage-3.5-lite", dims: 1024 },
  },

  footprintSecret: process.env.FOOTPRINT_SECRET,

  // Cosine similarity thresholds (tuned for bge-small; re-tune if the provider changes).
  match: {
    script: num(process.env.MATCH_SCRIPT_COSINE, 0.78), // claim sounds like a known scam script
    probe: num(process.env.MATCH_PROBE_COSINE, 0.75), // question sounds like policy probing
    duplicate: 0.9, // new script is a near-duplicate -> reinforce the existing memory instead
    story: num(process.env.MATCH_STORY_COSINE, 0.75), // same story as an account sharing address/card/device
    storyStrong: num(process.env.MATCH_STORY_STRONG_COSINE, 0.82), // close enough to match even if claim types differ
  },

  // Risk scoring: hard stops always DECLINE; otherwise score >= escalateAt -> ESCALATE.
  risk: {
    escalateAt: 3,
    weights: {
      script_match: 2,
      policy_probing: 1,
      delivery_contradiction: 2,
      repeat_claims: 1,
      linked_to_escalated: 2,
      linked_to_confirmed_scam: 3,
      same_story_linked_account: 3,
    },
  },

  windowsDays: { repeatClaims: 90, linkedClaims: 180 },

  // How long each memory type lives (TTL). "Seen again" resets the clock.
  ttlDays: { scam_script: 90, probe_phrase: 90, suspect_account: 180, cleared_customer: 180, claim_story: 90 },

  enableGenericApi: process.env.ENABLE_GENERIC_API === "true",

  // DEMO ONLY: customers who are always flagged and sent to a specialist, whatever they say.
  // Chris is the second caller in the live demo. Set DEMO_FORCE_ESCALATE="" to turn this off.
  demoForceEscalate: (process.env.DEMO_FORCE_ESCALATE ?? "cus_chris").split(",").map((s) => s.trim()).filter(Boolean),
};

export const days = (n) => new Date(Date.now() + n * 86_400_000);
export const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
