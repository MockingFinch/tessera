# Tessera — design notes

Why Tessera looks and moves the way it does. `SPEC.md` is the engineering contract and
`ARCHITECTURE.md` explains how the code fits together. This document records the product and
design decisions, so that later changes keep to them.

## The one job

> *See what's taking up space.*

Everything in Tessera serves that sentence. SpaceSniffer showed the right idea, a nested treemap
that makes size physical, but it wraps that idea in filters, tags, exports and settings. Tessera
keeps the idea and drops the rest. If a feature doesn't help someone see or act on what's
filling their disk, it doesn't ship.

### What ships

| Moment | What you get |
|---|---|
| Choose | A welcome screen with three or four big cards (Macintosh HD with its free space, Home, any external drives, Choose Folder…). You can also drop a folder anywhere on the window. |
| Watch | The map assembles **while** the scan runs. You never stare at a progress bar. |
| Explore | Double-click (or ⌘↓, Return, pinch) to dive into a folder. Go back with ⌘↑, Esc, Backspace, the chevron or the breadcrumbs. The arrow keys walk between neighbours. |
| Understand | Color means kind. A readout under the map names whatever you point at. The legend isolates a kind when you hover it, and locks it when you click it. |
| Act | Quick Look (Space), Reveal in Finder, Copy Path, Move to Trash. They live in the native context menu and the Edit menu. Trash always asks first and can always be undone. |

### What was left out, on purpose

| Cut | Why |
|---|---|
| Filter query language, tags, saved views | Power-user scaffolding for a tool you open for two minutes a month. Hover and the legend answer "what is this?" without any syntax. |
| Permanent delete | Moving to the Trash is reversible. A disk tool that can destroy data on one misclick does not deserve trust. |
| Settings window | There's nothing to set. Language lives in View → Language. |
| List or outline view | A list is what Finder already does. The treemap is the product. |
| Exports and reports | Not part of "see what's taking up space". |
| Light appearance | Tessera is dark only. See *Appearance* below. |
| Live file watching | You rescan with ⌘R. Watching a whole disk costs a lot and the result would barely change. |

## Chrome: one surface

- **There is no visible title bar.** The window uses `hiddenInset` with the traffic lights at (20, 20). The 52 px toolbar shares one vibrancy material with the content: no divider, no second color, no shadow line. The toolbar holds only the back chevron, the breadcrumbs, a quiet status line (*items · size*), Rescan and Locations.
- **The map gets everything else.** It has a 14 px gutter on the sides. Under it is one infobar line: the readout on the left, the legend chips on the right. Chips show no numbers; hovering one writes that kind's total into the readout. That keeps the chrome down to a single line of text.
- **The selection ring** uses the system accent color with a 4 px dark halo, so it stays readable against any tile. The canvas extends 8 px past the map on every side, so a ring on a tile touching the map's edge is drawn in full rather than clipped.
- **Native wherever it counts:** the application menu, context menus, the confirmation sheet, Quick Look and the About panel are all real macOS components. They're never HTML imitations.

## The map

- **Squarified layout**, sorted by size and nested up to **4 levels**. The view the renderer asks for is pruned to what can be seen: anything under about 56 px² (`minFrac`) or beyond 260 children folds into one *"smaller items"* tile.
- **Depth sets the rhythm.** Gaps (3 → 1 px), corner radii (7 → 2 px), headers (24 → 15 px) and padding all shrink as you go deeper. The eye reads the structure without any outline lines.
- **Folders are faint containers** (white at 5.5%) with a header for the name and size. **Files are solid tiles** of their kind's color, lit by a soft top-to-bottom gradient and a 1 px rim, so they read as objects rather than paint.
- **"Smaller items" is a mosaic.** It's a fine grid of tiny tesserae in the dominant kind's color. A folder of 2,000 thumbnails still reads as *photos* at a glance. The scanner works out that dominant kind from the bytes folded into the tile.
- **Labels only appear when they fit.** A name and size go in a file tile if there's room. An aggregate gets a pill badge (*"1,800 items"*). Headers truncate with an ellipsis. No label ever overflows its tile.

## Color

Color has **one job: identity (kind)**. It never encodes size or rank. Size is the area.

| Kind | Color | Kind | Color |
|---|---|---|---|
| Apps | `#2184be` | Archives | `#bf8910` |
| Video | `#7f4fd9` | Developer | `#158000` |
| Photos | `#d73910` | System | `#6b6b73` (neutral) |
| Audio | `#c9489e` | Other | `#4e4e55` (neutral) |
| Documents | `#0aad87` | | |

- **Validated, not eyeballed.** In a treemap *any* two kinds can end up side by side, so the seven hues are checked across **all pairs** against the window surface (`#232326`), using the dataviz palette validator (OKLab ΔE×100):
  - **Normal vision:** the worst pair is ΔE **16.7**, which passes the hard floor of 15.
  - **Colour-blind (deutan, protan, tritan):** the worst pair is ΔE **7.7**. That's inside the 6–8 band, which is allowed only with secondary encoding.
  - **Lightness, chroma, contrast:** all inside the band, and every hue is at least 3:1 against the surface.
