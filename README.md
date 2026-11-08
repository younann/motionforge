# MotionForge

A Claude Code plugin that opens a local studio for making short animated ad videos (up to 30 seconds).

Describe the ad, or attach an image. Claude designs the scenes and generates product and lifestyle images. It builds live app and website screens in device frames, adds effects, motion, music and sound effects, then reviews rendered frames and polishes them. The result lands on a timeline where you trim, reorder, crop, retime and restyle by hand, then you export a high-quality MP4.

Generation runs through **your own installed Claude Code CLI**. There's no API key, no cloud backend, and nothing leaves your machine except your normal Claude Code requests.

## Requirements

| Needed for | Requirement |
|---|---|
| Everything | Node.js 20+ |
| Generating | Claude Code CLI, installed and logged in |
| Exporting | ffmpeg (with ffprobe) and Google Chrome or another Chromium browser |

Run `node scripts/doctor.mjs` to check them.

## Install

```bash
claude plugin marketplace add younann/motionforge
claude plugin install motionforge@motionforge-marketplace
```

Then type `/motionforge:open` in Claude Code. The studio opens in your browser.

For local development: `claude --plugin-dir /path/to/motionforge-plugin`, or `node scripts/launch.mjs` directly (`--no-open` skips opening the browser).

## Using the studio

- **Simple mode**: type what you want, choose the format (9:16, 1:1, 4:5, 16:9), length and style, then press *Make it*. Attach an image and choose **In the scene** (feature it in the ad) or **Rebuild it as animation** (recreate a static design as live, editable layers).
- **Editor mode**: Claude chat on the left, preview in the middle, inspector on the right, and a timeline with scene, music, effects and voice tracks.
  - Drag scenes to reorder them. Drag clip edges to trim or extend. Split at the playhead (`S`), duplicate (`⌘D`), delete (`⌫`), undo (`⌘Z`).
  - Click an element in the preview to edit its text, font, color, position and animation. Drag it to move it.
  - Select a scene and choose **Ask Claude**, or set the chat scope to the scene, to regenerate only that scene.
  - The Audio tab has bundled music and sound effects. The Media tab takes your images and audio, including voiceover recordings.
- **Settings** (sliders icon in the top bar): choose the image source and its token, and switch the polish pass on or off.
- **Export**: 720p, 1080p or 4K at 30 or 60 fps, as H.264 MP4 with AAC audio. Files are saved in `~/.motionforge/projects/<id>/exports/`.
- **Pro mode** (layer and keyframe editing) is coming next. The data model already supports keyframes.

## What Claude can put on screen

| Layer | What it's for |
|---|---|
| `image` with `prompt` | Generated product shots, lifestyle scenes, backgrounds |
| `image` with `src` | Your own uploaded photos |
| `ui` | Real HTML/CSS app and website screens in iPhone, Android, tablet, browser or laptop frames. Time-driven taps, typing (`data-type`), counters (`data-count`), state changes (`data-at` → `--k`) and scrolling |
| `cursor` | Pointer, hand or finger with press and ripple taps for UI demos |
| `effect` | Built-in confetti, sparkles, bokeh, rays, speed lines, light leak, dust, glow orbs, grid, waves, snow, stars, shockwave, scanlines |
| `text`, `shape`, `background`, `code` | Kinetic type, badges, price tags, gradients and aurora, custom canvas effects |
| Scene `camera`, `rotateX`/`rotateY` | Camera push-ins and drifts, 3D device tilts |

Reference ads in `server/prompts/examples/` show Claude the quality bar. They're copied into each project before generation.

### Image generation

| Source | Setup | Notes |
|---|---|---|
| Pollinations (default) | None | Free. Without a token: one image every 45 seconds (queued automatically) and a small logo. A free token from enter.pollinations.ai removes both limits. |
| Hugging Face | Token with Inference permission | FLUX.1 schnell, uses your free monthly credits |
| Off | — | Claude uses only your photos, UI, shapes and effects |

