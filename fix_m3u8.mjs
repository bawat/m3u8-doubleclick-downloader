import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import path from "path";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node fix_m3u8.mjs <file.m3u8>");
  process.exit(1);
}

const content = readFileSync(file, "utf8");

// Find an absolute URL already in the file to extract the base
const absoluteMatch = content.match(/^(https?:\/\/[^/]+)/m);
if (!absoluteMatch) {
  console.error("Could not find any absolute URL in the m3u8 to derive base from.");
  process.exit(1);
}
const base = absoluteMatch[1];
console.log(`Base URL found: ${base}`);

// Fix relative URLs in the m3u8
const fixed = content.replace(/^\/key=/gm, `${base}/key=`);

// Write a temp fixed m3u8
const tmpFile = file + ".tmp.m3u8";
writeFileSync(tmpFile, fixed, "utf8");

// Derive output filename (.mp4)
const outFile = path.basename(file).replace(/\.m3u8$/, "") + ".mp4";
console.log(`Output file: ${outFile}`);

// Run ffmpeg
console.log("Running ffmpeg...");
const result = spawnSync(
  "ffmpeg",
  [
    "-protocol_whitelist", "file,crypto,data,http,https,tcp,tls",
    "-allowed_extensions", "ALL",
    "-i", tmpFile,
    "-c", "copy",
    "-bsf:a", "aac_adtstoasc",
    outFile,
  ],
  { stdio: "inherit" }
);

// Clean up temp file
unlinkSync(tmpFile);

if (result.status === 0) {
  console.log(`\nDone! Saved as: ${outFile}`);
} else {
  console.error("\nffmpeg failed. See output above.");
  process.exit(1);
}