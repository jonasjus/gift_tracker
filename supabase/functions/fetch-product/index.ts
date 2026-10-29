// Reads a product page and returns its name, price, currency, image and store.
// Uses the page's structured data (JSON-LD, Open Graph) first and asks Gemini
// to read the page text only when the name or price is missing.
import { GoogleGenAI } from "npm:@google/genai@2.29.1";
import { clientFor, CORS, json } from "../_shared/http.ts";
import { clean, extract, pageText, type Product } from "./parse.ts";

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

class UserFacingError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// ---------- refusing internal addresses ----------
function isPrivateIPv4(ip: string) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
function isPrivateIPv6(ip: string) {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "::") return true;
  if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return true;
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}
async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UserFacingError("That doesn't look like a link. Paste the full address, starting with https://", 400); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UserFacingError("Only http and https links work.", 400);
  if (u.username || u.password) throw new UserFacingError("Links with a username or password aren't supported.", 400);
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host) || !host.includes(".")) {
    throw new UserFacingError("That link points to a private address.", 400);
  }
  if (isPrivateIPv4(host) || (host.includes(":") && isPrivateIPv6(host))) {
    throw new UserFacingError("That link points to a private address.", 400);
  }
  // Where the runtime allows DNS lookups, also refuse names that resolve to private addresses.
  try {
    const [v4, v6] = await Promise.all([
      Deno.resolveDns(host, "A").catch(() => [] as string[]),
      Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
    ]);
    if (v4.some(isPrivateIPv4) || v6.some(isPrivateIPv6)) throw new UserFacingError("That link points to a private address.", 400);
  } catch (e) {
    if (e instanceof UserFacingError) throw e;
  }
  return u;
}

// ---------- fetching ----------
async function fetchPage(start: URL): Promise<{ html: string; url: URL }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "nb-NO,nb;q=0.9,sv;q=0.8,da;q=0.8,en;q=0.7",
        },
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") throw new UserFacingError("The store took too long to answer. Try again, or add the item by hand.", 504);
      throw new UserFacingError("Couldn't reach that page. Check the link.", 502);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      await res.body?.cancel();
      throw new UserFacingError("The store blocked automatic reading of that page. Add the item by hand instead.", 422);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UserFacingError(`The store answered with an error (${res.status}). Check the link.`, 422);
    }
    const type = res.headers.get("content-type") || "";
    if (!/html|xml/i.test(type)) {
      await res.body?.cancel();
      throw new UserFacingError("That link isn't a web page.", 422);
    }
    return { html: await readLimited(res), url };
  }
  throw new UserFacingError("That link redirects too many times.", 422);
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  const buf = new Uint8Array(Math.min(size, MAX_BYTES));
  let off = 0;
  for (const c of chunks) { const n = Math.min(c.length, buf.length - off); buf.set(c.subarray(0, n), off); off += n; if (off >= buf.length) break; }
  return new TextDecoder().decode(buf);
}

const FALLBACK_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    price: { anyOf: [{ type: "number" }, { type: "null" }] },
    currency: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["title", "price", "currency"],
  additionalProperties: false,
};

async function geminiFill(product: Product, html: string): Promise<Product> {
  if (!ai) return product;
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: `This is the text of a product page from ${product.url}.
Return the product's name, its current selling price as a number, and the ISO 4217 currency code of that price.
Use null for anything the page doesn't state. Don't guess a price.

Page title: ${product.title || "(none)"}
Page text:
${pageText(html)}`,
      config: { responseMimeType: "application/json", responseJsonSchema: FALLBACK_SCHEMA },
    });
    const data = JSON.parse(response.text ?? "{}");
    return {
      ...product,
      title: product.title || clean(data.title),
      price: product.price ?? (typeof data.price === "number" ? data.price : null),
      currency: product.currency ?? (typeof data.currency === "string" ? data.currency.toUpperCase() : null),
    };
  } catch (e) {
    console.error("Gemini fallback failed", e);
    return product;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const { data: { user } } = await clientFor(req).auth.getUser();
  if (!user) return json({ error: "Sign in to add items from links." }, 401);

  let body: { url?: string };
  try { body = await req.json(); } catch { return json({ error: "The request body must be JSON." }, 400); }

  try {
    const start = await assertPublicUrl(String(body.url ?? "").trim());
    const { html, url } = await fetchPage(start);
    let product = extract(html, url);
    if (!product.title || product.price == null) product = await geminiFill(product, html);
    if (!product.title) throw new UserFacingError("Couldn't find a product on that page. Add the item by hand instead.", 422);
    product.title = product.title.slice(0, 200);
    return json(product);
  } catch (e) {
    if (e instanceof UserFacingError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong while reading that link." }, 500);
  }
});
