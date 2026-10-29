// Suggests gifts for one person on the signed-in user's list.
// The person's details are read with the caller's own token, so row-level
// security decides what this function can see. Needs the GEMINI_API_KEY secret;
// GEMINI_MODEL optionally overrides the model.
import { ApiError, FinishReason, GoogleGenAI } from "npm:@google/genai@2.29.1";
import { clientFor, CORS, json } from "../_shared/http.ts";

const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          why: { type: "string" },
          stores: { type: "array", items: { type: "string" } },
          local_price: { type: "string" },
          price: { type: "number" },
        },
        required: ["title", "why", "stores", "local_price", "price"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
};

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body: { personId?: string; occasion?: string | null; request?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "The request body must be JSON." }, 400);
  }
  if (!body.personId) return json({ error: "Missing personId." }, 400);
  if (!ai) {
    console.error("GEMINI_API_KEY is not set");
    return json({ error: "The suggestion service isn't set up yet." }, 500);
  }

  const supabase = clientFor(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "Sign in to get suggestions." }, 401);

  const [personRes, wishesRes, giftsRes, profileRes] = await Promise.all([
    supabase.from("people").select("*").eq("id", body.personId).maybeSingle(),
    supabase.from("wishlist_items").select("text").eq("person_id", body.personId),
    supabase.from("gifts").select("title, price, status").eq("person_id", body.personId),
    supabase.from("profiles").select("currency, country").eq("id", user.id).maybeSingle(),
  ]);
  const person = personRes.data;
  if (!person) return json({ error: "That person isn't on your list." }, 404);
  if (person.member_id === user.id) return json({ error: "Gift ideas for you are hidden from you." }, 403);

  const currency = profileRes.data?.currency ?? "NOK";
  const country = person.country || profileRes.data?.country || "Norway";
  const gifts = giftsRes.data ?? [];
  const committed = gifts.reduce((sum, g) => sum + Number(g.price || 0), 0);
  const budget = Number(person.budget || 0);

  let occasionLine = "";
  if (body.occasion === "birthday") {
    occasionLine = "These gifts are for their birthday.";
  } else if (body.occasion) {
    const { data: occ } = await supabase.from("occasions").select("name, date").eq("id", body.occasion).maybeSingle();
    if (occ) occasionLine = `These gifts are for ${occ.name} on ${occ.date}. Make them fit that occasion.`;
  }

  const prompt = `You help someone choose gifts. Suggest 6 gift ideas for this person.

Recipient: ${person.name}${person.relation ? ` (the giver's ${person.relation})` : ""}
Lives in: ${country}
What they like / notes: ${person.likes || "(nothing noted)"}
Their wishlist: ${(wishesRes.data ?? []).map((w) => w.text).join("; ") || "(empty)"}
Gifts already planned or given (do not repeat these): ${gifts.map((g) => g.title).join("; ") || "(none)"}
${budget ? `Total budget: ${budget} ${currency}. Remaining after planned gifts: ${budget - committed} ${currency}.` : "No budget set."}
${person.birthday ? `Birthday: ${person.birthday}.` : ""}
${occasionLine}
Today is ${new Date().toISOString().slice(0, 10)}.
Giver's request: ${(body.request ?? "").slice(0, 1000) || "(none)"}

Rules:
- Every item must be easy to buy at common, widely available stores or major online shops that operate in ${country}. Name 1 to 3 real stores or chains that exist in ${country} and plausibly stock it.
- Use the wishlist and their likes as the main signal: items on the wishlist, closely related to it, or that fit their interests. Avoid things the notes say they already have.
- Stay within the remaining budget when there is one, unless the giver's request says otherwise.
- Prices are typical retail prices. local_price is the price in ${country}'s currency with its code (for example "349 SEK"); price is that amount converted to ${currency} as a plain number.`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json", responseJsonSchema: SUGGESTIONS_SCHEMA },
    });

    const finish = response.candidates?.[0]?.finishReason;
    if (response.promptFeedback?.blockReason || finish === FinishReason.SAFETY) {
      return json({ error: "Gemini declined this request. Try rewording what you asked for." }, 422);
    }
    if (finish === FinishReason.MAX_TOKENS) {
      return json({ error: "The suggestions were cut off. Try again." }, 502);
    }
    if (!response.text) return json({ error: "No suggestions came back. Try again." }, 502);
    return json(JSON.parse(response.text));
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 429) {
        return json({ error: "Too many suggestion requests right now. Try again in a minute." }, 429);
      }
      console.error("Gemini API error", err.status, err.message);
      if (err.status === 400 || err.status === 401 || err.status === 403 || err.status === 404) {
        return json({ error: "The suggestion service isn't set up correctly. Check the Gemini API key and model." }, 500);
      }
      return json({ error: "The suggestion service had a problem. Try again." }, 502);
    }
    console.error(err);
    return json({ error: "Something went wrong while getting suggestions." }, 500);
  }
});
