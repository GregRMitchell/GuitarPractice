# Mobile microphone validation

Run `npm run dev` for localhost development or `npm run build` for static output
in `dist`. A phone needs an HTTPS origin; publishing is a separate step.
Use Android Chrome and standard tuning (E2, A2, D3, G3, B3, E4).

## Offline installation and deployment

On 2026-11-16 the user explicitly waived the recognition gate **for offline
features only**: “Don't hold the offline features, just implement them assuming
the detection is working.” This is not recognition evidence or an accuracy claim.
Routine/history features and the detector algorithm remain outside this change.

The production build includes an Android standalone manifest, padded 192/512 PNG
maskable icons, and a generated versioned service worker. No microphone permission
is requested by installation. Use **Install app** when Chrome offers it; otherwise
use the browser menu's **Add to Home screen / Install app** option. An installed
standalone window displays installed status; the browser may not expose whether
another installed app window exists.

Deploy the entire `dist` output together over HTTPS. For subpath hosting, run
`npm run check` followed by `npx vite build --base /guitar/`.
Use an absolute same-origin base ending in `/`, and serve it at that exact path.
Relative/CDN bases are deliberately rejected. Serve `sw.js` as JavaScript with
revalidation (`Cache-Control: no-cache` recommended), and the manifest as
`application/manifest+json`. Avoid rewriting missing asset requests to HTML.
Keep old hashed assets available during deployment where possible. Do not put an
independently deployed nested app beneath a root worker's navigation scope.
Vite's development server deliberately does not install a worker.

**Offline ready** means the current page is controlled by its own build's worker
and every required output was found in that version's cache during a handshake.
The generated list includes HTML, CSS, all hashed JS, analysis worker,
AudioWorklet, icons, and manifest; no hashed list is maintained manually.
Build-generated SHA-256 integrity checks reject corrupt or mixed-deployment
downloads before a cache can be installed.
Network status alone never certifies readiness. Initial cache/registration
failures, unsupported browsers, and insecure origins are displayed explicitly.
Readiness is checked again on controller/network changes and when returning to
the page. Browser eviction or clearing site data can remove offline support;
reconnect and reload when safe to recover. A hard reload can bypass a service worker.

Navigation uses the controlling worker's cached HTML, including in-scope deep
links. An incomplete/evicted graph may load uncached network HTML to recover
online; it is never saved as that older version. The version handshake still
withholds readiness until the page and controlling cached build match.
Runtime assets come from their versioned graphs, never an HTML fallback.
No microphone samples, labels, history, downloaded report blobs, arbitrary
requests, or foreign-origin responses enter these caches.

Registration checks for updates on page load; returning to the page or coming
online requests another check. Browsers can delay checks. A fully downloaded
upgrade waits: there is no automatic skip-waiting or reload. **Apply update &
reload** is enabled only while idle or finished, never starting, calibrating,
ready, running, or paused (even a discarded paused attempt must be finished).
The action is explicit consent to discard in-memory report/edits: export first
and verify the download. It locks starting another attempt during activation.
The worker refuses explicit activation while any other in-scope app window/tab
is open, even an idle one. Close those windows and retry, or close all app
windows to let the browser activate naturally. No other tab is forcibly reloaded.
Old graph caches are retained while windows exist and removed only during a
later safe activation with no in-scope windows; unrelated/sibling-scope caches
are untouched. Retention also protects a window opened during the update race.

Validation: `npm test`, `npm run build`; optional real-browser checks use
`node tests\browser-offline.mjs` with existing Edge on Windows (override executable
with `EDGE_PATH` for an existing Chrome installation). The browser check binds
only to localhost, builds isolated root/subpath outputs, and removes its profile
and outputs afterward. It exercises unavailable-origin navigation/assets,
real Worker/AudioWorklet loading, cache failure, installability metadata, and
cross-tab update safety—not Android installation UX or recognition accuracy.

## Pair protocol

1. Select two distinct chords. Keep the independent-observer option enabled only
   when another observer can identify the actual played chords without detector
   predictions. Otherwise use exploratory mode: it cannot pass a pair gate.
2. Stay quiet and tap **Start microphone**. Allow microphone access and wait for
   two seconds of uninterrupted calibration. Review effective capture settings;
   devices may ignore requests to disable speech processing.
3. Play the starting chord. The observer presses its **Actual chord** button
   (or keyboard key 1/2 outside form controls). That independent confirmation
   establishes time zero, resets the drill, and discards all provisional
   observations/source evidence. Hold the starting chord long enough for the
   detector to establish it again before switching.
4. Alternate chords. The observer confirms every actual change, not the
   requested prompt. Detector predictions, confidence and counts stay hidden
   during labeling. At least twenty actual switches are required per pair.
   These button timestamps record observer reaction, not precise playing
   transitions; ordinary tapping alone is not ground-truth timing.
5. Tap **Finish** to freeze timing and release capture. In the finished-run
   timing review, compare each labeled transition with an independent,
   timecoded observation or reference clock, and enter corrected milliseconds
   relative to the source. The source remains fixed at 0 ms and chord labels
   cannot be changed. Describe the independent timing evidence, then attest
   that times were verified against actual playing—not merely button reactions
   and not adjusted from detector predictions. Any edit clears the attestation.
   Without independent timing evidence, the run cannot be certified: it remains
   provisional even if raw button-time metrics meet the numeric thresholds.
   Review device/browser descriptions and environment notes, check the context
   review box, and explicitly download the JSON report.

Prompted chords never create reference labels. Detector events and raw button
timestamps use the same monotonic clock, normalized to the independent starting
confirmation. Corrected times must retain the actual label sequence and source
zero and are evaluated by the existing strict half-open interval rule; an event
at the run end remains excluded. No matching tolerance is widened.

## Separate controls

Select silence, ordinary speech, or repeated same-chord strums. After calibration,
strum the selected starting chord until the detector establishes that stable
source. This happens **before** the control timer starts. Silence/speech controls:
let the chord decay, then tap **Begin** and stay silent or speak normally.
Same-chord control: tap **Begin** and continue strumming only the starting chord.

The established detector source is retained across Begin, so the control is not
silently measured with an uninitialized detector. Pre-control events are cleared,
but subsequent false switches count. Finish after at least thirty uninterrupted
seconds. Every control requires zero switches.

## Interruptions and reports

Pause, page hiding/leaving, device interruption, or capture failure discards
active labels/events and releases capture. Resume is a new gesture, new capture,
new calibration, and new explicit time origin—not continuation of old evidence.
A calibration gap also discards current evidence and requires a fresh origin
after calibration. A discarded attempt can be finished/exported, but cannot pass.

Report schema version 2 keeps `rawButtonReferences` (also retained as
`references`) separately from `reviewedReferences`, and records timing
provenance, the attestation, and `rawResults`. `results` and `gatePassed` are
available for a pair only after attested independent timing review; provisional
button-reaction metrics can never pass. The report also includes selected
protocol/pair, algorithm parameters, calibration floor, effective track
settings and actual analysis sample rate (which can differ if the browser
resamples), user-reviewed device/browser context, detector events, and elapsed
time. Nonfinite numbers block export. No samples or device/group IDs are
exported. No audio or labels are automatically persisted or transmitted. Avoid
personal information in notes; downloaded reports are managed by the user.

Displayed confidence is an uncalibrated margin-based indicator, not a
probability of correctness.

A passing pair report requires ≥20 actual switches, precision ≥90%, recall ≥80%,
and independently verified transition times. Zero events produce undefined
precision and cannot pass. All 28 pairs and each separate control need
real-device evidence; automated tests prove neither physical microphone
behavior nor recognition accuracy.
