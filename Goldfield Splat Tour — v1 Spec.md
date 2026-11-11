# Goldfield Splat Tour — v1 Spec

Nov 8, 2026 · @Paolo Tosolini

## Overview

v1 is a desktop web page that shows the Goldfield Gaussian splat full-screen with a side carousel of 8–10 story stops. Selecting a stop flies the camera to a saved viewpoint and shows its title and description. It is built with Claude Code and hosted on GitHub Pages.

**In scope**

- Full-screen splat viewer with free orbit/fly controls
- Stop 1: an overview of the whole scanned area with the tour title
- Stops 2–N: placeholder text ("Stop 2" / "Description 2"), editable later
- Vertical carousel on the right with a thumbnail, title and description per card
- Previous / Next buttons and arrow keys (looping), Home button back to the overview
- Smooth camera move between stops, slow idle drift at each stop
- Deep link per stop (`#stop-3`)
- Dev mode to capture poses, type text, and export `stops.json` + thumbnails

**Out of scope for v1:** mobile layout, audio, archival media, 1890s filter, gamification, hotspots placed in 3D, written history text.

## Tech stack and repo structure

Use the PlayCanvas Engine with Vite and plain TypeScript, no UI framework. SOG is PlayCanvas's native format, and its `gsplat` component loads `.sog`, unbundled `meta.json` and streamed `lod-meta.json` ([engine docs](https://app.unpkg.com/playcanvas@2.21.1/files/build/playcanvas/src/framework/components/gsplat/component.d.ts)). Claude Code should check the current PlayCanvas docs and examples for exact camera and loading APIs rather than rely on memory.

```
Claude - 3DGS/            # working folder = git repo root
├── source/               # NOT committed (.gitignore)
│   ├── scene.ply         # original scan, input to Step 0
│   └── lod1.ply ...      # intermediate decimated levels
├── index.html
├── src/
│   ├── main.ts          # app bootstrap, load splat, wire UI
│   ├── viewer.ts        # PlayCanvas app, camera, controls
│   ├── tour.ts          # stop state, transitions, idle drift, deep links
│   ├── carousel.ts      # side rail UI, prev/next, keyboard
│   ├── devmode.ts       # pose capture, text editing, export
│   └── styles.css
├── public/
│   ├── model/           # prepared Streamed SOG (output of Step 0)
│   ├── stops.json
│   └── thumbs/          # stop-1.webp, stop-2.webp, ...
├── tools/
│   └── prepare-model.sh # splat-transform commands, reproducible
└── .github/workflows/deploy.yml
```

Move `scene.ply` from the folder root into `source/` before starting, and add `source/` to `.gitignore`. That keeps the large original and the intermediate LOD files out of Git; only the prepared output under `public/model/` is committed. The folder name contains spaces, so scripts must quote paths. The GitHub repo is `paolotosolini/goldfield` (public), which makes the site `paolotosolini.github.io/goldfield/` and Vite's `base` `/goldfield/`. All folder names are lowercase.

## Step 0: prepare the model

Convert the original PLY to **Streamed SOG** with PlayCanvas's `splat-transform` CLI. This keeps full detail near the camera, splits the model into many small files that fit GitHub's 100 MB per-file limit, and loads progressively. Always start from the original PLY, never from the existing 240 MB SOG, which is already quantized.

