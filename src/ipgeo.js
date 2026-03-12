import fetch from "node-fetch";

/**
 * Best-effort IP geo.
 * Tries ipapi.co then falls back to ipwho.is
 */
export async function geoFromIp(ip) {
  // If localhost or private ranges, return null
  if (!ip || ip === "127.0.0.1" || ip === "::1") return null;

  // Sometimes Express gives ::ffff:1.2.3.4
  const cleaned = ip.startsWith("::ffff:") ? ip.slice(7) : ip;

  // ipapi.co
  try {
    const r = await fetch(`https://ipapi.co/${encodeURIComponent(cleaned)}/json/`, {
      headers: { "User-Agent": "confidentiel-messenger/1.0" }
    });
    if (r.ok) {
      const j = await r.json();
      if (j && (j.city || j.region || j.country_name)) {
        return {
          city: j.city || "",
          region: j.region || "",
          country: j.country_name || "",
          lat: j.latitude ?? null,
          lon: j.longitude ?? null,
          provider: "ipapi.co"
        };
      }
    }
  } catch {}

  // ipwho.is
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(cleaned)}`);
    if (r.ok) {
      const j = await r.json();
      if (j && j.success) {
        return {
          city: j.city || "",
          region: j.region || "",
          country: j.country || "",
          lat: j.latitude ?? null,
          lon: j.longitude ?? null,
          provider: "ipwho.is"
        };
      }
    }
  } catch {}

  return null;
}