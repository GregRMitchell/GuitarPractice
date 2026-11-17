import { expect, test } from 'vitest';
import { serializeReport } from '../src/report';
import type { SessionSnapshot } from '../src/session';
import type { Reference } from '../src/validation';

const run: SessionSnapshot = {
  phase: 'finished', config: { pair: ['A', 'D'], mode: 'pair', independent: true },
  discarded: false, elapsedMs: 31000, references: [{ atMs: 0, chord: 'A' }],
  events: [], calibration: { status: 'ready', remainingMs: 0, noiseFloorRms: 0.001 },
  settings: { sampleRate: 48000 }, analysisSampleRate: 48000, level: 0, prediction: null, source: null,
  sourceAtStart: null, error: '', discardCount: 0,
};
const metadata = { device: 'Android phone', browser: 'Chrome', environment: 'Quiet room', reviewed: true };

test('zero-event independent pair reports misses instead of passing', () => {
  const references = Array.from({ length: 21 }, (_, index) => ({
    atMs: index * 1000, chord: index % 2 === 0 ? 'A' as const : 'D' as const,
  }));
  const report = JSON.parse(serializeReport({ ...run, references }, metadata));
  expect(report.version).toBe(2);
  expect(report.rawResults).toMatchObject({ misses: 20, precision: null, recall: 0, passed: false });
  expect(report.results).toBeNull();
  expect(report.gatePassed).toBe(false);
});

test('a complete independently labeled pair reports a pass without synthesizing references', () => {
  const references = Array.from({ length: 21 }, (_, index) => ({
    atMs: index * 1000, chord: index % 2 === 0 ? 'A' as const : 'D' as const,
  }));
  const events = references.slice(1).map(({ chord, atMs }) => ({ chord, atMs: atMs + 200 }));
  const timingReview = {
    references,
    evidence: 'Independent timecoded event log',
    attested: true,
  };
  const report = JSON.parse(serializeReport({ ...run, references, events }, metadata, timingReview));
  expect(report.references).toEqual(references);
  expect(report.rawButtonReferences).toEqual(references);
  expect(report.reviewedReferences).toEqual(references);
  expect(report.timingReview).toMatchObject({
    status: 'independently-verified', evidence: 'Independent timecoded event log', attested: true,
  });
  expect(report.results).toMatchObject({ precision: 1, recall: 1, passed: true });
  expect(report.gatePassed).toBe(true);
});

test('button-reaction times remain provisional even when their metrics pass', () => {
  const references = Array.from({ length: 21 }, (_, index) => ({
    atMs: index * 1000, chord: index % 2 === 0 ? 'A' as const : 'D' as const,
  }));
  const events = references.slice(1).map(({ chord, atMs }) => ({ chord, atMs: atMs + 200 }));
  const report = JSON.parse(serializeReport({ ...run, references, events }, metadata));

  expect(report.rawResults).toMatchObject({ precision: 1, recall: 1, passed: true });
  expect(report.results).toBeNull();
  expect(report.reviewedReferences).toBeNull();
  expect(report.timingReview.status).toBe('not-certified');
  expect(report.gatePassed).toBe(false);
  expect(report.warning).toMatch(/button-reaction/i);
});

test('independently reviewed times can match a detector event before its button reaction', () => {
  const references = Array.from({ length: 21 }, (_, index) => ({
    atMs: index * 1000, chord: index % 2 === 0 ? 'A' as const : 'D' as const,
  }));
  const reviewedReferences = references.map(({ chord, atMs }, index) => ({
    chord, atMs: index === 0 ? 0 : atMs - 200,
  }));
  const events = references.slice(1).map(({ chord, atMs }) => ({ chord, atMs: atMs - 100 }));
  const report = JSON.parse(serializeReport(
    { ...run, references, events },
    metadata,
    { references: reviewedReferences, evidence: 'External timecoded observation', attested: true },
  ));

  expect(report.rawButtonReferences).toEqual(references);
  expect(report.reviewedReferences).toEqual(reviewedReferences);
  expect(report.results).toMatchObject({ precision: 1, recall: 1, passed: true });
  expect(report.gatePassed).toBe(true);
});

test('edited times without a fresh attestation remain provisional', () => {
  const references = Array.from({ length: 21 }, (_, index) => ({
    atMs: index * 1000, chord: index % 2 === 0 ? 'A' as const : 'D' as const,
  }));
  const events = references.slice(1).map(({ chord, atMs }) => ({ chord, atMs: atMs + 200 }));
  const corrected = references.map(({ chord, atMs }, index) => ({
    chord, atMs: index === 0 ? 0 : atMs + 100,
  }));
  const report = JSON.parse(serializeReport(
    { ...run, references, events },
    metadata,
    { references: corrected, evidence: 'Independent timecode', attested: false },
  ));

  expect(report.reviewedReferences).toEqual(corrected);
  expect(report.timingReview.provenance).toBe('user-edited-unverified-times');
  expect(report.results).toBeNull();
  expect(report.gatePassed).toBe(false);
});

