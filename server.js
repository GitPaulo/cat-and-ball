import Fastify from "fastify";
import fs from "fs/promises";
import path from "path";

const fastify = Fastify({ logger: false });
const framesDir = path.join(process.cwd(), "frames_compressed");

let compressedFrames = [];
const visitorFrames = new Map();

const loadFrames = async () => {
  const files = await fs.readdir(framesDir);
  const frameFiles = files.filter(f => f.endsWith(".svg.gz")).sort();

  for (const file of frameFiles) {
    const buffer = await fs.readFile(path.join(framesDir, file));
    compressedFrames.push(buffer);
  }
};

const quickHashForRequester = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

fastify.addHook("onRequest", async (req) => {
  if (process.env.ENABLE_DEBUG) {
    req.startTime = process.hrtime.bigint();
  }
});

fastify.addHook("onSend", async (req) => {
  if (process.env.ENABLE_DEBUG && req.startTime) {
    const total = process.hrtime.bigint() - req.startTime;
    console.log(`Fastify onSend timing: total=${total} ns for ${req.raw.url}`);
  }
});

fastify.get("/", (req, reply) => {
  const debug = Boolean(process.env.ENABLE_DEBUG);

  const start = debug ? process.hrtime.bigint() : 0;
  const { ip, headers } = req;
  const ua = headers["user-agent"] ?? "";

  const startHash = debug ? process.hrtime.bigint() : 0;
  const visitorKey = quickHashForRequester(`${ip}|${ua}`);
  const endHash = debug ? process.hrtime.bigint() : 0;

  const startMap = debug ? process.hrtime.bigint() : 0;
  let frameIdx = visitorFrames.get(visitorKey) ?? 0;
  visitorFrames.set(visitorKey, (frameIdx + 1) % compressedFrames.length);
  const buffer = compressedFrames[frameIdx];
  const endMap = debug ? process.hrtime.bigint() : 0;

  const startSend = debug ? process.hrtime.bigint() : 0;
  reply
    .header("Content-Type", "image/svg+xml")
    .header("Content-Encoding", "gzip")
    .send(buffer)
    .then(() => {
      if (debug) {
        const endSend = process.hrtime.bigint();
        const endTotal = process.hrtime.bigint();
        console.log(
          `Request from ${ip} | ${ua}
frame: ${frameIdx}
hash:  ${endHash - startHash} ns
map:   ${endMap - startMap} ns
send:  ${endSend - startSend} ns
total: ${endTotal - start} ns`
        );
      }
    });
});

loadFrames().then(() => {
  fastify.listen({ port: 3000, host: "0.0.0.0" }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`🐾 Ultra-fast Cat server running at ${address}`);
  });
});
