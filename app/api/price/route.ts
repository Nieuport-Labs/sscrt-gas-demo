// SCRT's USD price, from Osmosis. sSCRT is a 1:1 wrapper, so the same number applies to both.
//
// Proxied rather than fetched from the browser, for two reasons: the response is cached for a
// minute at the edge instead of once per visitor, and the app keeps working if the upstream ever
// stops sending permissive CORS headers.
const OSMOSIS_PRICE_URL = "https://public-osmosis-api.numia.xyz/tokens/v2/SCRT";

export const revalidate = 60;

export async function GET() {
  try {
    const resp = await fetch(OSMOSIS_PRICE_URL, { next: { revalidate } });
    if (!resp.ok) {
      return Response.json({ error: `osmosis returned HTTP ${resp.status}` }, { status: 502 });
    }
    const body = (await resp.json()) as Array<{ symbol?: string; price?: number }>;
    const price = body?.[0]?.price;
    if (typeof price !== "number" || !Number.isFinite(price)) {
      return Response.json({ error: "no usable price in the osmosis response" }, { status: 502 });
    }
    return Response.json({ usd: price, source: "osmosis", fetchedAt: new Date().toISOString() });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
