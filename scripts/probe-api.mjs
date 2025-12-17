import http from "http";

const base = process.env.PROBE_BASE || "http://localhost:61234";
const paths = [
  "/api/health",
  "/api/db-health",
  "/api/sos",
  "/api/threats",
  "/api/zone-markers",
  "/api/danger-zones",
  "/api/map",
  "/api/users/test-user"
];

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ ok: true, status: res.statusCode || 0, body: data });
      });
    });
    req.on("error", (err) => {
      resolve({ ok: false, status: 0, body: String(err?.message || err) });
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error("timeout"));
    });
  });
}

for (const p of paths) {
  // eslint-disable-next-line no-await-in-loop
  const r = await get(base + p);
  const preview = String(r.body || "").replace(/\s+/g, " ").slice(0, 220);
  // eslint-disable-next-line no-console
  console.log(`${p} ${r.ok ? r.status : "ERR"} ${preview}`);
}
