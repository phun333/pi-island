# Autoresearch: pi-island prompt image attachments

## Objective
Fix pi-island's prompt/hover handling when a user attaches or pastes an image into a prompt. The island should render the image as an attachment thumbnail, not leave only a local temp path such as `/var/.../clipboard-....png` visible in the prompt preview. Slash/skill prompts and paths with spaces must work.

## Metrics
- **Primary**: failures (unitless, lower is better) — failing assertions from `./.auto/measure.sh`.
- **Secondary**: tests — number of assertions executed.

## How to Run
`./.auto/measure.sh` — builds a temporary probe module from `pi-extension/index.ts`, stubs pi UI imports, and outputs `METRIC failures=number` and `METRIC tests=number`.

## Files in Scope
- `pi-extension/index.ts` — prompt text normalization, image path extraction, prompt image payload creation, event wiring.
- `pi-extension/island.html.mjs` — rendering for prompt hover and thumbnail tiles if needed.
- `pi-extension/companion.mjs` — socket row state forwarding if needed.
- `README.md`, `AGENT.md` — docs if behavior changes.
- `.auto/*` — benchmark/playbook files.

## Off Limits
- Do not modify benchmark expectations just to make failures disappear.
- Do not remove real image handling or fake metric output.
- Do not touch native host binaries or generated build artifacts.

## Constraints
- Preserve existing prompt-hover UX and direct `evt.images` handling.
- Support local image paths from clipboard/paste flows: `/var/.../clipboard.png`, `file://` URLs, paths with literal spaces, quoted paths, and extensionless sniffable images.
- Avoid overfitting to the one user path; keep tests covering generalized prompt/path shapes.
- No new runtime dependencies.

