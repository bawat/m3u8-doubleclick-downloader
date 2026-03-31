import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "fix_m3u8.mjs");

if (!existsSync(scriptPath)) {
  console.error("fix_m3u8.mjs not found in the same directory as this script.");
  process.exit(1);
}

// Find where node.exe is
const nodePath = process.execPath;
console.log(`Node found at: ${nodePath}`);
console.log(`Script path: ${scriptPath}`);

// Register the file type and association via reg.exe
try {
  // Create a file type entry for .m3u8
  execSync(`reg add "HKCU\\Software\\Classes\\.m3u8" /ve /d "m3u8file" /f`);

  // Create the handler entry
  execSync(`reg add "HKCU\\Software\\Classes\\m3u8file" /ve /d "M3U8 Video Playlist" /f`);

  // Set the open command to: node "path\to\fix_m3u8.mjs" "%1"
  execSync(`reg add "HKCU\\Software\\Classes\\m3u8file\\shell\\open\\command" /ve /d "\\"${nodePath}\\" \\"${scriptPath}\\" \\"%1\\"" /f`);

  console.log("\nSuccess! .m3u8 files will now be processed by fix_m3u8.mjs when double-clicked.");
  console.log("Note: You may need to refresh Explorer (or log off and on) for the change to take effect.");
} catch (e) {
  console.error("Failed to register file association:", e.message);
  process.exit(1);
}