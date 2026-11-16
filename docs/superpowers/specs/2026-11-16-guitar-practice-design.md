# Guitar Practice PWA Design

Date: 2026-11-16
Status: Written specification approved by the user on 2026-11-16.

Offline sequencing override (2026-11-16): the user explicitly waived the
recognition gate for offline shell/installability/update safety: “Don't hold the
offline features, just implement them assuming the detection is working.”
Implement that already-approved scope now; this does not assert recognition
accuracy or waive real-device evidence for recognition claims. Routine/history
and detector changes are not part of this override. See
`docs/microphone-validation.md` for offline deployment and safe-update behavior.

## Goal

Build a static-hosted, offline-capable practice companion for beginners who know
a few chords and want smoother changes. The first release guides adjustable
practice routines and automatically counts confirmed chord switches through the
microphone. Strumming patterns and individual-string picking follow in later
releases.

Primary platform: Android phones and tablets running Chrome.

## Scope

The first release includes:

- Standard tuning: E2, A2, D3, G3, B3, E4.
- Eight open chords: A, Am, C, D, Dm, E, Em, and G.
- Finger diagrams, finger numbers, and open/muted-string guidance.
- A suggested daily routine with adjustable exercises and durations.
- Two-chord switching drills with microphone or manual tracking.
- Local session history, pair-level progress, and personal bests.
- Offline installation and use after the app assets have been cached.
- Versioned JSON export and import for backup and device transfer.

It excludes accounts, automatic sync, a backend, audio uploads, saved recordings,
arbitrary chord recognition, note-cleanliness scoring, automatic tuning, alternate
tunings, strumming lessons, and picking lessons.

## Practice Experience

### Daily routine

Suggest a ten-minute routine containing chord-shape review, several two-chord
drills, and a one-minute progress check on a chosen pair. Show the exercise
sequence and durations before starting. Users can change pairs and durations.
Duration changes update the displayed total.

Favor less-practiced pairs and weaker pair results when suggesting exercises.
Introduce unpracticed pairs rather than treating missing results as failure.
Suggestions are advisory: users can always choose their own practice.

Chord-shape review is guided practice, not a scored cleanliness assessment.
Only switching drills produce switch counts.

### Switching drill

Display the target chord prominently, its diagram, the next chord, remaining
active time, confirmed switches, and microphone status.

For an A-to-D drill:

1. Recognizing A establishes the starting point and counts zero switches.
2. Recognizing D confirms one switch and makes A the next target.
3. Recognizing A confirms the next switch.
4. Repeated strums of the established chord do not count.

Require a stable match before accepting a chord. Uncertain frames and silence
never establish a chord or increment a count. A single sustained strum must not
be reinterpreted as alternating switches.

Provide pause, resume, finish, and explicit manual-mode controls. Manual mode
supports recording counts and correcting mistakes. Preserve tracking provenance:
microphone, manual, or mixed/corrected. Do not silently convert a microphone
result into a manual result.

One-minute progress checks use sixty seconds of active practice, excluding
pauses. Compare personal bests only across matching pairs, durations, and
tracking modes. Treat the two directions of a pair as one pair for history.

### Feedback and interruptions

Distinguish waiting for the starting chord, listening, confirmed, uncertain,
paused, and microphone-error states. Do not label ambiguous audio as success or
claim that a recognized chord proves every string rang cleanly.

Pause active timing and recognition when the page is hidden or the screen locks.
Release microphone capture on backgrounding, finishing, or leaving a drill.
Require explicit resume and reacquire microphone access as necessary.

Explain permission denial, unavailable devices, and audio-processing failures.
Offer manual mode explicitly; never fabricate counts or silently fall back.

## Recognition Approach

Use target-constrained, local signal processing rather than a single-note tuner
or an unrestricted chord classifier. A drill supplies its two expected chords.

Capture microphone audio using Web Audio APIs, requesting music-appropriate
capture settings where supported. Do not assume a device honors requests to
disable speech processing. Perform capture and bounded analysis off the UI
thread through an AudioWorklet and, where needed, a worker.

Extract frequency information and pitch-class evidence, compare it against chord
profiles, reject insufficient evidence, and smooth decisions over time. Chord
profiles must account for the configured open-chord voicings. Compare against
non-target chord evidence where needed to prevent the expected pair from forcing
every sound into one of two labels.

