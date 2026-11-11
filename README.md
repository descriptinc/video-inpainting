# Video Inpainting — project page

Self-contained static site for video inpainting with Anchored Tree Sampling
([ATS](https://descriptinc.github.io/ATS/)). No build step. A companion to the
[Video Outpainting](https://descriptinc.github.io/video-outpainting/) page; the
player, generating overlay, and ATS figure are the same components, with the
overlay drawn inside the mask instead of outside the source frame.

## Files
- `index.html` — the page
- `styles.css` — shared component styles (same file as the sibling project pages)
- `inpaint.css` — styles specific to this page (player, clip picker, ATS tree figure)
- `main.js` — interactions; `CLIPS` and `MEDIA` at the top list every clip
- `scripts/prepare_media.sh` — encodes outputs for the web and grabs posters
- `media/` — `<id>.mp4` (gitignored, served from GCS) and `posters/<id>.jpg` (committed)
- `.nojekyll` — tells GitHub Pages to serve files as-is

## Media

### Hero
Encode the output and grab its poster:

```bash
scripts/prepare_media.sh vivaldi=../final_ltx_vids/vivaldi_inpaint_full.mp4
```

Only the output is needed: the "Input" view covers the masked region with the
generating overlay, and everything outside it passes through the inpainter
untouched. The hero's `CLIPS` entry lists its frame size and the masked region
as `box` (`[x, y, w, h]` fractions of the frame).

### Examples
Examples step through Original → Masked → Inpainted, so each needs its source,
output, and mask (white where the region is regenerated; it can move per frame).
Pack them into one frame-locked video and poster:

```bash
scripts/prepare_example.sh <id> source.mp4 output.mp4 mask.mp4
```

Then add `<id>` to `CLIPS` (with `out` set to the panel size the script prints)
and to `MEDIA.examples`, replacing a placeholder. The Examples section stays
hidden while `MEDIA.examples` is empty.

Upload the encoded videos to the bucket the page reads from when deployed:

```bash
gcloud storage cp media/*.mp4 gs://lyrebird-research-web-demos/video-inpainting/
```

## Local preview
On localhost the page plays videos from `media/` instead of GCS. Use a server
that supports HTTP range requests (so the videos can seek):

```bash
npx http-server -p 8768 -c-1 .
# → http://localhost:8768/
```

## Deploy to GitHub Pages
Push to `main` and enable Pages. If the repo isn't named `video-inpainting`,
update the GCS folder in `main.js` (`MEDIA_BASE`) and the citation URL in
`index.html`.
