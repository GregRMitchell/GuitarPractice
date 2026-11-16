# Guitar Microphone Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a static-hostable microphone drill and independent reference-labeling harness to evaluate the approved chord-recognition gate on Android Chrome.

**Architecture:** Keep signal analysis, chord classification, drill counting, and validation metrics independent of the UI. An AudioWorklet captures bounded windows; a worker analyzes them without blocking the audio or UI thread. The UI presents targets and exports explicit, user-requested validation reports.

**Tech Stack:** TypeScript 7.0.2, Vite 8.3.8, Vitest 5.1.0, browser AudioWorklet/Worker APIs; no application framework or production service.

## Global Constraints

- Specification: `docs\superpowers\specs\2026-11-16-guitar-practice-design.md`.
- Primary platform: Android phones and tablets running Chrome.
- Standard tuning: E2, A2, D3, G3, B3, E4.
- Eight open chords: A, Am, C, D, Dm, E, Em, and G.
- Audio stays in memory and is neither persisted nor transmitted.
- Precision of at least 90%; recall of at least 80%, for every tested pair.
- Test all 28 unordered chord pairs, with at least twenty actual switches per pair.
- No extra counts during separate silence, ordinary speech, and repeated same-chord-strum controls.
- No accuracy claim based solely on synthetic audio or automated tests.
- No accounts, external inference, saved recordings, or runtime CDNs.
- Release capture and pause timing when hidden; explicit resume only.
- Current toolchain: Node 24.11.1 and npm 11.6.2, verified 2026-11-16.
- No Git repository exists. Do not initialize one or create commits without permission.

---

## Scope and Stop Condition

This plan implements delivery milestone 1 only: the deployable recognition gate.
It does not implement routines, history, import, installation, or offline caching.
Those form a subsequent plan after real-device evidence passes the gate.
Static hosting is required now so the user's phone can access a secure origin.

Package versions above were checked against npm. Pin direct dependencies, retain
the lockfile, and check new dependencies for advisories before delivery.

## File Map

| Files | Responsibility |
| --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.json`, `index.html` | Runnable strict TypeScript/Vite application and checks |
| `.gitignore` | Generated-output and secret-file exclusions |
| `src\main.ts`, `src\style.css` | Mobile validation screen and user controls |
| `src\chords.ts` | Typed chord names, pitch classes, and open voicings |
| `src\audio\features.ts` | Pure spectral/pitch-class extraction |
| `src\audio\classify.ts` | Pair-constrained, reject-capable chord observations |
| `src\audio\capture.worklet.ts`, `analysis.worker.ts`, `capture.ts` | Bounded capture, background analysis, lifecycle |
| `src\drill.ts` | Stable confirmations, alternating targets, timing |
| `src\validation.ts` | Reference events, one-to-one matching, gate reports |
| `tests\features.test.ts`, `classify.test.ts`, `drill.test.ts`, `validation.test.ts` | Focused pure-logic regressions |
| `tests\capture.test.ts` | Permission, cleanup, and stale-message regressions |

Keep files focused and approximately under 300 lines. Add public API JSDoc and
explicit types. Tests should exercise behavior, not duplicate implementation.

## Shared Contracts

Create these types in their owning modules; consumers import them with `import type`.

```typescript
// src\chords.ts
export type Chord = 'A' | 'Am' | 'C' | 'D' | 'Dm' | 'E' | 'Em' | 'G';
export type Pair = readonly [Chord, Chord];
export interface ChordDefinition {
  readonly pitchClasses: readonly number[];
  readonly midiNotes: readonly number[];
}
// src\audio\classify.ts
export interface Observation {
  readonly atMs: number;
  readonly chord: Chord | null;
  readonly confidence: number;
}
// src\validation.ts
export interface Reference {
  readonly atMs: number;
  readonly chord: Chord;
}
export interface AcceptedSwitch {
  readonly atMs: number;
  readonly chord: Chord;
}
```

All event times use milliseconds on the same monotonic session clock. Define
reference time zero when the observer confirms the correctly played starting
chord. Do not create labels from detector predictions or a scheduled prompt.

### Task 1: Runnable Application and First Counting Regression

**Files:** Create root configuration, `src\main.ts`, `src\drill.ts`, `tests\drill.test.ts`, and the type-only contracts in `src\chords.ts`, `src\audio\classify.ts`, and `src\validation.ts`.

**Interfaces:** Produce `createDrill(pair: Pair): Drill`; `Drill.observe(observation: Observation): AcceptedSwitch | null`; `Drill.pause(): void`; `Drill.resume(): void`. The initial drill is paused until explicitly started. Resume forgets pending evidence and re-establishes the starting chord without awarding a switch.

- [ ] Create the shared contracts above before consuming them. Create `package.json` with scripts `dev: vite --host 127.0.0.1`, `build: tsc --noEmit && vite build`, `test: vitest run`, and `check: tsc --noEmit`. Pin the three development dependencies listed above; set `type` to `module`. Configure TypeScript strict mode, ES2022, DOM libraries, bundler module resolution, and no emit.
- [ ] Run `npm install`; retain `package-lock.json`. Run `npm audit`; report unresolved advisories rather than applying breaking automated upgrades.
- [ ] Add a test proving first-chord establishment and no same-chord double count:

```typescript
import { expect, test } from 'vitest';
import { createDrill } from '../src/drill';

