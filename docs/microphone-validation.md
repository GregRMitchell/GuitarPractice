# Mobile microphone validation

Run `npm run dev` for localhost development or `npm run build` for static output
in `dist`. A phone needs an HTTPS origin; publishing is a separate step.
Use Android Chrome and standard tuning (E2, A2, D3, G3, B3, E4).

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