const invalidTimingReviews: readonly {
  description: string;
  references: readonly Reference[];
}[] = [
  {
    description: 'nonmonotonic times',
    references: [
      { atMs: 0, chord: 'A' }, { atMs: 20, chord: 'D' }, { atMs: 10, chord: 'A' },
    ],
  },
  {
    description: 'a time at the exclusive end',
    references: [{ atMs: 0, chord: 'A' }, { atMs: 31000, chord: 'D' }],
  },
  {
    description: 'a non-finite time',
    references: [{ atMs: 0, chord: 'A' }, { atMs: Number.NaN, chord: 'D' }],
  },
  {
    description: 'a changed starting origin',
    references: [{ atMs: 1, chord: 'A' }],
  },
  {
    description: 'a changed label sequence',
    references: [{ atMs: 0, chord: 'A' }, { atMs: 10, chord: 'G' }],
  },
];

test.each(invalidTimingReviews)('rejects reviewed references with $description', ({ references }) => {
  expect(() => serializeReport(
    run,
    metadata,
    { references, evidence: 'External timecoded observation', attested: true },
  )).toThrow(/reference|time|label/i);
});

test('an attestation cannot certify timing without independent timing evidence', () => {
  expect(() => serializeReport(run, metadata, {
    references: run.references, evidence: '', attested: true,
  })).toThrow(/independent timing evidence/i);
});

test('control no-events reporting uses actual measured duration and established source', () => {
  const control = { ...run, config: { ...run.config, mode: 'silence' as const }, sourceAtStart: 'A' as const };
  const report = JSON.parse(serializeReport(control, metadata));
  expect(report.results).toEqual({ durationMs: 31000, countedEventCount: 0, passed: true });
  expect(report.gatePassed).toBe(true);
  expect(JSON.parse(serializeReport({ ...control, elapsedMs: 29999 }, metadata)).gatePassed).toBe(false);
  expect(JSON.parse(serializeReport({ ...control, sourceAtStart: null }, metadata)).gatePassed).toBe(false);
});

test('exploratory and interrupted reports cannot claim gate evidence', () => {
  const exploratory = { ...run, config: { ...run.config, independent: false }, references: [] };
  expect(JSON.parse(serializeReport(exploratory, metadata))).toMatchObject({
    evidence: 'exploratory', gatePassed: false, results: null,
  });
  expect(JSON.parse(serializeReport({ ...run, discarded: true, references: [] }, metadata)))
    .toMatchObject({ evidence: 'discarded', gatePassed: false, results: null });
});

test.each([NaN, Infinity, -Infinity])('export rejects non-finite value %s before JSON can coerce it', (value) => {
  expect(() => serializeReport({ ...run, elapsedMs: value }, metadata)).toThrow(/finite/i);
  expect(() => serializeReport({ ...run, settings: { sampleRate: value } }, metadata)).toThrow(/finite/i);
  expect(() => serializeReport({ ...run, events: [{ chord: 'D', atMs: value }] }, metadata)).toThrow(/finite/i);
});

test('export allowlists metadata, settings, labels and events, excluding audio and device identifiers', () => {
  const contaminated = {
    ...run, samples: new Float32Array([0.5]), settings: { sampleRate: 48000, deviceId: 'private' },
    references: [{ atMs: 0, chord: 'A' as const, samples: [0.2] }],
  };
  const contaminatedMetadata = { ...metadata, samples: [0.1] };
  const text = serializeReport(contaminated, contaminatedMetadata);
  expect(text).not.toContain('samples');
  expect(text).not.toContain('private');
  expect(JSON.parse(text).parameters).toHaveProperty('calibrationMs', 2000);
  expect(JSON.parse(text).parameters).toMatchObject({
    scoring: 'voicing-cosine-distinctive-notes', octaveHarmonicAllowance: 1, minimumChordToneEnergy: 0.14,
  });
  expect(JSON.parse(text).parameters).not.toHaveProperty('outOfChordPenalty');
});

test('export requires a finished run and reviewed device/browser description', () => {
  expect(() => serializeReport({ ...run, phase: 'running' }, metadata)).toThrow(/finish/i);
  expect(() => serializeReport(run, { ...metadata, reviewed: false })).toThrow(/review/i);
});

test('exports the true analysis rate rather than conflating it with track settings', () => {
  const report = JSON.parse(serializeReport({
    ...run, analysisSampleRate: 48000, settings: { sampleRate: 44100 },
  }, metadata));
  expect(report.analysisSampleRate).toBe(48000);
  expect(report.settings.sampleRate).toBe(44100);
});
