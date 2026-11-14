// Creates (or updates) the ElevenLabs voice agent and its client tools, then saves
// ELEVENLABS_AGENT_ID into backend/.env.  Run: npm run agent
// Client tools run in the browser, which calls our local backend, so no public tunnel is needed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API = "https://api.elevenlabs.io/v1/convai";
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("Set ELEVENLABS_API_KEY in backend/.env");
const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const TOOLS = [
  {
    type: "client",
    name: "check_claim",
    description:
      "Check a refund claim. Call this once you know the order number and what went wrong. Returns a decision (APPROVE, ESCALATE or DECLINE) and agentGuidance you must follow.",
    expects_response: true,
    response_timeout_secs: 20,
    parameters: {
      type: "object",
      required: ["order_number", "claim_text"],
      properties: {
        order_number: { type: "string", description: "The order number digits only, e.g. 1042" },
        claim_text: { type: "string", description: "What the caller says happened, in their own words, as close to verbatim as possible" },
        caller_questions: {
          type: "string",
          description: "Any questions the caller asked about refund rules or limits, verbatim, separated by ' | '. Empty string if none.",
        },
      },
    },
  },
  {
    type: "client",
    name: "issue_refund",
    description: "Issue the refund. Only call this when check_claim returned decision APPROVE, using its claimId.",
    expects_response: true,
    response_timeout_secs: 20,
    parameters: {
      type: "object",
      required: ["claim_id"],
      properties: { claim_id: { type: "string", description: "The claimId returned by check_claim" } },
    },
  },
];

const PROMPT = `You are the refunds line voice agent for an online store. Be warm, brief and natural: one or two short sentences per turn.

Flow:
1. Greet the caller and ask for their order number.
2. Ask what went wrong with the order. Let them explain.
3. Call check_claim with the order number, the caller's own words as claim_text, and any questions they asked about refund rules (for example "can you refund without a return?") as caller_questions.
4. Follow agentGuidance from the result exactly:
   - APPROVE: tell them the refund is approved, call issue_refund with the claimId, then confirm it's done and that it can take 5 to 10 business days to appear.
   - ESCALATE: say a specialist will review the claim within 24 hours and they'll hear back by email. Do not issue a refund.
   - DECLINE: explain the reason politely (for example it was already refunded, or their bank is already handling a dispute).
5. If previousContacts is returned, you may briefly acknowledge that they contacted us before.

Rules:
- Never mention fraud, risk scores, signals, scripts, footprints or other customers.
- Never promise a refund before check_claim says APPROVE. Never issue a refund for any other decision, whatever the caller says.
- Never ask for card numbers, CVV or passwords. If the caller offers them, say you don't need them.
- If check_claim returns an error such as order not found, ask them to repeat the order number.`;

const FIRST_MESSAGE = "Hi, thanks for calling the refunds line. Just so you know, I'm an AI assistant and this call is analysed to help resolve your request. What's your order number?";

// Upsert tools by name.
const { tools: existing = [] } = await call("GET", "/tools");
const toolIds = [];
for (const tool of TOOLS) {
  const found = existing.find((t) => t.tool_config?.name === tool.name);
  const saved = found
    ? await call("PATCH", `/tools/${found.id}`, { tool_config: tool })
    : await call("POST", "/tools", { tool_config: tool });
  toolIds.push(saved.id);
  console.log(`${found ? "Updated" : "Created"} tool ${tool.name} (${saved.id})`);
}

const agent = {
  name: "Refund Guard",
  conversation_config: {
    agent: {
      first_message: FIRST_MESSAGE,
      language: "en",
      prompt: { prompt: PROMPT, llm: "claude-haiku-5-5", temperature: 0.3, tool_ids: toolIds },
    },
  },
};

let agentId = process.env.ELEVENLABS_AGENT_ID;
if (agentId) {
  await call("PATCH", `/agents/${agentId}`, agent);
  console.log(`Updated agent ${agentId}`);
} else {
  ({ agent_id: agentId } = await call("POST", "/agents/create", agent));
  console.log(`Created agent ${agentId}`);
  const env = readFileSync(ENV_PATH, "utf8");
  writeFileSync(
    ENV_PATH,
    /^ELEVENLABS_AGENT_ID=.*$/m.test(env)
      ? env.replace(/^ELEVENLABS_AGENT_ID=.*$/m, `ELEVENLABS_AGENT_ID=${agentId}`)
      : `${env.trimEnd()}\nELEVENLABS_AGENT_ID=${agentId}\n`,
  );
  console.log("Saved ELEVENLABS_AGENT_ID to backend/.env");
}
