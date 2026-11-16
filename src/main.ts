import { createDrill } from './drill';
import type { Pair } from './chords';

const pair: Pair = ['A', 'D'];
const drill = createDrill(pair);
const pairLabel = document.querySelector<HTMLElement>('#pair');
const startButton = document.querySelector<HTMLButtonElement>('#start');
const status = document.querySelector<HTMLElement>('#status');

if (pairLabel !== null) pairLabel.textContent = pair.join(' and ');

if (startButton !== null && status !== null) {
  startButton.addEventListener('click', () => {
    drill.resume();
    startButton.disabled = true;
    status.textContent = 'Drill started. Microphone capture is not available yet.';
  });
}