## What's Been Tried
- Initial dirty working tree already contains image thumbnail support and hover prompt reveal. Current suspected gap: slash/skill prompts plus unquoted paths with spaces can be parsed as a bogus path starting at `/skill:...`, and displayed prompt text still includes local image paths instead of hiding them once rendered as thumbnails.
- Kept `acdfc01`: required prompt image paths to be real files, scanned from each path-looking prefix before known image extensions so `/skill:... /tmp/Screen Shot.png` resolves to the real file, and added `normalizePromptForDisplay()` so rendered local image paths are removed from hover text. Original 8-check workload is now 0 failures.
- Expanded the workload with generalized edge cases (file URLs with escaped spaces, shell-escaped spaces, and parenthesized paths) to guard against overfitting to a single `/var/.../clipboard.png` example. This found one remaining issue: doubled/backslash-escaped paths with spaces failed extraction.
- Kept `b8e55ee`: `unescapeShellPath()` now treats one-or-more backslashes before escapable POSIX characters as an escape sequence, so shell/double-escaped image paths with spaces render as thumbnails and disappear from hover prompt text. Expanded 11-check workload is now 0 failures.
- CLI/file-argument image attachments put a `<file name="/path/to/image.png"></file>` marker in prompt text while also passing `evt.images`. This exposed two failures: duplicate thumbnail/count and leftover `<file name= ></file>` hover markup.
- Kept `af949dd`: detects image `<file name=...></file>` tags, removes whole image tags from `normalizePromptForDisplay()`, and skips matching file-tag fallback paths when direct `ImageContent` payloads already cover those attachments. CLI file-tag workload is now 0 failures across 14 checks.
- Surrounding wrappers such as `(...)` or `<...>` were left behind as empty UI clutter after removing local image paths from hover text; e.g. `look at (/tmp/a.png)` displayed as `look at ( )`.
- Kept `31fefc0`: `normalizePromptForDisplay()` now removes empty `()`, `[]`, `{}`, and `<>` after image path/tag elision. Clean-wrapper workload is now 0 failures across 15 checks.
- Markdown image syntax such as `![bug](/tmp/screenshot.png)` or `![bug](</tmp/Screen Shot.png>)` already rendered thumbnails but left hover clutter like `![bug]` / `![bug]( )`.
- Kept `ec0eca3`: `normalizePromptForDisplay()` now replaces image Markdown whose target resolves to a local image path with its trimmed alt text before generic path/tag elision. Markdown image workload is now 0 failures across 17 checks.
- Markdown local-image references can appear as normal links (`[screenshot](/tmp/a.png)`) or use filenames containing parentheses (`![shot](/tmp/Screen Shot (1).png)`). The simple Markdown cleanup stopped at the first `)` and left `![shot]`/`[shot]` clutter even though thumbnail extraction succeeded.
- Kept `c7b8376`: Markdown cleanup is now path-match based. It finds resolved local image path matches inside surrounding `!?[label](<path>)` wrappers and replaces the whole wrapper with the trimmed label. Markdown link/parenthesized-filename workload is now 0 failures across 19 checks.
- Duplicate Markdown references to the same local image path (for example before/after labels pointing at the same pasted temp image) did not duplicate thumbnails, but display cleanup removed only the first wrapper because path matches were de-duped by resolved path.
- Kept `2b3d91f`: `extractPromptImagePathMatches()` now supports `opts.dedupe=false` with span-level duplicate suppression. Display-only Markdown cleanup uses non-deduped matches so every wrapper is cleaned, while thumbnail extraction still uses default de-duped matches. Duplicate Markdown workload is now 0 failures across 20 checks.
- Relative-to-temp paths initially passed, but that test was weak because `../../var/...` can be recognized by matching an absolute suffix. Strengthened workload used a cwd-contained `./.auto/tmp-rel-images-*/relative Screen Shot.png` so success required true relative-path extraction and display elision.
- Kept `ce41edd`: explicit `./` and `../` image paths are now recognized in extraction regexes and resolved against `process.cwd()` in `normalizePromptImagePath()`. Bare filenames are still ignored to avoid probing arbitrary prompt words. Cwd-relative workload is now 0 failures across 22 checks.
- Duplicate raw references to the same image path may appear in different textual forms (literal spaces and shell-escaped spaces). Thumbnail extraction de-duped correctly, but hover display removed only the first raw occurrence because generic path elision used de-duped matches.
- Kept `afe9383`: final raw path elision in `normalizePromptForDisplay()` now uses `extractPromptImagePathMatches(display, { dedupe: false })`, so every textual occurrence is removed while thumbnail extraction still de-dupes by resolved path. Duplicate raw path variants workload is now 0 failures across 23 checks.
- Rich clipboard / issue content can include HTML image tags such as `<img src="/tmp/shot.png" alt="bug">`. Thumbnail extraction already saw the local `src`, but hover display left broken `<img src= alt=...>` markup.
- Kept `a811b71`: added `normalizeHtmlLocalImageTagsForDisplay()` and `htmlAttrValue()` so local `<img ...>` tags are replaced with trimmed `alt` text before generic path/tag elision. HTML img workload is now 0 failures across 25 checks.
- Pi's path UX often uses `@path` syntax. `@/tmp/shot.png` and `@./shot.png` rendered thumbnails but hover display removed only the path portion and left stray `@` characters.
- Kept `b83178e`: `normalizePromptImagePath()` strips leading `@` only when immediately followed by a supported path prefix, and extraction regexes include optional `@` in raw spans so display elision removes the whole token. @-prefixed workload is now 0 failures across 27 checks.
- Rich clipboard / issue content can link to local screenshots with HTML anchors (`<a href="/tmp/shot.png">screenshot</a>` or `href="file://..."`). Thumbnail extraction saw the href path, but hover display left broken `<a href= >text</a>` markup.
- Kept `9bb82fd`: added `normalizeHtmlLocalImageAnchorsForDisplay()` so local-image `<a href=...>...</a>` tags are replaced with stripped inner link text before generic path elision. HTML anchor workload is now 0 failures across 29 checks.
- Rich HTML image markup may use `srcset` instead of `src` (`<img srcset="/tmp/shot.png 1x" alt="bug">`). Thumbnail extraction saw the path, but hover display left broken `<img srcset=" 1x" alt="bug">` markup.
- Kept `12b0261`: added `htmlSrcsetHasLocalImage()` and taught `normalizeHtmlLocalImageTagsForDisplay()` to treat local `srcset` candidates like `src`, replacing the tag with trimmed `alt` text. HTML img srcset workload is now 0 failures across 30 checks.
- HTML `<picture>` markup may include `<source srcset="/tmp/shot.png 1x">` or `<source src="/tmp/shot.png">` entries. Thumbnail extraction saw these paths, but hover display left broken `<source srcset=" 1x" ...>` / `<source src= ...>` markup.
- Kept `99382fa`: added `normalizeHtmlLocalImageSourceTagsForDisplay()` so `<source>` tags whose `src` or `srcset` resolves to a local image are removed from hover display before generic path elision. HTML source workload is now 0 failures across 32 checks.
- HTML `srcset` can include multiple local candidates for the same semantic image (`1x`, `2x`). Baseline counted each density candidate as a separate thumbnail even though hover display was clean.
- Kept `dfd2405`: added `htmlSrcsetLocalImagePaths()` and `extractHtmlImageCandidateGroups()`; `normalizePromptImages()` now keeps only the first local path inside each multi-candidate `img`/`source` tag. Multi-candidate srcset workload is now 0 failures across 33 checks.
- Some clipboard/browser flows produce percent-encoded local paths without a `file://` prefix, e.g. `/tmp/Screen%20Shot.png`. Baseline treated `%20` as a literal filename and failed to render/sanitize.
- Kept `33d0fd0`: `normalizePromptImagePath()` now first tries the literal resolved path, then falls back to `decodeURI(s)` only when the literal path fails and the token contains percent escapes. Percent-encoded local path workload is now 0 failures across 34 checks.
- Local image paths copied from browser/devtools may include query strings or fragments (`/tmp/shot.png?cache=123#frag`). Baseline rendered the base thumbnail but hover display left `?cache=123#frag`, and Markdown cleanup failed to collapse to alt text.
- Kept `75186d0`: `normalizePromptImagePath()` now tries literal/decoded lookup first, then falls back to the base before `?`/`#`; image-extension raw spans include optional query/fragment suffixes so display cleanup removes the complete token. Query/fragment workload is now 0 failures across 36 checks.
- HTML `<picture>` blocks combine `<source>` and `<img>` alternatives for one semantic image. Baseline counted source+img as duplicate thumbnails and left `<picture> alt </picture>` wrapper markup.
- Kept `81b4c28`: added `htmlLocalImagePathsFromTag()`, picture-level candidate grouping in `extractHtmlImageCandidateGroups()`, and `normalizeHtmlPictureWrappersForDisplay()`. `normalizePromptImages()` now keeps only the first local path inside each picture block. HTML picture alternatives workload is now 0 failures across 37 checks.
- Mixed prompt inputs can include a direct pasted image plus a separate CLI/file-argument image tag. Baseline skipped the file-tag image whenever any direct image existed, so a direct PNG plus separate GIF file tag counted only one thumbnail.
- Kept `76bac77`: `normalizePromptImages()` now records SHA-256 hashes for accepted direct image payloads and skips an image `<file name=...>` fallback only when the file content hash matches a remaining direct image hash. Mixed direct+file-tag workload is now 0 failures across 38 checks.
- Kept `2977f6f`: `normalizePromptImages()` now consumes a matching direct-image SHA-256 hash for any extracted local image file path, not just CLI `<file>` tags, so direct pasted image payloads plus the same raw temp path render one thumbnail while different-content raw images still render separately. Direct+raw workload is now 0 failures across 40 checks.
- HTML `srcset` alternatives can include a direct-image match as a non-first candidate. Baseline `5dcfef8` found that a direct PNG plus `<img srcset="different.gif 1x, matching.png 2x">` counted the direct image and the first srcset candidate as two thumbnails even though the whole `srcset` group is one semantic image.
- Kept `b2f41ee`: HTML candidate groups now check all grouped local paths for a direct-image content hash before adding the first path-derived thumbnail. This suppresses the whole semantic group when any candidate mirrors a direct image. Direct+HTML-srcset workload is now 0 failures across 41 checks.
- Multiple raw local temp paths can point to the same direct pasted image content. Baseline `d1377f3` found that a direct PNG plus two different same-content PNG temp paths counted two thumbnails because the direct-image hash match was consumed by the first fallback.
- Kept `71d577e`: direct-image hash matching is now a non-consuming membership check, so every same-content path fallback is suppressed while different-content raw images still render separately. Same-content raw-copy workload is now 0 failures across 42 checks.
- Duplicate direct image payloads can appear if event plumbing forwards the same pasted image twice. Baseline `8708406` found that two identical direct PNG `ImageContent` entries rendered as two thumbnails even though distinct PNG+GIF direct images correctly rendered separately.
- Fixed in the duplicate-direct iteration: direct `ImageContent` payloads now de-dupe by SHA-256 before adding thumbnails, while distinct direct image bytes still render independently.
- Next hypothesis: broaden direct-image de-dupe coverage across equivalent textual forms (`file://`, percent-encoded paths, query/fragment suffixes, Markdown/HTML wrappers) and multi-direct prompts to ensure same-content references de-dupe without suppressing unrelated attachments.