Streamed SOG is a folder with a `lod-meta.json` index and one unbundled SOG chunk per subfolder ([format](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/)). Lower LOD levels are made by decimating the source ([guide](https://developer.playcanvas.com/user-manual/splat-transform/streamed-sog/)):

```bash
npm install -g @playcanvas/splat-transform

# Run from the working folder "Claude - 3DGS"
# Optional: crop first in SuperSplat to the area the stops cover; export over source/scene.ply

# Inspect the source
splat-transform source/scene.ply --stats null

# Build lower detail levels
splat-transform source/scene.ply -d 50% source/lod1.ply
splat-transform source/scene.ply -d 25% source/lod2.ply
splat-transform source/scene.ply -d 10% source/lod3.ply

# Bundle into Streamed SOG
splat-transform \
  source/scene.ply -l 0 source/lod1.ply -l 1 source/lod2.ply -l 2 source/lod3.ply -l 3 \
  public/model/lod-meta.json \
  --filter-nan --filter-harmonics 1
```

Treat these numbers as a starting point. Claude Code should put the commands in `tools/prepare-model.sh` and report total size and largest file. (The Goldfield scan has no higher-order spherical harmonics, so `--filter-harmonics 0` is lossless and the 0/1/2 comparison doesn't apply.) `--decimate-adaptive` may give better results on scenes with sky.

**Fallback:** if streaming is too complex for v1, write one decimated, unbundled SOG instead (`-d 25%`, then output `public/model/meta.json`). Aim for about 50 MB total.

**Tip:** `splat-transform` can also read XGRIDS `.lcc` files directly, so the PortalCam export may work as a source too.

**Done when:** every file under `public/model/` is under 100 MB, the full folder is well under GitHub Pages' 1 GB site limit, and it looks right at the stops in the PlayCanvas viewer.

## Stops data format

All tour content lives in `public/stops.json`. The app reads it on load; dev mode writes a new copy for you to commit. Stop 1 (the first entry) is always the overview.

```json
{
  "title": "Goldfield Ghost Town",
  "subtitle": "Apache Junction, Arizona",
  "model": "model/lod-meta.json",
  "stops": [
    {
      "id": "stop-1",
      "title": "Goldfield Ghost Town",
      "description": "Overview of the scanned area.",
      "camera": {
        "position": [12.4, 8.1, -3.0],
        "target":   [0.0, 1.2, 0.0],
        "fov": 60
      },
      "thumbnail": "thumbs/stop-1.webp",
      "drift": "orbit"
    },
    {
      "id": "stop-2",
      "title": "Stop 2",
      "description": "Description 2",
      "camera": { "position": [3.2, 1.7, 4.5], "target": [1.0, 1.5, 0.8], "fov": 55 },
      "thumbnail": "thumbs/stop-2.webp",
      "drift": "sway"
    }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Used for the deep link (`#stop-2`) and thumbnail filename |
| `title` | string | Card heading, max \~40 characters |
| `description` | string | 1–3 sentences, max \~300 characters |
| `camera.position` | \[x, y, z\] | World units of the splat |
| `camera.target` | \[x, y, z\] | Point the camera looks at; orbit pivot |
| `camera.fov` | number | Vertical field of view, degrees |
| `thumbnail` | string | Path relative to `public/` |
| `drift` | `"orbit"` \| `"sway"` \| `"none"` | Idle motion at this stop; optional, default `"sway"` |

Order in the array is tour order. Until poses are captured, ship 10 stops with placeholder text and copies of the overview pose so the UI can be built and tested.

## Viewer and tour behavior

The splat fills the window; the carousel is a translucent rail on the right, about 340 px wide. The scene stays explorable at all times.

```
+--------------------------------------------+-------------+
|                                            |  [ thumb ]  |
|                                            |  Stop 1     |
|              splat (full-bleed)            |  Desc...    |
|                                            |-------------|
|                                            |  [ thumb ]  | <- active card
|                                            |  Stop 2     |    (expanded,
|                                            |  Desc ...   |     accent border)
|                                            |-------------|
| [⌂] Goldfield Ghost Town      [<] 2/10 [>] |  [ thumb ]  |
+--------------------------------------------+-------------+
```

**Carousel**

- One card per stop: thumbnail (16:9), title, description. The active card is expanded and highlighted; others show thumbnail and title only.
- Clicking a card selects it. Scrolling the rail with the mouse wheel snaps to the nearest card and selects it after a short pause (\~250 ms), so fast scrolling does not trigger a flight per card.
- The active card scrolls into view when the stop changes by any route.

**Navigation**

- Previous / Next buttons with a counter ("2 / 10"; the overview counts as 1) bottom-left of the canvas. They loop: Next on the last stop returns to stop 1, and Previous on stop 1 goes to the last stop.
- A Home button at the left of the bar returns to stop 1 (disabled while on stop 1). The `Home` key does the same.
- Left/Right and Up/Down arrow keys do the same as Previous / Next; ignored while typing in a text field.
- Stop ids run `stop-1` … `stop-10`, so the deep link matches the counter.
- URL hash updates on each stop change (`#stop-3`). Loading a URL with a hash starts at that stop without the flight.

**Camera transitions**

- Fly from the current pose to the stop's pose in 1.5–2.5 s, duration scaled by distance, ease-in-out.
- Interpolate the target and position separately so the view turns smoothly. If the straight path is long (over \~15 units), arc upward along the way to avoid passing through buildings.
- A new selection mid-flight starts from wherever the camera is now.
- Mouse drag, wheel or a fly key (WASD/QE) during a flight stops it where it is and hands control to the user; the stop stays selected.
- Respect `prefers-reduced-motion`: replace the flight with a 300 ms cross-fade.

**Idle drift**

- After arriving, start the stop's drift: `sway` = slow side-to-side movement of a few degrees around the target over \~8 s; `orbit` = slow continuous orbit (stop 1, the overview).
- Any user input on the canvas stops the drift and hands control to the user. The active card stays selected; a "Back to view" button on the card returns to the saved pose.

**Loading**

- Show the tour title and a progress indicator while the model loads. Show the carousel as soon as `stops.json` is read so thumbnails appear right away.

## Dev mode

Dev mode is how you author the tour: fly to a view, snap it, type the text, export. It turns on with `?dev=1` in the URL, or the `D` key on `localhost`. It is never shown to visitors unless the query flag is present.

**Controls**

- Free-fly camera: WASD + mouse look, Q/E down/up, Shift for faster movement. Orbit mode stays available.
- A HUD shows the live camera position, target and FOV, plus a FOV slider.
- An edit panel replaces the card text for the active stop: title and description inputs, drift dropdown.

**Actions**

| Action | Key | What it does |
| --- | --- | --- |
| Snap pose | `Space` | Saves the current camera to the active stop and re-renders its thumbnail |
| Add stop | `N` | Inserts a new stop after the active one, using the current pose |
| Delete stop | `Del` | Removes the active stop after a confirm in the panel (no browser dialog) |
| Reorder | `[` / `]` | Moves the active stop up or down |
| Preview | `P` | Plays the transition into the active stop from the previous one |
| Export | `Ctrl+S` | Saves `stops.json` and all thumbnails |

**Thumbnails**

- Rendered from the stop's pose at 640×360, with the UI hidden, encoded as WebP (quality \~0.8). Wait for streamed LOD chunks near the camera to load before capturing.
- Rendered at snap time, not at visitor load time.

**Export**

- Preferred (Chrome/Edge): the File System Access API. The first export asks you to pick the repo's `public/` folder, then writes `stops.json` and `thumbs/*.webp` directly. You review the diff and commit.
- Fallback: download a `.zip` with the same layout to unzip into `public/`.
- Edits are also autosaved to `localStorage` so a page reload doesn't lose work; a "Discard local edits" button reloads from `stops.json`.

## Build order

Ask Claude Code to work through these one at a time and stop for your review after each. Every step ends in something you can see in the browser.

1. **Prepare the model** (Step 0).
   - Done when: `public/model/` meets the Step 0 checks and a size report is printed.
2. **Bare viewer.** Vite + PlayCanvas page that loads the model full-screen with orbit controls.
   - Done when: `npm run dev` shows the town, stays above \~50 fps on your laptop, and the loading indicator works.
3. **Stops + navigation.** Load `stops.json` (10 placeholder stops), Prev/Next buttons, arrow keys, counter, hash deep links. Camera jumps instantly for now.
   - Done when: every route to a stop (button, key, hash) lands on the same pose.
4. **Camera transitions.** Eased flights, arc for long moves, interruptible, reduced-motion fallback.
   - Done when: rapid Next presses never snap, stall or flip the camera.
5. **Carousel.** Side rail with cards, active state, wheel snapping with delay, scroll-into-view.
   - Done when: scrolling the rail and pressing Next stay in sync.
6. **Idle drift + user takeover.** Sway/orbit per stop, stops on input, "Back to view".
   - Done when: drift never fights the user's mouse.
7. **Dev mode.** Free-fly, HUD, snap, add/delete/reorder, text edit, thumbnails, export, autosave.
   - Done when: you can author a stop, export, commit, reload without `?dev=1`, and see it.
8. **Author the real tour.** You fly the scan and capture 8–10 stops with placeholder text.
9. **Deploy** (next section).
   - Done when: the public URL works in a fresh browser profile, including a deep link.

## Deployment to GitHub Pages

Deploy with a GitHub Actions workflow that runs `npm ci && npm run build` and publishes `dist/` using the official Pages actions. Set Vite's `base` to `/<repo-name>/` so asset and model paths resolve on `username.github.io/<repo-name>/`.

- **No Git LFS for the model.** Commit the prepared files as normal Git files; this is why each must be under 100 MB.
- **Limits to stay inside:** published site up to 1 GB, source repo recommended under 1 GB, soft bandwidth of 100 GB per month, deploys time out after 10 minutes ([GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)).
- **Bandwidth check:** at \~100 MB streamed per visit, 100 GB is roughly 1,000 full visits a month. If the tour gets shared widely, move `public/model/` to a CDN or object storage and point `model` in `stops.json` at it.
- **Repo hygiene:** replacing the model often bloats Git history. Settle the model in Step 0 before committing it, and re-prepare rarely.

## Sources

- [splat-transform user guide](https://developer.playcanvas.com/user-manual/splat-transform/)
- [Generating Streamed SOG](https://developer.playcanvas.com/user-manual/splat-transform/streamed-sog/)
- [Streamed SOG format](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/)
- [PlayCanvas GSplatComponent (supported formats)](https://app.unpkg.com/playcanvas@2.21.1/files/build/playcanvas/src/framework/components/gsplat/component.d.ts)
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