Use confidence, separation between candidates, and temporal stability to drive
a switch-counting state machine. Thresholds and window sizes remain engineering
parameters to determine from measurements, not assumed accuracy guarantees.

Calibration gives microphone-level feedback and measures the local noise floor.
It must not imply that device calibration guarantees chord-recognition quality.
The user needs a reasonably tuned guitar and a quiet environment.

### Detection validation gate

Build the smallest usable microphone drill before the rest of the application.
Validate on the user's actual Android device and guitar before committing to the
full product implementation.

Test all eight starting chords and all 28 unordered chord pairs, with particular
attention to similar chords such as C/Am and E/Em. For each pair, use at least
twenty labeled, actual switches after establishing the starting chord.

For each tested pair, require:

- Precision of at least 90%: correct counted switches divided by all counted
  switches.
- Recall of at least 80%: correctly counted switches divided by actual switches.
- No extra counts during separate silence, ordinary speech, and repeated
  same-chord-strum controls.

Label actual chord changes independently of detector output. Match each accepted
event to at most one actual transition to the correct target; an event must occur
while that target is being played and before the next actual transition.
Unmatched detector events are false positives; unmatched actual changes are
misses. A run with actual switches but no detected events fails the gate.

Record device/browser, environment, pair, expected transitions, accepted events,
and results. Audio recording is not required: a visible test harness can support
independent observer/reference annotations. App output alone is not ground truth.
Report per-pair results rather than hiding weak pairs in an aggregate.

Synthetic signals check the processing pipeline but cannot establish real-guitar
accuracy. If the gate fails, revise and revalidate recognition before building
the full experience. Manual mode does not count as passing this gate.

## Architecture

Use a TypeScript client application with these focused boundaries:

| Component | Responsibility |
| --- | --- |
| Chord library | Typed chord definitions, voicings, and diagram data |
| Routine planner | Pure selection and duration logic |
| Audio pipeline | Permission, capture, analysis, and confidence observations |
| Drill engine | Target sequence, confirmation rules, active time, and counts |
| Progress store | IndexedDB persistence, migrations, and backup validation |
| Application UI | Routine editing, practice controls, feedback, and history |
| PWA shell | Manifest, install assets, service worker, and offline updates |

Keep detector observations separate from drill rules so the counting state
machine can be tested without microphone hardware. Keep persistence outside the
drill engine. Do not duplicate exercise logic in UI components.

Data flow:

```text
Chord library + local history -> routine planner -> editable routine
Microphone -> audio pipeline -> chord observations -> drill engine
User controls -----------------------------------> drill engine
Drill engine -> UI feedback -> completed result -> IndexedDB
IndexedDB <-> validated JSON backup <-> user-selected local file
Static HTTPS host -> app assets/service worker -> browser cache
```

### Persistence

Store versioned settings and sessions. Session records contain identifiers,
timestamps, exercises, canonical chord pairs, intended and active durations,
confirmed/manual counts, completion state, and tracking provenance. Derive pair
summaries and personal bests from saved results where practical.

Do not double-save a session on repeated completion events. Make pause/resume
timing independent of timer-callback frequency. Surface storage and migration
failures; do not report an unsaved session as saved.

Import validates schema, versions, types, allowed chords, finite nonnegative
measurements, identifiers, and resource limits before any write. Show an import
summary and request confirmation before replacing local history. Apply
replacement atomically so an invalid or failed import preserves existing data.

Explain that browser storage can be cleared or evicted. Export provides backup,
not automatic sync or a guarantee against device loss.

### Hosting and offline behavior

Serve through HTTPS; localhost is suitable for development. Bundle runtime
assets locally rather than requiring third-party CDNs. Cache the app, diagrams,
and audio-processing modules for offline use. Show offline readiness only after
the required assets have been cached successfully.

Do not activate an application update midway through a drill. Offer an update
between sessions. Show unsupported-feature and caching errors explicitly.
Do not promise microphone processing or active practice while backgrounded.

## Security Context

Classification: personal practice history and transient, potentially sensitive
microphone input. Audio stays in memory and is neither persisted nor transmitted.
Export files contain practice history, not audio.

No regulated financial, health, or organizational records are in scope. This is
a personal application, not a claim of regulatory certification. AI-DLC mode:
not configured; no AI inference, agent tools, or production inference provider
is involved.

