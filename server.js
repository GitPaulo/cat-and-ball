import Fastify from "fastify";
import fs from "fs/promises";
import path from "path";

const fastify = Fastify({ logger: false });
const RESPONSE_HEADERS = Object.freeze({
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Content-Encoding": "gzip",
  "Cache-Control": "max-age=0, no-cache, no-store, must-revalidate",
});

const framesDir = path.join(process.cwd(), "frames_compressed");
const visitorFrames = new Map();

const DEBUG = process.env.ENABLE_DEBUG === "true";
if (DEBUG) {
  fastify.addHook("onRequest", (req) => {
    req._timings = { start: process.hrtime.bigint() };
  });

  fastify.addHook("onResponse", (req, reply, done) => {
    const { start, hashTime, mapTime, sendTime } = req._timings;
    const endTime = process.hrtime.bigint();

    console.log(
      `Request from ${req.ip} | ${req.headers["user-agent"] || ""}\n` +
      `frame: ${req._frameIdx}\n` +
      `hash:  ${hashTime - start} ns\n` +
      `map:   ${mapTime - hashTime} ns\n` +
      `send:  ${endTime - sendTime} ns\n` +
      `total: ${endTime - start} ns`
    );

    done();
  });
}

let compressedFrames = [];
const loadFrames = async () => {
  const files = await fs.readdir(framesDir);
  const frameFiles = files.filter((file) => file.endsWith(".svg.gz")).sort();

  /**
   * Compress the frames into memory to avoid reading from disk on each request.
   * Sort them to ensure conrrect order.
   */
  compressedFrames = await Promise.all(
    frameFiles.map((file) => fs.readFile(path.join(framesDir, file)))
  );
};

fastify.get("/", (req, reply) => {
  if (DEBUG) {
    req._timings.hashTime = process.hrtime.bigint();
  }

  // Use a combination of IP and User-Agent to create a unique key for each visitor
  // Caveat:
  // - This does not handle cases where multiple users share the same IP (e.g., NAT)
  // - User-Agent can be spoofed, but it's a reasonable heuristic for this use case
  // - This will not work in a distributed environment, but we don't do that here
  const visitorKey = `${req.ip}|${req.headers["user-agent"] || ""}`;

  if (DEBUG) {
    req._timings.mapTime = process.hrtime.bigint();
  }

  const frameIdx = visitorFrames.get(visitorKey) || 0;
  visitorFrames.set(visitorKey, (frameIdx + 1) % compressedFrames.length);
  req._frameIdx = frameIdx;

  if (DEBUG) {
    req._timings.sendTime = process.hrtime.bigint();
  }

  reply.headers(RESPONSE_HEADERS).send(compressedFrames[frameIdx]);
});

loadFrames()
  .then(() => {
    fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, address) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log(`🐾 Cat and ball server running at ${address}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
