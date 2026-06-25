import { execSync } from "child_process";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Adds a right-click "Convert to MP4" context-menu entry for .m3u8 files.
// Uses SystemFileAssociations so it appears regardless of which app owns the
// .m3u8 association (VLC, browsers, etc.). HKCU only -> no admin required.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodePath = process.execPath;
const scriptPath = path.join(__dirname, "fix_m3u8.mjs");
const launcherPath = path.join(__dirname, "convert_m3u8.cmd");

// A small launcher so the console window stays open to show progress/result.
const launcher =
  "@echo off\r\n" +
  "title Convert M3U8 to MP4\r\n" +
  `"${nodePath}" "${scriptPath}" "%~1"\r\n` +
  "echo.\r\n" +
  "echo ===== Finished. Press any key to close. =====\r\n" +
  "pause >nul\r\n";
writeFileSync(launcherPath, launcher);

const KEY = "HKCU\\Software\\Classes\\SystemFileAssociations\\.m3u8\\shell\\ConvertToMP4";

try {
  // Menu label.
  execSync(`reg add "${KEY}" /ve /d "Convert to MP4" /f`);
  // Icon (uses node's icon; purely cosmetic).
  execSync(`reg add "${KEY}" /v Icon /d "${nodePath}" /f`);
  // Command: launch the .cmd with the clicked file.
  execSync(`reg add "${KEY}\\command" /ve /d "\\"${launcherPath}\\" \\"%1\\"" /f`);

  console.log("Success! Right-click any .m3u8 file and choose \"Convert to MP4\".");
  console.log("(On the right-click menu; no need to double-click setup again.)");
  console.log("\nIf you don't see it immediately, restart Explorer or sign out/in.");
} catch (e) {
  console.error("Failed to add context menu:", e.message);
  process.exit(1);
}
