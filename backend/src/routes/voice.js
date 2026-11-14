// Voice: the browser asks for a short-lived signed URL (the API key never leaves the server),
// and after each call sends the conversation id so we can store the transcript.
import { Router } from "express";
import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { days } from "../config.js";
import { httpError, requireString, wrap } from "../lib/http.js";
import { scrubText } from "../lib/privacy.js";
import { audit } from "../lib/audit.js";
import { requireMerchant } from "./tools.js";

const API = "https://api.elevenlabs.io/v1/convai";
const key = () => process.env.ELEVENLABS_API_KEY;
const agentId = () => process.env.ELEVENLABS_AGENT_ID;

async function eleven(path) {
  const res = await fetch(API + path, { headers: { "xi-api-key": key() } });
  if (!res.ok) throw httpError(502, `ElevenLabs ${res.status}: ${await res.text()}`);
  return res.json();
}

export const voice = Router();

voice.get("/config", (_req, res) => res.json({ configured: Boolean(key() && agentId()) }));

voice.get("/signed-url", wrap(async (_req, res) => {
  if (!key() || !agentId()) throw httpError(503, "Voice not configured: set ELEVENLABS_API_KEY and run `npm run agent`");
  const { signed_url } = await eleven(`/conversation/get-signed-url?agent_id=${agentId()}`);
  res.json({ signedUrl: signed_url });
}));

/** Fetch the finished conversation from ElevenLabs (it takes a few seconds to process) and store it. */
async function ingestCall(db, { merchantId, conversationId, claimIds }) {
  let convo;
  for (let i = 0; i < 15; i++) {
    convo = await eleven(`/conversations/${encodeURIComponent(conversationId)}`);
    if (["done", "failed"].includes(convo.status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const ids = claimIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  const firstClaim = ids.length ? await db.collection("claims").findOne({ _id: { $in: ids }, merchantId }) : null;

  await db.collection("calls").updateOne(
    { conversationId },
    {
      $set: {
        merchantId,
        customerId: firstClaim?.customerId ?? null,
        claimIds: ids,
        status: convo?.status ?? "unknown",
        durationSecs: convo?.metadata?.call_duration_secs ?? null,
        summary: convo?.analysis?.transcript_summary ? scrubText(convo.analysis.transcript_summary) : null,
        transcript: (convo?.transcript ?? [])
          .filter((t) => t.message)
          .map((t) => ({ role: t.role, text: scrubText(t.message), at: t.time_in_call_secs })),
        expiresAt: days(30),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  await audit(db, "call.stored", { merchantId, conversationId, claims: ids.length });
}

voice.post("/calls", requireMerchant, wrap(async (req, res) => {
  const conversationId = requireString(req.body?.conversationId, "conversationId", { max: 128 });
  const claimIds = Array.isArray(req.body?.claimIds) ? req.body.claimIds.slice(0, 10).map(String) : [];
  // Respond now; ingestion finishes in the background and the dashboard updates via the change stream.
  ingestCall(getDb(), { merchantId: req.merchantId, conversationId, claimIds }).catch((e) => console.error("ingestCall:", e.message));
  res.status(202).json({ accepted: true });
}));
