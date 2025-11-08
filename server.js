import Fastify from "fastify";
import fs from "fs/promises";
import path from "path";

const isProduction = process.env.NODE_ENV === "production";
const isDebug = process.env.ENABLE_DEBUG === "true";
const dayOffset = parseInt(process.env.DAY_OFFSET || "0", 10);

const fastify = Fastify({ logger: false, trustProxy: true });
const asciiCompressedBaseDir = path.join(process.cwd(), "ascii-compressed");

const BASE_HEADERS = Object.freeze({
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Content-Encoding": "gzip",
  "Cache-Control": "max-age=0, no-cache, no-store, must-revalidate",
  Vary: "Accept-Encoding",
  "X-Content-Type-Options": "nosniff",
});
const MAX_VISITORS = 10_000;
const TTL_MS = 3_600_000; // 1h

const visitorFrames = new Map(); // key -> { idx, at }
function nextFrameIndex(key, frameCount) {
  if (frameCount <= 0) return 0;

  const now = Date.now();
  const prev = visitorFrames.get(key);
  const idx = prev ? prev.idx : 0;
  const next = (idx + 1) % frameCount;

  visitorFrames.set(key, { idx: next, at: now });

  if (visitorFrames.size > MAX_VISITORS) {
    let surplus = visitorFrames.size - MAX_VISITORS;
    for (const k of visitorFrames.keys()) {
      visitorFrames.delete(k);
      if (--surplus === 0) break;
    }
  }
  return idx;
}

// background TTL sweep to keep request path flat
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of visitorFrames) {
    if (now - v.at > TTL_MS) visitorFrames.delete(k);
  }
}).unref();

if (isDebug) {
  fastify.addHook("onRequest", (req) => {
    req._timings = { start: process.hrtime.bigint() };
  });

  fastify.addHook("onResponse", (req, _, done) => {
    const t = req._timings;
    if (!t) return done();
    const end = process.hrtime.bigint();
    console.log(
      `Request from ${req.ip} | ${req.headers["user-agent"] || ""}\n` +
      `frame: ${req._frameIdx}\n` +
      `key:   ${t.hashTime - t.start} ns\n` +
      `map:   ${t.mapTime - t.hashTime} ns\n` +
      `send:  ${end - t.sendTime} ns\n` +
      `total: ${end - t.start} ns`
    );
    done();
  });
}

async function getAnimationForToday() {
  const entries = await fs.readdir(asciiCompressedBaseDir, { withFileTypes: true });
  const animDirs = entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => parseInt(e.name, 10))
    .sort((a, b) => a - b);
  if (animDirs.length === 0)
    throw new Error("No animation directories found in ascii-compressed/");
  const days = Math.floor(Date.now() / 86_400_000) + dayOffset;
  const selected = animDirs[days % animDirs.length];
  return path.join(asciiCompressedBaseDir, String(selected));
}

let frames = [];
let frameHeaders = [];
async function loadFrames() {
  const dir = await getAnimationForToday();
  const files = await fs.readdir(dir);

  const frameFiles = files
    .filter((f) => f.endsWith(".svg.gz"))
    .sort((a, b) => {
      // Extract numeric part after "frame" prefix, use it for sorting
      const numA = parseInt(a.slice(5), 10);
      const numB = parseInt(b.slice(5), 10);
      return numA - numB;
    });
  if (frameFiles.length === 0) throw new Error("No .svg.gz frames found");

  const bufs = await Promise.all(
    frameFiles.map((f) => fs.readFile(path.join(dir, f)))
  );

  // Prebuild per-frame headers with Content-Length to avoid runtime calc
  frames = bufs;
  frameHeaders = bufs.map((b) => ({
    ...BASE_HEADERS,
    "Content-Length": String(b.length),
  }));

  console.log(`Loaded animation from: ${dir} (${bufs.length} frames)`);
}

fastify.get("/", (req, reply) => {
  if (isDebug) req._timings.hashTime = process.hrtime.bigint();

  const visitorKey = `${req.ip}|${req.headers["user-agent"] || ""}`;
  if (isDebug) req._timings.mapTime = process.hrtime.bigint();

  const count = frames.length;
  if (count === 0) {
    reply.code(503).send("frames-unavailable");
    return;
  }

  const frameIdx = nextFrameIndex(visitorKey, count);
  req._frameIdx = frameIdx;

  if (isDebug) req._timings.sendTime = process.hrtime.bigint();

  // Zero copy send of preloaded Buffer + prebuilt headers
  reply.headers(frameHeaders[frameIdx]).send(frames[frameIdx]);
});

// Startup
loadFrames()
  .then(() => {
    fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, address) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      const displayAddress = isProduction ? address : "http://localhost:3000";
      console.log(`🐾 Cat and ball server running at ${displayAddress}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
