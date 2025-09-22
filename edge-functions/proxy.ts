// Netlify Edge Function: proxy rápido + CORS + reescritura M3U8 (HLS)
// Soporta ?url=... y también /proxy/<URL-ENCODED>
// strict=1 evita mostrar HTML de bloqueo; ref=... para Referer

export default async (request: Request) => {
  const self = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

  // ?url=... o /proxy/<url-encoded>
  let targetStr = self.searchParams.get("url");
  if (!targetStr && self.pathname.startsWith("/proxy/")) {
    const raw = self.pathname.slice("/proxy/".length);
    if (raw) try { targetStr = decodeURIComponent(raw); } catch { targetStr = raw; }
  }
  if (!targetStr) return json({ error: "Falta ?url=" }, 400);

  const refStr  = self.searchParams.get("ref") || "";
  const strict  = self.searchParams.get("strict") === "1";
  const rewrite = self.searchParams.get("rewrite") === "0" ? false : true;

  let dst: URL;
  try { dst = new URL(targetStr); } catch { return json({ error: "URL inválida" }, 400); }

  const h: HeadersInit = {
    "user-agent":      "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36",
    "accept":          "*/*",
    "accept-language": "es-ES,es;q=0.9,en;q=0.8",
    "referer":         refStr || (dst.origin + "/"),
    "origin":          refStr ? new URL(refStr).origin : dst.origin
  };
  const range = request.headers.get("range"); if (range) (h as any).range = range;

  const up = await fetch(dst.href, { headers: h, redirect: "follow" });

  const ct = (up.headers.get("content-type") || "").toLowerCase();
  if (strict) {
    const sniff = await up.clone().arrayBuffer();
    const peek  = new TextDecoder().decode(sniff.slice(0, 1024)).toLowerCase();
    if (ct.includes("text/html") || peek.includes("<html") ||
        peek.includes("forbidden") || peek.includes("access denied") || peek.includes("astra")) {
      return json({ ok:false, offline:true, status:up.status, reason:"html_blocked" }, 200);
    }
  }

  const seemsM3U8 = ct.includes("application/vnd.apple.mpegurl") ||
                    ct.includes("audio/mpegurl") ||
                    dst.pathname.toLowerCase().endsWith(".m3u8");
  if (seemsM3U8 && rewrite) {
    const text = await up.text();
    const rewritten = rewriteM3U8(text, dst, self, refStr);
    const hdr = cors({
      "content-type": "application/vnd.apple.mpegurl",
      "cache-control": "no-store, no-cache, must-revalidate",
      "x-original-url": dst.href
    });
    return new Response(rewritten, { status: 200, headers: hdr });
  }

  const out = cors({
    "content-type": up.headers.get("content-type") || guessCT(dst.pathname),
    "x-original-url": dst.href
  });
  if (/\.(ts|mp4|m4s|aac|mp3)$/i.test(dst.pathname) || ct.startsWith("video/") || ct.startsWith("audio/")) {
    out.set("cache-control", "public, max-age=0, s-maxage=8, stale-while-revalidate=8");
  } else {
    out.set("cache-control", "no-store, no-cache, must-revalidate");
  }
  const cr = up.headers.get("content-range"); if (cr) out.set("content-range", cr);
  const ar = up.headers.get("accept-ranges"); if (ar) out.set("accept-ranges", ar);

  return new Response(up.body, { status: up.status, headers: out });
};

function cors(extra: Record<string,string> = {}) {
  const h = new Headers(extra);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,HEAD,OPTIONS");
  h.set("access-control-allow-headers", "*");
  return h;
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors({ "content-type": "application/json" }) });
}
function guessCT(p: string) {
  const x = p.toLowerCase();
  if (x.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (x.endsWith(".mpd"))  return "application/dash+xml";
  if (x.endsWith(".ts"))   return "video/mp2t";
  if (x.endsWith(".mp4"))  return "video/mp4";
  if (x.endsWith(".aac"))  return "audio/aac";
  if (x.endsWith(".mp3"))  return "audio/mpeg";
  return "application/octet-stream";
}
function abs(base: URL, rel: string) {
  try { return new URL(rel, base).href; } catch { return rel; }
}
function rewriteM3U8(text: string, baseURL: URL, selfURL: URL, refStr: string) {
  const selfBase = selfURL.origin + selfURL.pathname.replace(/\/+$/,"");
  const refQ = refStr ? `&ref=${encodeURIComponent(refStr)}` : "";
  return text.split(/\r?\n/).map(line => {
    const L = line.trim();
    if (!L || L.startsWith("#")) {
      if (/^#EXT-X-KEY:/i.test(L)) {
        const m = L.match(/URI="([^"]+)"/i);
        if (m && m[1]) {
          const A = abs(baseURL, m[1]);
          return L.replace(m[0], `URI="${selfBase}?url=${encodeURIComponent(A)}${refQ}"`);
        }
      }
      return line;
    }
    const A = abs(baseURL, L);
    return `${selfBase}?url=${encodeURIComponent(A)}${refQ}`;
  }).join("\n");
    }
