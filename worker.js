import { FRAMES, ANIMATION_IDS } from "./gen/frames.js";

const BASE_HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Cache-Control": "max-age=0, no-cache, no-store, must-revalidate",
  "X-Content-Type-Options": "nosniff",
};

const TTL_SECONDS = 3600; // 1 hour

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
 * Load frames for the current animation
 * Since frames are stored as plain SVG text (base64), just decode them
 * Cloudflare Workers will handle gzip compression automatically
 */
function loadFrames() {
  const animId = getAnimationForToday();
  const frameData = FRAMES[animId];

  if (!frameData || frameData.length === 0) {
    throw new Error(`No frames found for animation ${animId}`);
  }

  // Frames are base64-encoded SVG text - decode to strings
  const frames = frameData.map((b64) => atob(b64));

  return frames;
}

/**
 * Get the next frame index for a visitor
 * Returns the CURRENT index and stores the NEXT index (matching server.js logic)
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

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Main frame endpoint
    if (url.pathname === "/") {
      try {
        // Get visitor info
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ua = request.headers.get("User-Agent") || "";
        const visitorHash = await hashVisitorKey(ip, ua);

        // Load frames for today's animation
        const frames = loadFrames();

        // Get the frame index for this visitor
        const frameIdx = await getNextFrameIndex(env, visitorHash, frames.length);

        // Serve the frame
        return new Response(frames[frameIdx], {
          status: 200,
          headers: {
            ...BASE_HEADERS,
            "Content-Length": String(frames[frameIdx].length),
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