test('establishes A without counting repeated A strums', () => {
  const drill = createDrill(['A', 'D']);
  drill.resume();
  for (const atMs of [0, 100, 200, 300, 500, 700]) {
    expect(drill.observe({ atMs, chord: 'A', confidence: 1 })).toBeNull();
  }
});
```

- [ ] Run `npm test -- tests\drill.test.ts`; confirm it fails because the module/function is absent, not because of a broken runner.
- [ ] Implement a paused/listening/established state machine. Start with named engineering parameters: confidence 0.8, stable duration 180 ms, and maximum evidence gap 120 ms. These are starting settings, not measured guarantees. A null, wrong, low-confidence, stale, or out-of-order observation resets pending stability. A stable first chord establishes the source; a stable alternate emits once and becomes the source.
- [ ] Add a regression for A then D then repeated D, expecting exactly one event, and a regression that pause/resume cannot award a pending switch. Run `npm test -- tests\drill.test.ts` and `npm run build`; require passing tests and a generated `dist` directory.
- [ ] Render a minimal page with the selected pair and a Start button. Exclude `node_modules`, `dist`, `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, credential JSON files, and secrets YAML files in `.gitignore`; do not exclude the dependency lockfile.

### Task 2: Signal Features and Reject-Capable Classification

**Files:** Extend `src\chords.ts` and `src\audio\classify.ts`; create `src\audio\features.ts` and their tests.

**Interfaces:** `extractFeatures(samples: Float32Array, sampleRate: number): Features`; `classify(features: Features, pair: Pair, atMs: number): Observation`. `Features` contains RMS and twelve normalized pitch-class energies, plus optional per-note evidence if needed to distinguish voicings.

- [ ] Define MIDI voicings: A `[45,52,57,61,64]`; Am `[45,52,57,60,64]`; C `[48,52,55,60,64]`; D `[50,57,62,66]`; Dm `[50,57,62,65]`; E `[40,47,52,56,59,64]`; Em `[40,47,52,55,59,64]`; G `[43,47,50,55,59,67]`. Derive pitch classes using modulo twelve.
- [ ] Add a silence rejection test:

```typescript
import { expect, test } from 'vitest';
import { extractFeatures } from '../src/audio/features';
import { classify } from '../src/audio/classify';

test('silence cannot be labeled as either expected chord', () => {
  const features = extractFeatures(new Float32Array(8192), 48000);
  expect(classify(features, ['E', 'Em'], 0).chord).toBeNull();
});
```

- [ ] Run `npm test -- tests\features.test.ts tests\classify.test.ts`; confirm the new test fails before implementation.
- [ ] Implement DC removal, a Hann window, frequency analysis, and pitch-class energy aggregation. Begin with 8192-sample frames and 2048-sample hops. Use a locally bundled, small FFT implementation or a reviewed, pinned dependency; if adding a dependency, update the manifest first and check advisories/license. Never substitute a single-frequency tuner for polyphonic analysis.
- [ ] Normalize only above a measured noise floor. Score target chord tones and penalize out-of-chord evidence; compare against all eight chord profiles so an unrelated chord is not forced into the active pair. Reject low score or insufficient winner/runner-up separation. Keep thresholds named and configurable within the harness.
- [ ] Generate deterministic synthetic plucked chords as sums of fundamental/harmonic components with decay. Test 44.1 kHz and 48 kHz, gain changes, silence, unrelated chords, and C/Am and E/Em discrimination. Show uncertainty when the evidence cannot distinguish the pair; do not lower confidence thresholds merely to satisfy tests.
- [ ] Run the two targeted test files and `npm run check`. Inspect synthetic results as pipeline evidence only; reserve real-world accuracy for Task 6.

