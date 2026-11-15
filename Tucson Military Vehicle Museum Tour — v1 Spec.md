# Tucson Military Vehicle Museum Tour — v1 Spec

Nov 8, 2026 (model replaced Nov 13, 2026) · @Paolo Tosolini

## Overview

v1 is a desktop web page that shows a Gaussian splat scan of the Tucson Military Vehicle Museum hangar full-screen with a 3D drum carousel of 8–10 stops on the right. Selecting a stop flies the camera to a saved viewpoint; each stop is a thumbnail with a short title (no description text in v1). It is built with Claude Code and hosted on GitHub Pages.

**In scope**

- Full-screen splat viewer with free orbit/fly controls
- Stop 1: an overview of the hangar
- Stops 2–N: one per vehicle, titled with its name (e.g. "T-34/85"); placeholders until authored
- Vertical 3D drum carousel on the right: one thumbnail per stop with its title over the image
- Previous / Next buttons and arrow keys (looping), Home button back to the overview
- Smooth camera move between stops, slow idle drift at each stop
- Deep link per stop (`#stop-3`)
- Dev mode to capture poses, type text, and export `stops.json` + thumbnails

**Out of scope for v1:** mobile layout, audio, archival media, gamification, hotspots placed in 3D, written history text.

## Tech stack and repo structure

Use the PlayCanvas Engine with Vite and plain TypeScript, no UI framework. SOG is PlayCanvas's native format, and its `gsplat` component loads `.sog`, unbundled `meta.json` and streamed `lod-meta.json` ([engine docs](https://app.unpkg.com/playcanvas@2.21.1/files/build/playcanvas/src/framework/components/gsplat/component.d.ts)). Claude Code should check the current PlayCanvas docs and examples for exact camera and loading APIs rather than rely on memory.

```
Claude - 3DGS/            # working folder = git repo root
├── source/               # NOT committed (.gitignore)
│   └── tucson/           # the scan exports (zips + unzipped)
│       ├── ply/point_cloud/iteration_100/   # input to Step 0
│       │     point_cloud.ply, point_cloud_1…5.ply, environment.ply
│       └── lcc2/          # LCC2 export; info/poses.json = capture path
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

`source/` is in `.gitignore`, which keeps the large originals out of Git; only the prepared output under `public/model/` is committed. The folder name contains spaces, so scripts must quote paths. The GitHub repo is `paolotosolini/tucson-military-vehicles` (public), which makes the site `paolotosolini.github.io/tucson-military-vehicles/` and Vite's `base` `/tucson-military-vehicles/`. All folder names are lowercase.

## Step 0: prepare the model

Convert the scan to **Streamed SOG** with PlayCanvas's `splat-transform` CLI. This keeps full detail near the camera, splits the model into many small files that fit GitHub's 100 MB per-file limit, and loads progressively.

The source is the PortalCam / LCC Studio **PLY export** (13.9M splats, SH degree 0, Z-up, metres). It already contains six detail levels, `point_cloud.ply` then `point_cloud_1…5.ply` (each about half the previous), which map straight onto Streamed SOG LOD levels 0–5, so no decimation is needed.

**Cropping.** The scan is entirely indoors, so `tools/crop-scan.mjs` first crops every level to the inside of the hangar: an oriented box around the walls (0.8 m margin), from just under the floor up to y = 2.9, which removes the roof, the hanging lights and ducts, and all noise outside the building. `environment.ply` (a distant sky shell) is left out. The hall's box is measured from the scan: centre (x −5.6, z 32.19), long axis at −76.1° from +X towards +Z, walls at −31.0 / +34.5 m along and −18.5 / +17.8 m across. With no roof, eye-level views show the background colour above the walls, and the hall can be viewed cleanly from above.

Each input is rotated +90° about X to make it Y-up for PlayCanvas; the viewer applies no further rotation, so stop poses are plain world coordinates. `tools/prepare-model.sh` runs the crop and then ([Streamed SOG format](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/), [guide](https://developer.playcanvas.com/user-manual/splat-transform/streamed-sog/)):

```bash
npm install -g @playcanvas/splat-transform
C=source/tucson/cropped
splat-transform \
  $C/point_cloud.ply   -r 90,0,0 -l 0 \
  $C/point_cloud_1.ply -r 90,0,0 -l 1 \
  …                                   \
  $C/point_cloud_5.ply -r 90,0,0 -l 5 \
  public/model/lod-meta.json --filter-nan --filter-harmonics 0
