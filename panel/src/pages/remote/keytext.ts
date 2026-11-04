/**
 * Znak z klawiatury ekranowej telefonu -> fizyczny klawisz (KeyboardEvent.code) + modyfikatory.
 * Pulpit zdalny przesyła klawisze, nie znaki (układ interpretuje komputer zdalny) — zakładamy układ
 * „Polski (programisty)”, standardowy w Polsce: ASCII jak w US, polskie litery przez prawy Alt.
 */
export interface KeyStroke {
  code: string;
  shift?: boolean;
  altGr?: boolean;
}

const UNSHIFTED: Record<string, string> = {
  ' ': 'Space',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\n': 'Enter',
  '\t': 'Tab',
};

const SHIFTED: Record<string, string> = {
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  $: 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0',
  _: 'Minus',
  '+': 'Equal',
  '{': 'BracketLeft',
  '}': 'BracketRight',
  '|': 'Backslash',
  ':': 'Semicolon',
  '"': 'Quote',
  '~': 'Backquote',
  '<': 'Comma',
  '>': 'Period',
  '?': 'Slash',
};

// polski układ programisty: prawy Alt + litera
const POLISH: Record<string, string> = { ą: 'KeyA', ć: 'KeyC', ę: 'KeyE', ł: 'KeyL', ń: 'KeyN', ó: 'KeyO', ś: 'KeyS', ź: 'KeyX', ż: 'KeyZ', '€': 'KeyU' };

/** Klawisz dla znaku albo null, gdy znaku nie da się wpisać (np. emoji). */
export function keyForChar(ch: string): KeyStroke | null {
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}` };
  if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, shift: true };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}` };
  if (UNSHIFTED[ch]) return { code: UNSHIFTED[ch] };
  if (SHIFTED[ch]) return { code: SHIFTED[ch], shift: true };
  // „inteligentne” cudzysłowy i myślniki z klawiatur telefonów -> zwykłe znaki
  const plain: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', ' ': ' ' };
  if (plain[ch]) return keyForChar(plain[ch]);
  const lower = ch.toLowerCase();
  if (POLISH[lower]) return { code: POLISH[lower], altGr: true, shift: ch !== lower };
  return null;
}
