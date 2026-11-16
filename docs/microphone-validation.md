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
5. Tap **Finish** to freeze timing and release capture. Review device/browser
   descriptions and environment notes, check the review box, and explicitly
   download the JSON report.

Prompted chords never create reference labels. Both detector events and observer
labels use the same monotonic clock, normalized to the independent starting
confirmation. Observer reaction delay and protocol deviations belong in notes.

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

Report schema version 1 includes selected protocol/pair, algorithm parameters,
calibration floor, effective track settings and actual analysis sample rate (which
can differ if the browser resamples), user-reviewed device/browser
context, independent labels, detector events, elapsed time, and Task 4 metrics.
Nonfinite numbers block export. No samples or device/group IDs are exported.
No audio or labels are automatically persisted or transmitted. Avoid personal
information in notes; downloaded reports are managed by the user.

A passing pair report requires ≥20 actual switches, precision ≥90%, recall ≥80%.
Zero events produce undefined precision and cannot pass. All 28 pairs and each
separate control need real-device evidence; automated tests prove neither
physical microphone behavior nor recognition accuracy.
