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
- Current iteration expands the workload with generalized edge cases (file URLs with escaped spaces, shell-escaped spaces, and parenthesized paths) to guard against overfitting to a single `/var/.../clipboard.png` example.