### Threat Actors

- Malicious file authors can supply malformed backups, oversized inputs, or
  script-like strings to corrupt data or execute injected content.
- A person with access to the browser profile can read, alter, or delete local
  history; the app does not provide account-level isolation.
- A compromised hosting origin or dependency can deliver malicious JavaScript
  with access to app data and any microphone permission the user grants.
- Accidental misuse, interrupted imports, and storage eviction can lose data.

### Trust Boundaries

```text
Untrusted backup --[schema validation + confirmation]--> app
Device mic --[browser permission + explicit start]-----> memory-only analysis
App --[validated records + transactions]--------------> IndexedDB
HTTPS host --[origin/TLS + browser rules]--------------> cached application
App --[explicit export]-------------------------------> user-owned file
```

The user initiates capture, import, and export. The browser initiates application
fetch/update requests. Validate imported and persisted records before use;
consider origin storage user-modifiable rather than authoritative evidence.

### Attack Surface

| Surface | Type / actor | Controls |
| --- | --- | --- |
| Backup import | File input / malicious author | Size limits, schema validation, atomic writes |
| Rendered content | DOM / malicious file author | Text rendering; no unsafe HTML sinks |
| Microphone | Device permission / hostile origin code | Explicit start, capture indicator, prompt release |
| Local history/export | Storage / shared-device user | Minimal fields, user-controlled backup, clear privacy limits |
| Assets and service worker | Supply chain / compromised host | HTTPS, pinned dependencies, no runtime CDN |
| Audio analysis | Resource use / environmental input | Bounded buffers, queues, and frame processing |

### Security Requirements

- Spoofing: history is a personal aid, not verified evidence of performance;
  no identity or authenticated server endpoints exist.
- Tampering: validate backups and stored records; use transactional imports and
  versioned migrations. Do not claim local results are tamper-proof.
- Repudiation: no remote administrative or regulated actions exist; do not add
  centralized telemetry or audit uploads to this local-only application.
- Information disclosure: never persist audio, log samples, or send audio,
  observations, or history to a server. Keep private data out of URLs and caches
  intended for application assets.
- Denial of service: bound import size and record counts before parsing/writing;
  bound audio buffers and processing queues. Document concrete limits in the
  implementation.
- Elevation of privilege: request microphone access only for explicit microphone
  practice. Do not request camera, location, filesystem-wide access, or accounts.
- Treat browser-stored and imported text as untrusted. Avoid dynamic execution
  and unsafe DOM insertion.

### Security Acceptance Criteria

- No microphone request occurs on initial page load or in manual practice.
- Ending, leaving, or backgrounding a drill stops every capture track.
- Network inspection shows no audio, recognition results, or practice-history
  uploads during microphone practice, including errors.
- Offline microphone practice works after caching and granting permission.
- Malformed, unsupported-version, and oversized imports produce visible errors
  without altering history.
- HTML-like import content cannot execute script.
- Storage failure is visible and does not display a false saved-success state.
- The production application uses HTTPS and has no embedded credentials.

### Security Decision Record: Local-Only Processing

Decision: use browser-granted microphone capture, memory-only local processing,
and device-local history; provide no accounts or external inference integrations.
This establishes microphone-to-application and backup-to-storage trust boundaries.

Rationale: preserve static hosting, offline practice, and audio privacy.
Consequences: no automatic sync, no account isolation on shared devices, no
guaranteed persistence against browser deletion, and no trustworthy certification
of results. Exported files are user-controlled and not application-encrypted.
Changing these boundaries requires a separate security decision and user approval.

## Verification and Delivery Order

1. Implement and measure the microphone detection gate on real hardware.
2. Once it passes, build the routine, drill, diagram, and persistence experience.
3. Add history and backup after their prerequisites; offline installation and
   safe update behavior are explicitly authorized now by the override above.
4. Verify the complete Android practice flow and security criteria.

Automated tests cover stable-match counting, first-chord establishment, repeated
strums, uncertainty, timeout/pause behavior, routine selection, comparable
personal bests, persistence failures, backup rejection, and offline operation.
Use browser checks for permission denial, interrupted capture, installation,
backgrounding, and updates. Real-device labeled evidence remains mandatory for
recognition claims.

## References

- Microphone permission and secure-context requirements:
  https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- AudioWorklet processing model:
  https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
