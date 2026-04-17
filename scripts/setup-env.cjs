/**
 * One-time local setup: copy env templates if missing (never overwrites existing secrets).
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function copyIfMissing(relSrc, relDest) {
  const src = path.join(root, relSrc);
  const dest = path.join(root, relDest);
  if (!fs.existsSync(src)) {
    console.warn("[setup] Skip missing template:", relSrc);
    return;
  }
  if (fs.existsSync(dest)) {
    console.log("[setup] Keep existing", relDest);
    return;
  }
  fs.copyFileSync(src, dest);
  console.log("[setup] Created", relDest, "←", relSrc);
  console.log("[setup] Edit", relDest, "and add your Reddit credentials.");
}

copyIfMissing("backend/.env.example", "backend/.env");
copyIfMissing("frontend/.env.example", "frontend/.env.local");
console.log("[setup] Done.");
