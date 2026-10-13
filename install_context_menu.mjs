import { execSync } from "child_process";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Adds a right-click "Convert to MP4" context-menu entry for .m3u8 files and
// .url internet shortcuts. HKCU only -> no admin required.
//
// .m3u8 uses SystemFileAssociations so it appears regardless of which app owns
// the association (VLC, browsers, etc.). Shortcuts ignore verbs registered
// there (and under InternetShortcut), so theirs goes under AllFilesystemObjects,
// limited to .url files. AppliesTo can't see a shortcut's target URL, so it
// shows on every .url; the tool rejects shortcuts that aren't playlists.

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

const CLASSES = "HKCU\\Software\\Classes";

function addVerb(key) {
  // Menu label.
  execSync(`reg add "${key}" /ve /d "Convert to MP4" /f`);
  // Icon (uses node's icon; purely cosmetic).
  execSync(`reg add "${key}" /v Icon /d "${nodePath}" /f`);
  // Command: launch the .cmd with the clicked file.
  execSync(`reg add "${key}\\command" /ve /d "\\"${launcherPath}\\" \\"%1\\"" /f`);
}

try {
  addVerb(`${CLASSES}\\SystemFileAssociations\\.m3u8\\shell\\ConvertToMP4`);

  const urlKey = `${CLASSES}\\AllFilesystemObjects\\shell\\ConvertToMP4`;
  // Restrict to .url first, so the entry never shows on every file.
  execSync(`reg add "${urlKey}" /v AppliesTo /d "System.FileExtension:=\\".url\\"" /f`);
  addVerb(urlKey);

  console.log("Success! Right-click any .m3u8 file, or a shortcut (.url) to one, and choose \"Convert to MP4\".");
  console.log("(On the right-click menu; no need to double-click setup again.)");
  console.log("\nIf you don't see it immediately, restart Explorer or sign out/in.");
} catch (e) {
  console.error("Failed to add context menu:", e.message);
  process.exit(1);
}
