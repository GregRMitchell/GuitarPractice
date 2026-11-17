# Mobile microphone validation

Run `npm run dev` for localhost development or `npm run build` for static output
in `dist`. A phone needs an HTTPS origin; publishing is a separate step.
Use Android Chrome and standard tuning (E2, A2, D3, G3, B3, E4).

## One-minute practice

Chord Play opens directly on the practice card. Choose two different open chords
and tap **Start practice**. Allow microphone access and stay quiet for two seconds
of calibration. The 60-second round then begins automatically—no observer or
second start button. Strum the first chord clearly to establish it, then alternate.
Diagrams show the detector's reference voicings (G is `320003`).

The counter and encouragement use real detector-confirmed changes, not a playing
accuracy score. The countdown uses the monotonic session clock, excludes calibration,
and stops at 60 seconds even if a timer callback arrives late. Observations delivered
after the deadline are not counted. A completed minute reports switches per minute;
an early-ended round reports only its count and actual duration. Choose another pair
and tap **Play again** for a fresh round. No context form or export is required.

**Stop & reset**, hiding/leaving the page, capture errors and capture gaps discard
the round and release the microphone. Returning never restarts it. Tap **Restart**
for new calibration and a fresh minute, or **End round** to unlock the selectors.
Finished non-discarded practice rounds with positive active time save automatically
to local IndexedDB. Early finishes are retained as early, not full minutes.
Diagnostics, controls and interrupted/reset attempts never enter practice history.
There is no audio upload or recording.

## Learn a chord and strumming

The practice-mode buttons switch between **Chord switches** (the default),
**Learn a chord**, **Strumming**, and **Play along**. Finish or reset an active round before
changing modes; a pending or failed history save also locks mode changes.

**Learn a chord** shows the reference diagram and listens after quiet calibration.
Overall feedback checks pitch-class evidence for that one chord, not a contest
against another chord. Tips may suggest checking fingering or moving away from a
clipping microphone; they cannot certify every string, fret buzz, muting or timbre.
Select **Overall chord** or a physical string from low E to high E. Muted strings
are marked skip. Pluck the selected string alone: its target fret/note and estimated
cents are shown, with no automatic advance. A periodic pitch match does not prove
which physical string sounded. Counts mean separate stable overall confirmations
and unique selected string pitch matches, not repetitions or clean-string scores.
Silence waits; calibration, denied permission and interrupted capture are visible.

**Strumming** starts an audio-clock metronome with a one-bar 4/4 count-in, accented
first beat, 40–160 BPM (80 by default), eight eight-slot patterns, and optional muted
clicks. Hold the selected chord; arrows and D/U are directions to follow, never
detected hand directions. Default guided practice needs no microphone and reports
**timing not measured**. Optional microphone timing adds a quiet calibration second
and reports estimated matched/missed/extra attacks and mean absolute offset in ms.
This estimate is uncalibrated for device latency and cannot assess direction or
chord correctness. Audible clicks plus microphone timing require explicit
headphone confirmation to reduce speaker bleed; alternatively mute clicks.
Choose **Beat clicks** for the pulse, or **Strum cues (down low · up high)** for
different down/up sounds following the pattern, with silence on rests. Count-in
always uses beat clicks. Turning audio clicks off mutes either sound choice.
History retains the sound choice as part of the rhythm settings.

Both modes finish after 60 active seconds, excluding calibration/count-in.
Measured strumming briefly shows a finishing phase (up to 250 ms) to drain
in-transit timing estimates; only the final summary is saved.
**End round** retains positive-duration early practice. **Stop & reset**, hiding,
leaving, interruptions and errors release audio and discard the unfinished round;
returning never resumes automatically. Pending strumming setup is abortable;
a microphone permission grant arriving after cancellation is immediately stopped.
Summaries contain only mode settings,
duration and aggregate counts—never PCM, analysis frames or recordings.

## Play along

Choose a preset or edit a sequence of two to eight chords, including repeats.
The F chord in Minor mood is a barre challenge. Choose 40–160 BPM, one to four
bars per chord, one to eight loops, and a strumming pattern. The preview shows
the playing time; the one-bar count-in is additional. The audio clock advances
the current and next chord prompts, beat, bar and loop, then ends after the
last complete phrase. Chord prompts are instructions, not detected changes.

