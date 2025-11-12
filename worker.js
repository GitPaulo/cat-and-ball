import { FRAMES, ANIMATION_IDS } from "./gen/frames.js";

const BASE_HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  // Trying to avoid github cammo caching
  "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0, s-maxage=0",
  "Pragma": "no-cache",
  "Expires": "Fri, 01 Jan 1980 00:00:00 GMT",
  "X-Content-Type-Options": "nosniff",
};
const TTL_SECONDS = 3600; // 1 hour
const frameCache = new Map(); // Cache for decoded frames

/**
 * Hash a visitor key (IP + User-Agent) for privacy
 */
async function hashVisitorKey(ip, ua) {
  const key = `${ip}|${ua.slice(0, 500)}`; // Truncate UA to prevent DoS
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

/**
 * Get the animation ID for today
 */
function getAnimationForToday() {
  const dayOffset = 0; // Can be made configurable via env vars
  const days = Math.floor(Date.now() / 86_400_000) + dayOffset;
  const selected = ANIMATION_IDS[days % ANIMATION_IDS.length];
  return String(selected);
}

/**
 * Decode base64 to UTF-8 string
 * atob() treats bytes as Latin-1, so we need to decode UTF-8 properly
 */
function base64ToUtf8(b64) {
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Load frames for the current animation
 */
function loadFrames() {
  const animId = getAnimationForToday();

  // Check cache first
  if (frameCache.has(animId)) {
    return frameCache.get(animId);
  }

  const frameData = FRAMES[animId];
  if (!frameData || frameData.length === 0) {
    throw new Error(`No frames found for animation ${animId}`);
  }

  // Decode base64-encoded UTF-8 frames
  const frames = frameData.map(base64ToUtf8);
  frameCache.set(animId, frames);

  return frames;
}

/**
 * Get the next frame index for a visitor
 */
async function getNextFrameIndex(env, visitorHash, frameCount) {
  if (frameCount <= 0) return 0;

  // Try to get current state from KV
  const stored = await env.VISITOR_STATE.get(visitorHash, "json");
  const currentIdx = stored?.idx ?? 0;
  const nextIdx = (currentIdx + 1) % frameCount;

  // Store the new state with TTL (fire and forget with waitUntil for performance)
  await env.VISITOR_STATE.put(
    visitorHash,
    JSON.stringify({ idx: nextIdx, at: Date.now() }),
    { expirationTtl: TTL_SECONDS }
  );

  // Return current index (the frame to show now)
  return currentIdx;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (url.pathname === "/") {
      try {
        // Get visitor info
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ua = request.headers.get("User-Agent") || "";

        // Detect if request is from GitHub Camo proxy
        const isGitHubCamo = ua.includes("github-camo") ||
          request.headers.get("via")?.includes("github-camo");

        let visitorHash;
        if (isGitHubCamo) {
          // For GitHub Camo: use a global key since we can't distinguish individual visitors
          // Camo rotates IPs and strips user info, so all requests look identical
          visitorHash = "github-camo-global";
        } else {
          // For direct requests: use IP + query + UA for per-visitor tracking
          const queryString = url.search || "";
          visitorHash = await hashVisitorKey(ip + queryString, ua);
        }

        // Load frames for today's animation
        const frames = loadFrames();

        // Get the frame index for this visitor
        const frameIdx = await getNextFrameIndex(env, visitorHash, frames.length);

        // Serve frame (Response automatically encodes string as UTF-8)
        const frame = frames[frameIdx];
        const timestamp = Date.now();
        return new Response(frame, {
          status: 200,
          headers: {
            ...BASE_HEADERS,
            // Unique ETag per frame + timestamp to prevent any caching
            "ETag": `"${frameIdx}-${timestamp}"`,
            // Always set to current time so Camo sees it as "fresh"
            "Last-Modified": new Date().toUTCString(),
            // Additional cache busting
            "Vary": "Accept-Encoding, User-Agent",
          },
        });
      } catch (error) {
        console.error("Error serving frame:", error);
        return new Response("frames-unavailable", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    // 404 for other paths
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  },
};
