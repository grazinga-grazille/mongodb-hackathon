// Text -> vector. "local" runs a small open model in-process (no API key);
// "voyage" calls Voyage AI (MongoDB's embedding provider). Switching provider requires `npm run seed`.
import { config } from "../config.js";

const { provider } = config.embedding;
let extractor;

async function embedLocal(texts) {
  if (!extractor) {
    const { pipeline } = await import("@huggingface/transformers");
    extractor = await pipeline("feature-extraction", config.embedding.local.model, { dtype: "fp32" });
  }
  const out = [];
  for (const text of texts) {
    const t = await extractor(text, { pooling: "cls", normalize: true });
    out.push(Array.from(t.data));
  }
  return out;
}

async function embedVoyage(texts, inputType) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
    body: JSON.stringify({
      input: texts,
      model: config.embedding.voyage.model,
      input_type: inputType,
      output_dimension: config.embedding.voyage.dims,
    }),
  });
  if (!res.ok) throw new Error(`Voyage embeddings failed (${res.status}): ${await res.text()}`);
  const { data } = await res.json();
  return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export const embeddingDims = () => config.embedding[provider].dims;

/** Embed one string or an array of strings. inputType: "query" | "document" (used by Voyage). */
export async function embed(input, inputType = "document") {
  const texts = Array.isArray(input) ? input : [input];
  const vectors = provider === "voyage" ? await embedVoyage(texts, inputType) : await embedLocal(texts);
  return Array.isArray(input) ? vectors : vectors[0];
}

/** Cosine similarity for normalized vectors. */
export const cosine = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);

/** Atlas returns (1 + cosine) / 2 for cosine indexes; convert back so thresholds read naturally. */
export const scoreToCosine = (score) => 2 * score - 1;