- **History.** The first palette failed this badly. Developer green and Documents teal were ΔE 8.2 apart even for full color vision, and teal against pink collapsed to ΔE 1.6 under deuteranopia. The current values came out of an optimiser that may shift each hue by no more than 18° and searches lightness and chroma for the best worst-case pair.
- **Secondary encoding, so identity never rests on color alone:**
  - direct labels on every tile big enough to hold one;
  - a readout that names the kind of whatever is hovered;
  - legend hover/click isolation, which dims every other kind's files to 18%;
  - 2–3 px gaps between all tiles;
  - mosaic texture for aggregates.
- **Close shades.** Each kind has six lightness-only shades. A tile picks its shade by hashing its key, so neighbours of the same kind still read as separate objects. The hue never changes.
- **Text is never colored by kind.** Labels choose black or white ink from the tile's luminance. Legend text stays in label grey, and the swatch carries the color.

If you change the palette, re-run the validator with `--pairs all --mode dark --surface "#232326"`.

## Motion

Motion explains structure: where things came from, where they went, and what's inside what.
It is never decoration.

### Springs, not tweens

Every tile has nine animated channels: x, y, w, h, opacity and RGBA. Each channel is a
**critically damped analytic spring**, so nothing bounces or overshoots. A new target set
mid-flight simply redirects the motion, keeping the velocity it already has. Each kind of change
has its own "response", the time to settle:

| Change | Response |
|---|---|
| First reveal | 0.90 s, staggered by rank and depth (up to 0.5 s) |
| Live scan update | 0.62 s, every 950 ms |
| Zoom | 0.56 s |
| Move to Trash | 0.50 s |
| Window resize | 0.22 s |

**Opacity runs on a spring 2.4× faster than geometry.** Tiles decide early whether they're
there or gone. The eye follows shapes, not long cross-fades.

### Zoom is a camera move

- **One anchor drives everything.** When you dive into a folder, that tile is the anchor. Zooming in, its rect grows from its old position to fill the map. Zooming out, the old root shrinks into its new place. Everything without a surviving ancestor moves by the same affine transform. Siblings fly off screen together, and new neighbours arrive from outside it, as if the camera moved.
- **Departing tiles** follow their nearest surviving ancestor, then fade. **Arriving tiles** start at the spot their ancestor occupied and grow with it.
- **Hand-offs.** A zoom re-lays the folder out for a new shape, so a few tiles end up far from where the camera alone would carry them. Sliding them there would drag them through their neighbours. When a tile's new place overlaps its camera-carried place by less than half (IoU < 0.5), it hands off instead, and so does everything inside it:
  - the old tile rides the camera as a ghost and fades out;
  - a fresh one fades in, already in place.
- **The swap happens while tiles are small.** Zooming in, it happens immediately. Zooming out, opacity is held for 30% of the response, so the swap lands late.
- **Each folder clips its children.** Drawing goes in tree order, and each subtree is clipped to its parent's rounded rect. Even mid-flight, a folder's contents never stray outside it or mix with a sibling's.

### Small motions

- **Labels step aside while a tile moves.** Text fades in proportion to the tile's speed and returns when it lands. Moving text is unreadable and only adds noise.
- **Hover** brightens the tile under the pointer and, more faintly, its parent folders (smoothed at about 45 ms). Legend dimming eases in about 70 ms.
- **The selection ring** fades in about 60 ms and follows its tile through any motion.
- **The welcome cards** rise in sequence, 60 ms apart, on the system ease-out curve.
- **Reduced Motion** shortens every spring to 45% of its response and turns off the reveal stagger. Structure still animates, but briefly.

## Appearance: dark only

Tessera has one appearance. Main sets `nativeTheme.themeSource = 'dark'`, so the window
material, menus, sheets and context menus are all dark whatever the system setting is.

- **The map is the content, and it's made of color.** Saturated tiles on a dark surface have the most room for lightness and contrast. On a light surface the same palette needs either washed-out tints or heavy outlines.
- **One appearance means one palette.** It can be validated and tuned properly instead of being a compromise between two backgrounds.
- **Disk tools are for focus.** A dark, quiet frame lets the data be the only bright thing on screen.

## Language

- **English by default, with Simplified Chinese.** You switch under View → Language. The choice is saved to `settings.json`, and the menus, context menus, sheets and the whole renderer re-translate live, with no reload.
- **Chinese follows macOS's own vocabulary:** 访达, 废纸篓, 快速查看, 个人文件夹, 移到废纸篓, 进入全屏幕. Tessera should read like it ships with the OS.
- **Numbers and sizes** go through `Intl` for the active locale. Sizes are decimal (KB/MB/GB = 1000ⁿ), as Finder uses.

## Performance as design

A disk tool that stutters feels broken, so speed is part of the design:

- **The scan runs off the main thread.** A dedicated `utilityProcess` does a breadth-first async walk, so the picture fills in evenly instead of drilling down one folder at a time. Cancelling a scan just kills that process.
- **Views are cheap.** The renderer asks for a pruned view (depth 4, `minFrac`, at most 260 children). Building one takes about **0.1 ms** for a tree of 467k files.
- **Drawing is plain canvas 2D.** There's no DOM per tile. The frame loop runs only while something is moving, and an idle map costs nothing.
