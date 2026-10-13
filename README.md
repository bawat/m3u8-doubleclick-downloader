# M3U8 Downloader

Downloads an M3U8 (HLS) playlist to a single MP4 using Node + ffmpeg, with
**automatic IPv6 support** for CDNs that are only reachable over IPv6.

## Usage

Run `setup.bat` once (no admin needed). After that, **right-click any `.m3u8`
file, or an internet shortcut (`.url`) to one, and choose "Convert to MP4"** —
a window opens, downloads, and stays open to show the result. The MP4 is named
after the playlist and saved next to the file you clicked.

To make a shortcut, copy the playlist URL, right-click in a folder, choose
**New → Shortcut** and paste it. (The menu entry shows on every internet
shortcut; one that doesn't point at a playlist just reports "Not an M3U8
playlist".)

Or from a terminal:

    node fix_m3u8.mjs "file.m3u8"
    node fix_m3u8.mjs "shortcut.url"
    node fix_m3u8.mjs "https://example.com/video.m3u8"

A URL's MP4 is saved in the current directory.

Options:

    --no-warp            Don't auto-start the IPv6 tunnel (fail if direct fails)
    --socks host:port    Route downloads through an existing SOCKS5 proxy

## What it does

1. Reads the playlist, downloading it first when given a shortcut or URL.
   Both **MPEG-TS** and **fMP4/CMAF** playlists work, including `#EXT-X-MAP`
   init sections and `#EXT-X-BYTERANGE` segments that are slices of one file.
2. Works out every segment URL in playlist order. Relative paths resolve
   against the playlist's URL. A downloaded `.m3u8` doesn't contain its own
   URL, so the tool reads it from the download record the browser saves with
   the file (`Zone.Identifier`); if that's missing, use a shortcut or pass the
   URL. Playlists that mix **absolute** CDN URLs with **relative** origin URLs
   (e.g. the first couple of segments) are handled by rebuilding the relative
   segments from the absolute CDN template by index.
3. Checks whether the CDN is reachable directly.
4. **If the CDN is IPv6-only and this machine has no IPv6**, it transparently
   starts a userspace Cloudflare WARP tunnel and routes the download through it
   — **no admin rights, no driver install, no system changes.** It uses
   [`wgcf`](https://github.com/ViRb3/wgcf) to create a WARP profile and
   [`wireproxy`](https://github.com/windtf/wireproxy) to run it in userspace as
   a local SOCKS5 proxy. These are downloaded once and cached in
   `%LOCALAPPDATA%\m3u8dl`.
5. Downloads each segment (6 at a time) with retries; failed segments are
   reported and skipped instead of aborting the whole job.
6. Joins the segments and remuxes to MP4 with ffmpeg (`-c copy`, no
   re-encode).

## Requirements

- Node.js and ffmpeg on PATH.
- Internet access (the WARP tunnel itself only needs IPv4/UDP outbound).

## Notes

- Signed segment URLs expire — look for `end=<unix-timestamp>` in the URL and
  download before then.
- A master playlist (a list of quality variants) isn't downloaded; the tool
  lists its variant playlists so you can convert one of those instead.
- The WARP profile/tools are cached; first run downloads ~25 MB of tools, later
  runs reuse them.