### Task 3: Bounded Microphone Capture and Cleanup

**Files:** Create `src\audio\capture.worklet.ts`, `src\audio\analysis.worker.ts`, `src\audio\capture.ts`, `tests\capture.test.ts`.

**Interfaces:** `startCapture(pair: Pair, handlers: CaptureHandlers): Promise<Capture>`; `Capture.stop(): Promise<void>`. `CaptureHandlers` has `onObservation(value: Observation): void`, `onLevel(rms: number): void`, and `onError(error: Error): void`. `Capture.settings` exposes effective `MediaTrackSettings`. Stop is idempotent and invalidates every pending observation from that capture session.

- [ ] Write mocked-browser tests: permission rejection reaches the caller; worklet or worker setup failure stops already acquired tracks; stop releases all tracks and closes the audio context; late worker messages cannot reach the drill after stop.
- [ ] Run `npm test -- tests\capture.test.ts`; confirm each test fails for the missing lifecycle behavior.
- [ ] Acquire audio only on an explicit user gesture. Request `echoCancellation: false`, `noiseSuppression: false`, and `autoGainControl: false` as preferences, not mandatory constraints. Show effective settings when available.
- [ ] Load TypeScript worker/worklet entries through Vite's bundled URL mechanism. Do not fetch a raw `.ts` file from the deployed site. Configure worker compilation with WebWorker types and worklet declarations separately from DOM UI types.
- [ ] Connect capture through the worklet to a zero-output sink; never play microphone audio through speakers. Use a fixed-size ring buffer, transfer at most one frame awaiting analysis, and drop outdated windows rather than growing a queue. Timestamp frames from the capture clock and translate them into session time before emitting observations.
- [ ] Analyze frames in the worker using Task 2. Measure two seconds of explicitly requested quiet-room calibration before accepting observations; show its status and restart calibration if interrupted. Pass measured RMS noise floor into classification. Acknowledge completion even when analysis fails, and surface failure through `onError`; do not return a fabricated uncertain/success result for exceptions.
- [ ] On stop or partial setup failure, disconnect nodes, close the port, terminate the worker, stop each track, and close the context. On hidden-page notification, stop and pause; never automatically reacquire on visibility restoration.
- [ ] Run `npm test -- tests\capture.test.ts tests\drill.test.ts` and `npm run build`. In Chrome, verify that leaving the drill clears the microphone indicator.

### Task 4: Independently Labeled Gate Metrics

**Files:** Extend `src\validation.ts`; create `tests\validation.test.ts`.

**Interfaces:** `evaluate(references: readonly Reference[], events: readonly AcceptedSwitch[], endedAtMs: number): Evaluation`. `Evaluation` contains actual-switch count, counted-switch count, true positives, false positives, misses, precision, recall, and pass status. Precision is `null` when no events exist; that run does not pass.

- [ ] Add a one-to-one matching regression:

```typescript
import { expect, test } from 'vitest';
import { evaluate } from '../src/validation';

test('a duplicate event is a false positive, not another correct switch', () => {
  const report = evaluate(
    [{ atMs: 0, chord: 'A' }, { atMs: 1000, chord: 'D' }],
    [{ atMs: 1200, chord: 'D' }, { atMs: 1400, chord: 'D' }],
    2000,
  );
  expect(report.truePositives).toBe(1);
  expect(report.falsePositives).toBe(1);
  expect(report.recall).toBe(1);
  expect(report.precision).toBe(0.5);
  expect(report.passed).toBe(false);
});
```