Generated images are cached per prompt in the project's media, and you can regenerate an image from the inspector after editing its prompt.

## How it works

```
Browser studio ──HTTP (token)──▶ local server (127.0.0.1)
  │                                 ├─ claude -p  (Read/Write/Edit/Glob only, in the project folder)
  └─ sandboxed stage iframe         └─ export: headless Chrome ─frames─▶ ffmpeg ─▶ MP4
       (same renderer for preview and export)
```

- **Composition**: Claude writes `comp.json`, made of scenes, layers (background, text, image, shape, code), enter/exit/loop presets, keyframes, transitions and audio clips. The format is documented in `server/prompts/director.md`, which also carries the craft rules that keep the output looking premium. The server validates the result and, if needed, sends the errors back to Claude once for a repair.
- **Renderer** (`studio/engine/`): a deterministic DOM renderer where every frame is a pure function of time. Preview and export use the same code, so what you see is what you export.
- **Isolation**: the stage runs in an `allow-scripts` sandboxed iframe with a CSP that blocks all network access. Code layers that Claude writes can draw on a canvas but can't reach the studio, its token or the network.
- **Claude CLI**: runs with `--permission-mode acceptEdits`, only the Read/Write/Edit/Glob tools, `--strict-mcp-config` and `--setting-sources project`, so your personal MCP servers, plugins and hooks aren't loaded into generation runs. Each project keeps its Claude session, so follow-up prompts have context.
- **Export**: headless Chrome via the DevTools protocol (Node's built-in WebSocket, no npm dependencies) captures PNG frames. ffmpeg encodes H.264 (CRF 15, BT.709) and mixes the audio tracks with fades and a limiter.
- **Polish pass**: after generating, the server renders a contact sheet of key frames (`review/contact-sheet.jpg`). Claude looks at it and fixes cut-off text, collisions, empty frames and weak shots.
- **History**: a snapshot of the composition is saved before every generation (`history/`), and the editor has full undo/redo.

The server binds to `127.0.0.1` only, requires a random bearer token from the launch URL, checks the `Origin` header, and never runs a shell.

### Environment variables

| Variable | Purpose |
|---|---|
| `MOTIONFORGE_PORT` | Port (default 4173) |
| `MOTIONFORGE_HOME` | Data folder (default `~/.motionforge`) |
| `MOTIONFORGE_CLAUDE_BIN` | Path to the `claude` binary |
| `MOTIONFORGE_MODEL` | Model passed to `claude --model` |
| `MOTIONFORGE_CHROME`, `MOTIONFORGE_FFMPEG`, `MOTIONFORGE_FFPROBE` | Binary overrides |

## Assets and licenses

- **Music and sound effects** (`assets/audio/`) are original: synthesized by `scripts/make-audio.mjs` and dedicated to the public domain under CC0. Regenerate them with `node scripts/make-audio.mjs`.
- **Fonts** (`assets/fonts/`) are SIL Open Font License families (Inter, Montserrat, Playfair Display, Space Grotesk, Oswald, Syne, DM Sans, Bebas Neue, Anton, Archivo Black, DM Serif Display, Instrument Serif, Poppins, JetBrains Mono).
- **UI library**: Preact + htm (MIT), vendored in `studio/vendor/`.

## Usage terms

Generation uses each user's own Claude Code setup and is subject to their plan's limits and Anthropic's terms. MotionForge doesn't provide or resell Claude access.

## License

MIT, see [LICENSE](LICENSE). Bundled fonts (SIL OFL), audio (CC0) and the Preact/htm bundle keep their own licenses, noted in their folders.

## Development

```bash
npm test                 # schema, timeline and edit-operation tests
node scripts/doctor.mjs  # check requirements
node scripts/launch.mjs  # start or reuse the server; restarts it when the version changes
```

Server logs: `~/.motionforge/server.log`.
