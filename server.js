import Fastify from "fastify";
import fs from "fs/promises";
import path from "path";
import pino from "pino";

const isProduction =
  process.env.NODE_ENV === "production" || process.env.PRODUCTION === "true";
const isDebug = process.env.ENABLE_DEBUG === "true";
const dayOffset = parseInt(process.env.DAY_OFFSET || "0", 10);

// logger
const log = pino({
  level: isDebug ? "debug" : "info",
  transport: !isProduction
    ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        singleLine: false,
        ignore: "pid,hostname"
      }
    }
    : undefined
});
log.debug({ isProduction, isDebug, dayOffset }, "env");
log.debug({ cwd: process.cwd(), node: process.version }, "runtime");

// Consts
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

  // Emergency cleanup: if map exceeds limit, remove oldest entry
  // Maps preserve insertion order, so first key is oldest
  if (visitorFrames.size > MAX_VISITORS) {
    const firstKey = visitorFrames.keys().next().value;
    visitorFrames.delete(firstKey);
  }
  return idx;
}

// Background TTL sweep to keep request path flat
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of visitorFrames) {
    if (now - v.at > TTL_MS) visitorFrames.delete(k);
  }
}, TTL_MS).unref();

async function getAnimationForToday() {
  const entries = await fs.readdir(asciiCompressedBaseDir, {
    withFileTypes: true,
  });
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
  frameHeaders = bufs.map((b) =>
    Object.freeze({
      ...BASE_HEADERS,
      "Content-Length": String(b.length),
    })
  );

  log.info({ dir, frames: bufs.length }, "animation loaded");
}

//
// Routes
//

fastify.get("/", (req, reply) => {
  if (isDebug) req._timings.hashTime = process.hrtime.bigint();

  // Build visitor key - truncate if needed to prevent DoS via large user-agent
  const ip = req.ip;
  const ua = req.headers["user-agent"] || "";
  const visitorKey =
    ip.length + ua.length > 511
      ? `${ip}|${ua.slice(0, 511 - ip.length)}`
      : `${ip}|${ua}`;

  if (isDebug) req._timings.mapTime = process.hrtime.bigint();

  if (frames.length === 0) {
    reply.code(503).type("text/plain").send("frames-unavailable");
    return;
  }

  const frameIdx = nextFrameIndex(visitorKey, frames.length);
  if (isDebug) req._frameIdx = frameIdx;
  if (isDebug) req._timings.sendTime = process.hrtime.bigint();

  // Zero copy send of preloaded Buffer + prebuilt headers
  reply.headers(frameHeaders[frameIdx]).send(frames[frameIdx]);
});

// Health check endpoint for Fly.io
fastify.get("/health", (req, reply) => {
  const ready = frames.length > 0;
  if (isDebug || !isProduction) {
    log.info({ frames: frames.length, ready, from: req.ip }, "health");
  }

  if (!ready) {
    reply.code(503).type("text/plain").send("not ready");
    return;
  }

  reply.code(200).type("text/plain").send("ok");
});

//
// Hooks
//

if (isDebug) {
  fastify.addHook("onRequest", (req) => {
    req._timings = { start: process.hrtime.bigint() };
  });

  fastify.addHook("onResponse", (req, _, done) => {
    const t = req._timings;
    if (!t) return done();
    const end = process.hrtime.bigint();
    log.debug(
      {
        ip: req.ip,
        ua: req.headers["user-agent"] || "",
        frame: req._frameIdx,
        key_ns: String(t.hashTime - t.start),
        map_ns: String(t.mapTime - t.hashTime),
        send_ns: String(end - t.sendTime),
        total_ns: String(end - t.start),
      },
      "request timings"
    );
    done();
  });
}

// Start
loadFrames()
  .then(() => {
    log.info("Frames loaded successfully");
    const port = parseInt(process.env.PORT || "3000", 10);
    log.info({ port }, "attempting to listen");

    fastify.listen({ port, host: "0.0.0.0" }, (err) => {
      if (err) {
        log.error({ err }, "listen error");
        process.exit(1);
      }

      const addr = fastify.server.address();
      const portOut = addr && typeof addr === "object" ? addr.port : port;
      log.info({ port: portOut }, "cat-and-ball server running");
      if (!isProduction) log.info({ url: `http://localhost:${port}` }, "local url");

      if (isDebug) {
        log.debug({ addr }, "bind addr");
        log.debug(
          { trustProxy: String(fastify.initialConfig.trustProxy) },
          "trust proxy"
        );
        import("os").then(({ networkInterfaces }) => {
          const summary = Object.entries(networkInterfaces())
            .map(([name, addrs]) => {
              const v4 =
                (addrs || [])
                  .filter((a) => a.family === "IPv4")
                  .map((a) => a.address)
                  .join(", ") || "-";
              return `${name}: ${v4}`;
            })
            .join(" | ");
          log.debug({ summary }, "network interfaces");
        });
      }
    });
  })
  .catch((err) => {
    log.error(
      {
        err,
        cwd: process.cwd(),
        baseDir: asciiCompressedBaseDir,
      },
      "startup error"
    );
    process.exit(1);
  });
