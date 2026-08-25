/* =========================================================
   EDGE FUNCTION: tactic-review
   投稿された戦術に対する AI 寸評を返す。
   ---------------------------------------------------------
   必要な環境変数（Supabase のダッシュボードで設定する）:
     ANTHROPIC_API_KEY          Anthropic の API キー
     SUPABASE_URL               プロジェクト URL（自動で入る）
     SUPABASE_SERVICE_ROLE_KEY  サービスロールキー（自動で入る）

   デプロイ:
     supabase functions deploy tactic-review
   ========================================================= */
import Anthropic from "npm:@anthropic-ai/sdk";

/* 1 人あたりの 1 日の生成回数上限。課金額の上限をここで決める。 */
const DAILY_QUOTA_ANON = 3;
const DAILY_QUOTA_USER = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ReviewRequest {
  tactic: { name: string; side: string; site: string; kind: string; note: string };
  map: string;
  side: string;
  allyComp: string[];
  enemyComp: string[];
  lang: string;
  /** クライアント側のルールベース判定。AI にはこれを参考情報として渡す */
  analysis?: { score: number; verdict: string; findings: string[] };
}

const LANG_NAMES: Record<string, string> = {
  ja: "Japanese",
  en: "English",
  ko: "Korean",
  "pt-BR": "Brazilian Portuguese",
  es: "Spanish",
  "zh-TW": "Traditional Chinese",
  fr: "French",
  de: "German",
};

const SYSTEM_PROMPT = `You are a VALORANT coach who analyses round tactics for competitive teams.

You will receive one tactic, the map, the side it is called on, both teams' agent compositions, and a rule-based pre-assessment from the app.

Judge whether the tactic actually works against that specific enemy composition. Be concrete and specific to the agents named — never give generic advice that would apply to any composition. Name the enemy agents whose abilities break the tactic, and name the ally abilities that carry it.

Reply with a single JSON object and nothing else:
{
  "verdict": "strong" | "even" | "weak",
  "score": <integer 0-100>,
  "summary": "<two or three sentences of overall assessment>",
  "strengths": ["<short point>", ...],
  "weaknesses": ["<short point>", ...],
  "counterplay": ["<what the enemy will do to stop it, and the adjustment>", ...]
}

Each array holds one to three short entries. Write every string in the requested language. Do not wrap the JSON in code fences.`;

/* ---------------- 利用回数の記録と確認 ---------------- */
async function checkQuota(actor: string, limit: number): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return true; // 記録先が無いときは素通しする

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const res = await fetch(
    `${url}/rest/v1/ai_usage?select=id&actor=eq.${encodeURIComponent(actor)}&created_at=gt.${since}`,
    { headers: { ...headers, Prefer: "count=exact" } },
  );
  if (!res.ok) return true;
  const rows = await res.json();
  if (Array.isArray(rows) && rows.length >= limit) return false;

  await fetch(`${url}/rest/v1/ai_usage`, {
    method: "POST",
    headers,
    body: JSON.stringify({ actor }),
  });
  return true;
}

/** JWT の sub を取り出す。検証は Supabase 側が済ませている前提の識別用途のみ。 */
function subjectFromJwt(auth: string | null): string | null {
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const parts = auth.slice(7).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

async function hashOf(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/* ---------------- 本体 ---------------- */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "not_configured" }, 503);

  let body: ReviewRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!body?.tactic?.name) return json({ error: "bad_request" }, 400);

  /* 利用者を特定して回数制限をかける */
  const userId = subjectFromJwt(req.headers.get("authorization"));
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const actor = userId ?? `ip:${await hashOf(ip)}`;
  const limit = userId ? DAILY_QUOTA_USER : DAILY_QUOTA_ANON;

  if (!(await checkQuota(actor, limit))) {
    return json({ error: "quota_exceeded", limit }, 429);
  }

  const language = LANG_NAMES[body.lang] ?? "English";
  const userPrompt = [
    `Language for the reply: ${language}`,
    ``,
    `Map: ${body.map}`,
    `Side called on: ${body.side}`,
    `Tactic name: ${body.tactic.name}`,
    `Target: ${body.tactic.site}`,
    `Type: ${body.tactic.kind}`,
    `Call details: ${body.tactic.note || "(none provided)"}`,
    ``,
    `Ally composition: ${body.allyComp.join(", ") || "(not set)"}`,
    `Enemy composition: ${body.enemyComp.join(", ") || "(not set)"}`,
    ``,
    body.analysis
      ? `Rule-based pre-assessment from the app: ${body.analysis.verdict} (${body.analysis.score}/100)\n` +
        body.analysis.findings.map((f) => `- ${f}`).join("\n")
      : `No pre-assessment available.`,
  ].join("\n");

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 2000,
      // 安全性分類器が拒否した場合、同じ呼び出しの中で別モデルに回してもらう
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    // content を読む前に必ず stop_reason を確認する
    if (response.stop_reason === "refusal") {
      return json({ error: "refused" }, 422);
    }

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    const parsed = parseReview(text);
    if (!parsed) return json({ error: "unparseable", raw: text.slice(0, 500) }, 502);

    return json({
      review: parsed,
      model: response.model,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: "upstream_error", message }, 502);
  }
});

/** モデルの応答から JSON を取り出す。コードフェンスが付いた場合にも耐える。 */
function parseReview(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1));
    if (typeof obj !== "object" || obj === null) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}
