/**
 * Find a required screen element, throwing for incomplete markup.
 * @param id Required element ID.
 * @returns The matching typed HTML element.
 */
export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing screen element: ${id}`);
  return found as T;
}

/**
 * Update text only when it changes, avoiding repeated live-region announcements.
 * @param id Target element ID.
 * @param value Plain text to display.
 * @returns Nothing.
 */
export function text(id: string, value: string): void {
  const target = element(id);
  if (target.textContent !== value) target.textContent = value;
}

/**
 * Set a screen button's availability.
 * @param id Target button ID.
 * @param disabled Whether to prevent activation.
 * @returns Nothing.
 */
export function button(id: string, disabled: boolean): void {
  element<HTMLButtonElement>(id).disabled = disabled;
}
