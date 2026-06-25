# M3U8 Downloader

Downloads an M3U8 (HLS) playlist to a single MP4 using Node + ffmpeg, with
**automatic IPv6 support** for CDNs that are only reachable over IPv6.

## Usage

Run `setup.bat` once (no admin needed). After that, **right-click any `.m3u8`
file and choose "Convert to MP4"** — a window opens, downloads, and stays open
to show the result.

Or from a terminal:

    node fix_m3u8.mjs "file.m3u8"

Options:

    --no-warp            Don't auto-start the IPv6 tunnel (fail if direct fails)
    --socks host:port    Route downloads through an existing SOCKS5 proxy

## What it does

1. Parses every segment URL in playlist order. Playlists that mix **absolute**
   CDN URLs with **relative** origin URLs (e.g. the first couple of segments)
   are handled by rebuilding the relative segments from the absolute CDN
   template by index.
2. Checks whether the CDN is reachable directly.
3. **If the CDN is IPv6-only and this machine has no IPv6**, it transparently
   starts a userspace Cloudflare WARP tunnel and routes the download through it
   — **no admin rights, no driver install, no system changes.** It uses
   [`wgcf`](https://github.com/ViRb3/wgcf) to create a WARP profile and
   [`wireproxy`](https://github.com/windtf/wireproxy) to run it in userspace as
   a local SOCKS5 proxy. These are downloaded once and cached in
   `%LOCALAPPDATA%\m3u8dl`.
4. Downloads each segment (6 at a time) with retries; failed segments are
   reported and skipped instead of aborting the whole job.
5. Concatenates the TS segments and remuxes to MP4 with ffmpeg (`-c copy`,
   no re-encode).

## Requirements

- Node.js and ffmpeg on PATH.
- Internet access (the WARP tunnel itself only needs IPv4/UDP outbound).

## Notes

- Signed segment URLs expire — look for `end=<unix-timestamp>` in the URL and
  download before then.
- The WARP profile/tools are cached; first run downloads ~25 MB of tools, later
  runs reuse them.
