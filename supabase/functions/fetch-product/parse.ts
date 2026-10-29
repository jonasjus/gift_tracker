// Pulls product details out of a store page's HTML: JSON-LD Product data first,
// then Open Graph / product meta tags, then the <title>.

export type Product = { title: string; price: number | null; currency: string | null; image: string | null; store: string; url: string };

export function decodeEntities(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
export const clean = (s: unknown) => (typeof s === "string" ? decodeEntities(s).replace(/\s+/g, " ").trim() : "");

export function parsePrice(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  let s = v.replace(/[^\d.,]/g, "");
  if (!s) return null;
  // "1.299,00" / "1 299,00" -> 1299.00 ; "1,299.00" -> 1299.00 ; "349,-" -> 349
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else if (lastComma === -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // "1.299" = 1299
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function metaTags(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    const key = attr("property") ?? attr("name") ?? attr("itemprop");
    const content = attr("content");
    if (key && content) {
      const k = (key[2] ?? key[3]).toLowerCase();
      if (!map.has(k)) map.set(k, clean(content[2] ?? content[3]));
    }
  }
  return map;
}

function jsonLdProducts(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => t === "Product" || t === "ProductGroup")) out.push(obj);
    if (obj["@graph"]) visit(obj["@graph"]);
    if (obj.mainEntity) visit(obj.mainEntity);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* skip malformed blocks */ }
  }
  return out;
}

function firstImage(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return firstImage(v[0]);
  if (v && typeof v === "object") return firstImage((v as Record<string, unknown>).url ?? (v as Record<string, unknown>).contentUrl);
  return null;
}

function offerPrice(offers: unknown): { price: number | null; currency: string | null } {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  for (const o of list as Record<string, unknown>[]) {
    const spec = (Array.isArray(o.priceSpecification) ? o.priceSpecification[0] : o.priceSpecification) as Record<string, unknown> | undefined;
    const price = parsePrice(o.price ?? o.lowPrice ?? spec?.price);
    if (price != null) return { price, currency: clean(o.priceCurrency ?? spec?.priceCurrency) || null };
    if (o.offers) { const inner = offerPrice(o.offers); if (inner.price != null) return inner; }
  }
  return { price: null, currency: null };
}

function absolute(src: string | null, base: URL): string | null {
  if (!src) return null;
  try { const u = new URL(decodeEntities(src), base); return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null; } catch { return null; }
}

function storeName(meta: Map<string, string>, url: URL) {
  return meta.get("og:site_name") || meta.get("application-name") ||
    url.hostname.replace(/^www\./, "").replace(/\.[a-z]+$/, "").replace(/^\w/, (c) => c.toUpperCase());
}

export function extract(html: string, url: URL): Product {
  const meta = metaTags(html);
  const ld = jsonLdProducts(html)[0];
  const ldOffer = ld ? offerPrice(ld.offers) : { price: null, currency: null };
  const titleTag = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const metaPrice = parsePrice(meta.get("product:price:amount") ?? meta.get("og:price:amount") ?? meta.get("price"));
  return {
    title: clean(ld?.name) || meta.get("og:title") || meta.get("twitter:title") || titleTag,
    price: ldOffer.price ?? metaPrice,
    currency: (ldOffer.currency || meta.get("product:price:currency") || meta.get("og:price:currency") || meta.get("pricecurrency") || "").toUpperCase() || null,
    image: absolute(firstImage(ld?.image) ?? meta.get("og:image") ?? meta.get("twitter:image") ?? null, url),
    store: storeName(meta, url),
    url: url.toString(),
  };
}

export function pageText(html: string) {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim().slice(0, 15_000);
}