- [ ] Run `npm test -- tests\validation.test.ts`; confirm failure before implementing metrics.
- [ ] Match each event to the reference transition whose interval contains it, whose target matches, and which has not already matched. The first reference establishes the source and is not a switch. Use half-open intervals `[transition, nextTransition)` and exclude events at/after run end.
- [ ] Reject unsorted, nonfinite, negative-time, repeated-same-chord reference transitions and events outside the session. Report errors explicitly. Compute per-pair pass status only when there are at least twenty switches and both thresholds are met; controls have a separate zero-event pass condition.
- [ ] Add tests for an event before establishment, wrong target, missed transition, no events, fewer than twenty switches, and exact threshold boundaries. Run `npm test -- tests\validation.test.ts` and `npm run check`.

### Task 5: Mobile Validation Screen and Report Export

**Files:** Modify `src\main.ts`; create `src\style.css`.

**Interfaces:** Consume Tasks 1-4 without moving their logic into UI handlers. Export a versioned JSON report through a user-created Blob download; never include microphone samples.

- [ ] Provide pair selectors, Start/Pause/Resume/Finish controls, prominent target/next chord, count, input-level feedback, confidence/uncertainty, effective capture settings, and visible permission/device errors. Disable pair changes during a run.
- [ ] Add an observer/reference mode: an explicit starting-chord confirmation plus a large "actual change confirmed" control or keyboard shortcut. At confirmation, reset the drill, clear provisional events, and set the common reference/detector time origin; discard earlier frames. Hide predictions while labeling to reduce observer bias. A prompt alone must never create a reference label.
- [ ] Mark results without independently verified references as exploratory, not gate evidence. Discard a run after an interruption rather than splicing incompatible capture clocks into one labeled run.
- [ ] Add controls for silence, speech, and same-chord-strum runs, each at least thirty seconds. Persist no audio or labels automatically; let the user explicitly export the run report.
- [ ] Include report version, selected pair/control, detector parameters, sample rate, device/browser information entered or reviewed by the user, environment notes, references, events, elapsed time, and metrics. Validate finite values before export. Render text with DOM text APIs, never `innerHTML`.
- [ ] Run `npm test` and `npm run build`. Exercise start, denied permission, silence, repeated strums, pause, hidden page, resume, finish, and export in Chrome. Check network traffic for forbidden uploads.

### Task 6: HTTPS Deployment and Real-Device Gate

**Files:** No new production files required; deploy the generated `dist` output using the user's chosen static host.

**Interfaces:** Produce user-controlled JSON evidence files and a per-pair/control pass/fail matrix. Gate reports are measurement artifacts, not proof of identity or tamper resistance.

- [ ] Ask which static host/account to use before publishing. Do not create remote repositories, alter account security, or upload artifacts without authorization. For a subpath host, set Vite's base path and rebuild.
- [ ] Run `npm run build`; publish only `dist`. Verify HTTPS, worker/worklet loads, MIME types, and successful microphone capture from Android Chrome, not merely desktop localhost. HTTP over a LAN address is not a microphone-compatible substitute.
- [ ] Start with C/Am and E/Em to find feasibility problems early. Once these work, independently label at least twenty switches for each of the 28 pairs. Use a reasonably tuned guitar and record the actual environment; stop and retune if needed.
- [ ] For each pair, run thirty-second silence, ordinary-speech, and repeated-source-chord controls after source establishment. Require zero counted switches in each control. Test each chord as an initial source at least once.
- [ ] Export reports, calculate per-pair precision/recall, and reject runs lacking valid independent labels. Record measured recognition delay and device responsiveness as usability evidence without claiming an unapproved numerical latency guarantee.
- [ ] If any pair or control fails, change one measured cause at a time and rerun affected cases plus regressions. Use fresh labeled runs for final acceptance; do not present parameter-fitting runs as held-out validation.
- [ ] Stop before the full PWA if the gate is unmet or if the user's device/reference evidence is unavailable. Report measured results and blockers plainly. Only after a passing gate, plan routines, diagrams, history, backup/import, offline caching, installation, and updates against the approved specification.

## Self-Review and Handoff

- Milestone coverage: all eight chords, target-constrained recognition, stable counting, privacy/lifecycle handling, independent measurement, and HTTPS Android validation have tasks above.
- Deferred coverage: the remainder of the approved PWA is intentionally blocked by the real-device gate, not silently omitted.
- No implementation, package installation, publication, or accuracy validation has occurred while writing this plan.
- Execution can be inline with checkpoints; subagents are optional only if the user requests that execution style.