Guided play needs no microphone. Optional microphone timing estimates attacks
only; it does not verify chords or strum direction. As in Strumming, audible
microphone timing requires headphone confirmation, and strum cues are silent
on rests. **End play-along** saves positive playing time as an early finish;
reset, hiding, leaving and interruptions discard it. History saves the sequence
and settings with aggregate timing estimates, never audio. A completed
play-along contributes practice time but no detected switch count or pair best.

## Device-only history and backups

Open **History** to see all-mode round/time totals, separate coaching, strumming and play-along
totals, chord-switch-only switch totals, practice days (UTC), progress by
chord pair and expandable recent-round details. Dates in the list use device local
time; expanded details include the UTC timestamp. **Best full minute** and
**Latest change** compare only actual completed 60-second rounds, never a scaled
early finish. Recent rounds load twenty at a time.

The app stays practice-first. `#history` and `#practice` navigation use the same
page and work on static hosting and offline. History navigation is disabled
throughout unfinished attempts, including paused ones; end the attempt first.
Opening History after finishing preserves the on-screen round summary.

History never leaves the device automatically. Clearing browser data or browser
storage eviction can erase it. Use **Download history JSON**, check Downloads,
then move the file yourself to another device. **Import history JSON** validates
the whole version-2 backup (or a legacy version-1 chord-switch backup) and previews additions/identical duplicates before
**Confirm merge**. Cancel changes nothing. Conflicting IDs reject the entire
merge with no overwrite; confirmation rechecks other-tab changes atomically.
The backup limit is 5 MiB UTF-8 and 10,000 records. File extensions are advisory;
only the strict history JSON schema is accepted, not diagnostic reports.

Saving is reported only after the database transaction completes. Storage errors
are visible and do not prevent an initial practice round. A failed round save
retains its identity in memory: keep the page open and **Retry local storage /
save**. Starting another round and applying an update are blocked until that
result saves; History navigation is blocked too. There is no hidden fallback. Closing or manually reloading the
page can still lose an unsaved result. Backups contain only summary metadata,
never audio, detector observations, labels, or diagnostic context.

Microphone levels, detection details, observer protocols, controls, timing review
and JSON export live in the collapsed **Advanced** section. Enable **Use diagnostic
protocol** before starting to use manual diagnostic timing instead of quick play.
Installation and explicit updates are at the bottom of the page.

## Offline installation and deployment

On 2026-11-16 the user explicitly waived the recognition gate **for offline
features only**: “Don't hold the offline features, just implement them assuming
the detection is working.” This is not recognition evidence or an accuracy claim.
Local history records detector estimates and does not imply the recognition
gate passed.

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
Pending history operations and retryable unsaved round results also block updates.
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
It also verifies full/early autosave using synthesized silent capture, real
IndexedDB persistence across reloads, explicit JSON download and transfer between
separate origins, cancel/dedup/malformed/concurrent-conflict preservation,
bounded recent-round rendering and offline history hash navigation.

## Pair protocol

1. Open **Advanced**, enable **Use diagnostic protocol**, and select Pair.
   Select two distinct chords. Enable the independent-observer option only
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
seconds. Every control requires zero switches. These protocols require **Use
diagnostic protocol** to be enabled before starting.

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
precision and cannot pass. All currently supported pairs and each separate control need
real-device evidence; automated tests prove neither physical microphone
behavior nor recognition accuracy.

The expanded chord library adds overlapping pitch profiles. Switch detection
compares the energy of the standard reference voicing's individual MIDI notes
against all supported voicings. It ranks candidates by cosine similarity, then
requires evidence on distinguishing notes over every competitor. Before that
comparison, it reserves up to the lower octave's energy as a possible second
harmonic; this reduces false evidence for a missing octave note but can reject
real chords with weak fundamentals. Each expected pitch class also needs a
reference fundamental with octave-adjusted energy at least 0.14 relative to the
strongest note bin; doubled pitch classes need only one such fundamental.
Alternate voicings, harmonics stronger than
the fundamental, tuning, and room acoustics can still affect results. Synthetic
tests are not evidence of expanded-library accuracy or pair coverage.