```

The model is written in small streaming chunks (`--lod-chunk-count 128 --lod-chunk-extent 8`, about 1.7 MB each), so a view fetches full detail only near the camera, and the viewer aims for 2.5M splats on screen. Measured at stop 6: 58 MB until fully sharp, versus 120 MB with the default 512K-splat chunks and a 4M budget, with the same close-up look.

Result: 259 MB in 907 files, largest under 2.2 MB.

World facts: the hangar floor is at y ≈ −1.4 and the roof at y ≈ 5.5–6, so eye height is y ≈ 0.2. The hall runs along +Z (roughly x −20…5, z 0…61 along the capture path). The roof is cropped away, so overview poses can be above the hall, e.g. position (−26, 32, −6) looking at (−5.6, −1.4, 32).

**Done when:** every file under `public/model/` is under 100 MB, the full folder is well under GitHub Pages' 1 GB site limit, and it looks right at the stops in the PlayCanvas viewer.

## Stops data format

All tour content lives in `public/stops.json`. The app reads it on load; dev mode writes a new copy for you to commit. Stop 1 (the first entry) is always the overview.

```json
{
  "title": "Tucson Military Vehicle Museum",
  "subtitle": "Tucson, Arizona",
  "model": "model/lod-meta.json",
  "stops": [
    {
      "id": "stop-1",
      "title": "Museum overview",
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
| `title` | string | Shown over the card's thumbnail and in the bottom bar, max \~30 characters |
| `description` | string | Optional, not shown in v1 (kept so text can return later) |
| `camera.position` | \[x, y, z\] | World units of the splat |
| `camera.target` | \[x, y, z\] | Point the camera looks at; orbit pivot |
| `camera.fov` | number | Vertical field of view, degrees |
| `thumbnail` | string | Path relative to `public/` |
| `drift` | `"orbit"` \| `"sway"` \| `"none"` | Idle motion at this stop; optional, default `"sway"` |

Order in the array is tour order. Until poses are captured, ship 10 stops with placeholder text and copies of the overview pose so the UI can be built and tested.

## Viewer and tour behavior

The splat fills the window over a near-black background (#09090a), with a soft vignette around the edges (an overlay above the canvas, so thumbnails stay clean). The museum name and "Tucson, Arizona" sit small and persistent at the top-left (hidden in dev mode, where the HUD takes that corner). The carousel floats over the right side, about 340 px wide, on a dark band (86% black at the edge, fading out to the left) so it reads apart from the scan; its titles can't be text-selected by dragging. The scene stays explorable at all times.

```
+--------------------------------------------+-------------+
|                                            |   /thumb\   |  <- cards above tilt
|                                            |  [ thumb ]  |     away on the drum
|              splat (full-bleed)            | [[ thumb ]] |  <- active card: facing
|                                            | [[Title  ]] |     you, accent border
|                                            |  [ thumb ]  |
| [⌂] Stop title             [<] 2/10 [>]    |   \thumb/   |
+--------------------------------------------+-------------+
```

**Carousel**

- Cards sit on a vertical drum (a cylinder rolling around a horizontal axis), about 24° apart, turned slightly inward to face the middle of the screen. About five cards are visible; the active one faces the viewer at the centre.
- Each card: 16:9 thumbnail, the stop number top-left, and the title over the bottom of the image on a dark gradient. The active card has an accent border.
- Tapping or clicking any visible card selects it.
- Wheel, trackpad and vertical drag spin the drum with light physics: a spring follows the input, a released drag coasts briefly (~0.1 s), and the drum settles on a whole card. One mouse-wheel notch moves one card. The card it comes to rest on is selected as it settles, so a fast spin never flies the camera to every card it passes.
- Next / Prev / arrow keys / Home spin the drum to the active card the short way round; looping rolls straight on from the last stop to the first.
- With `prefers-reduced-motion`, the drum is replaced by a plain vertical list.
- The bottom bar shows the active stop's title (stop 1's title on the overview) next to the counter.

**Navigation**

- Previous / Next buttons with a counter ("2 / 10"; the overview counts as 1) bottom-left of the canvas. They loop: Next on the last stop returns to stop 1, and Previous on stop 1 goes to the last stop.
- A Home button at the left of the bar returns to stop 1 (disabled while on stop 1). The `Home` key does the same.
- Left/Right and Up/Down arrow keys do the same as Previous / Next; ignored while typing in a text field.
- Stop ids run `stop-1` … `stop-10`, so the deep link matches the counter.
- The address bar is not updated while browsing, so a reload always starts at the overview (stop 1). A deep link (`#stop-3`) opens that stop once (no flight), then the hash is removed from the address bar.

**Camera transitions**

- Fly from the current pose to the stop's pose in 1.5–2.5 s, duration scaled by distance, ease-in-out.
- Interpolate the target and position separately so the view turns smoothly. If the straight path is long (over \~15 units), arc upward along the way to avoid passing through buildings.
- A new selection mid-flight starts from wherever the camera is now.
- Mouse drag, wheel or a fly key (WASD/QE) during a flight stops it where it is and hands control to the user; the stop stays selected.
- Respect `prefers-reduced-motion`: replace the flight with a 300 ms cross-fade.

**Idle drift**

- After arriving, start the stop's drift: `sway` = a gentle ±1.5° side-to-side movement around the target over \~14 s; `orbit` = slow continuous orbit, 2°/s.
- Any user input on the canvas stops the drift and hands control to the user. The active card stays selected; a "Back to view" button on the card returns to the saved pose.

**Camera limits**

- The camera can't go below 30 cm above the floor (world y −1.1), whether orbiting, panning or flying; orbiting can tilt at most 15° upward, so it can't swing round underneath the scene.

**Walk mode**

- A **Walk** button in the bottom bar switches walk mode on and off. It starts where the camera is, keeping its direction, tilt and field of view (only the eye height eases to 1.6 m above the floor); from high up (the overview) it flies down to the floor first. Switching it off leaves the camera where it is.
- Point at the floor: a thin white ring shows where you'd go, only on floor you could stand on. Click to walk there (straight line, no route-finding). Drag to look around; WASD to walk, Shift to run, Esc to stop. Picking a stop leaves walk mode.
- Collision uses a 10 cm voxel grid built from the cropped scan by `tools/prepare-model.sh` (`public/collision/`, ~1 MB) and read with PlayCanvas's `VoxelOccupancy`, no physics engine: gravity onto the floor, step-ups to 45 cm, a 30 cm-radius body that slides along walls. The grid is in splat-transform's frame, the world turned 180° about Z.

**Credit**

- "Created by Paolo Tosolini", small at the bottom-right.

**Opening (splash screen)**

- A full-screen splash covers everything, carousel included, while the scan loads: the start stop's thumbnail blurred and darkened behind the museum name and location, three short hints with icons (scroll the cards on the right to visit each vehicle · drag to look around, scroll to zoom · Walk to explore on foot), and a progress bar.
- The bar covers the coarse scan (first ~35%), then the first view sharpening. When the first view is fully sharp, an ENTER button replaces the bar. If that takes longer than 10 s, ENTER appears anyway with "Detail is still loading. You can enter now." The whole model is never waited for.
- After ENTER, the **assembly reveal** plays (PlayCanvas's `reveal-radial` effect, tinted gold): the scan starts empty, gold sparks ripple outward across the floor from where the start view looks, and a warm wave about a second behind grows them into the full scan (whole hall in ~4.5 s). Meanwhile the camera cranes in over 4.5 s from ~3–8 m further back, 2.5 m higher and a slightly wider lens to the stop's view, where its idle drift starts. The title, nav bar, credit and carousel (sliding in from the right) arrive after ~2.6 s. With `prefers-reduced-motion`, no reveal or crane: a plain fade. Arrow keys do nothing while the splash is up.
- First visit only: a tip next to the carousel, "Scroll or click a card to visit a vehicle", goes away on first use (or after 12 s) and is remembered in `localStorage`.
- Deep links (`#stop-5`) get the same splash and reveal with that stop's image and view. Dev mode skips the splash.

## Dev mode

Dev mode is how you author the tour: fly to a view, snap it, type the text, export. It turns on with `?dev=1` in the URL, or the `` ` `` (backtick) key on `localhost`, which reloads the page with or without the flag. (`D` was the original idea, but it is also "strafe right" when flying.) It is never shown to visitors unless the query flag is present.

**Controls**

- Free-fly camera: WASD, Q/E down/up, Shift for faster movement. Mouse (everywhere, not only dev mode): left-drag orbits, right-drag moves (pans) the model, middle-drag looks around. Idle drift is off in dev mode.
- A HUD shows the live camera position, target and FOV, plus a FOV slider.
- The HUD includes an editor for the active stop: title input (max 30 characters) and drift dropdown, with Delete.

**Actions**

| Action | Key | What it does |
| --- | --- | --- |
| Snap pose | `Space` | Saves the current camera to the active stop and re-renders its thumbnail |
| Add stop | `N` | Inserts a new stop after the active one, using the current pose |
| Delete stop | `Del` / `Backspace` | Removes the active stop after a confirm in the panel (no browser dialog) |
| Reorder | `[` / `]` | Moves the active stop up or down |
| Preview | `P` | Plays the transition into the active stop from the previous one |
| Export | `Ctrl+S` | Saves `stops.json` and all thumbnails |

**Thumbnails**

- Rendered from the stop's pose at 640×360, with the UI hidden, encoded as WebP (quality \~0.8). Wait for streamed LOD chunks near the camera to load before capturing.
- Rendered at snap time, not at visitor load time.

**Export**

- Changes save automatically: about a second after any edit (snap, title, drift, add, delete, reorder) dev mode writes `stops.json` and the thumbnails into `public/`, and the HUD shows "✓ Saved to project". The Save button / `Ctrl+S` saves immediately. Exit warns if something didn't save.
- Typing in dev-mode text fields never moves the camera (key presses from inputs are kept away from the camera controls).
- Preferred (`npm run dev`): the dev server has a small save endpoint (dev only, never in the build) that writes `stops.json` and `thumbs/*.webp` straight into `public/`. You review the diff and commit.
- Otherwise (Chrome/Edge): the File System Access API, picking the repo's `public/` folder once.
- Last resort: download a `.zip` with the same layout to unzip into `public/`.
- Edits are also autosaved to `localStorage` so a page reload doesn't lose work; a "Discard local edits" button (click twice) reloads from `stops.json`. Local edits only load with `?dev=1`; visitors always get the committed `stops.json`.
- "Re-render all thumbnails" (under More) recaptures every stop from its saved pose, e.g. after re-preparing the model.
- On export, stop ids are renumbered to match the order and thumbnails of deleted stops are removed from `thumbs/`.

## Build order

Ask Claude Code to work through these one at a time and stop for your review after each. Every step ends in something you can see in the browser.

1. **Prepare the model** (Step 0).
   - Done when: `public/model/` meets the Step 0 checks and a size report is printed.
2. **Bare viewer.** Vite + PlayCanvas page that loads the model full-screen with orbit controls.
   - Done when: `npm run dev` shows the hangar, stays above \~50 fps on your laptop, and the loading indicator works.
3. **Stops + navigation.** Load `stops.json` (10 placeholder stops), Prev/Next buttons, arrow keys, counter, hash deep links. Camera jumps instantly for now.
   - Done when: every route to a stop (button, key, hash) lands on the same pose.
4. **Camera transitions.** Eased flights, arc for long moves, interruptible, reduced-motion fallback.
   - Done when: rapid Next presses never snap, stall or flip the camera.
5. **Carousel.** 3D drum of title-only cards, active state, wheel/drag physics with select-on-settle, tap to select.
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
