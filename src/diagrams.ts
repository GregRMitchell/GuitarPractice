import { CHORDS, type Chord } from './chords';

const TUNING = [40, 45, 50, 55, 59, 64] as const;
const STRING_NAMES = ['low E', 'A', 'D', 'G', 'B', 'high E'] as const;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Get frets from low E to high E for the detector's standard open voicing.
 * @param chord Supported open chord.
 * @returns Six fret numbers; null means do not play that string.
 */
export function chordFrets(chord: Chord): readonly (number | null)[] {
  const notes = CHORDS[chord].midiNotes;
  const muted = TUNING.length - notes.length;
  return TUNING.map((open, index) => index < muted ? null : notes[index - muted]! - open);
}

function node(tag: string, attributes: Readonly<Record<string, string>>): SVGElement {
  const result = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, value);
  return result;
}

/**
 * Draw an accessible open-chord fretboard using safe SVG DOM operations.
 * @param chord Supported chord whose reference fingering is shown.
 * @returns A labeled diagram with open/muted strings and fretted positions.
 */
export function chordDiagram(chord: Chord): SVGElement {
  const frets = chordFrets(chord);
  const description = frets.map((fret, index) =>
    `${STRING_NAMES[index]} ${fret === null ? 'muted' : fret === 0 ? 'open' : `fret ${fret}`}`).join(', ');
  const barre = chord === 'F' ? { fret: 1, start: 0 } : chord === 'Bm' ? { fret: 2, start: 1 } : null;
  const barreText = barre ? `; barre fret ${barre.fret} from ${STRING_NAMES[barre.start]} to high E` : '';
  const svg = node('svg', { viewBox: '0 0 160 148', role: 'img',
    'aria-label': `${chord} chord, standard tuning: ${description}${barreText}`, class: 'chord-diagram' });
  const title = node('title', {});
  title.textContent = `${chord}: ${description}${barreText}`;
  svg.append(title);
  for (let fret = 0; fret <= 4; fret++) {
    svg.append(node('line', { x1: '25', x2: '135', y1: String(30 + fret * 26),
      y2: String(30 + fret * 26), 'stroke-width': fret === 0 ? '4' : '1' }));
  }
  if (barre) {
    const y = String(17 + barre.fret * 26);
    svg.append(node('line', { x1: String(25 + barre.start * 22), x2: '135', y1: y, y2: y,
      'stroke-width': '14', 'stroke-linecap': 'round', class: 'barre' }));
  }
  frets.forEach((fret, index) => {
    const x = 25 + index * 22;
    svg.append(node('line', { x1: String(x), x2: String(x), y1: '30', y2: '134', 'stroke-width': '1' }));
    if (fret === null) {
      const marker = node('text', { x: String(x), y: '20', 'text-anchor': 'middle', class: 'mute' });
      marker.textContent = '×'; svg.append(marker);
    } else {
      svg.append(node('circle', { cx: String(x), cy: String(fret === 0 ? 13 : 17 + fret * 26),
        r: fret === 0 ? '5' : '8', class: fret === 0 ? 'open-string' : 'finger' }));
    }
  });
  return svg;
}
