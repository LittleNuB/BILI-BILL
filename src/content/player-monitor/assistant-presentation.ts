import type { CurrentVideoSummaryHighlightsResult } from '../../shared/types/current-video-summary';

// Lucide, revision 94e4cb9d9db5907053ebf3636a97c45529cf776b.
// Original geometry; ISC and Feather MIT notices in third_party/licenses/Lucide.txt.
const paths = {
  down: ['m6 9 6 6 6-6'],
  minus: ['M5 12h14'],
  refresh: ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5'],
};
export function assistantIcon(name: keyof typeof paths | 'more'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(key, value);
  if (name === 'more') {
    for (const x of [12, 19, 5]) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', '12');
      dot.setAttribute('r', '1');
      svg.appendChild(dot);
    }
  } else for (const d of paths[name]) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export function compactSummaryText(
  summary: CurrentVideoSummaryHighlightsResult | null,
  matchingContext: boolean,
): string | null {
  if (!matchingContext || summary?.status !== 'ready' || !summary.current || summary.priorGenerated) return null;
  return summary.summarySentences.map((sentence) => sentence.text.trim()).filter(Boolean).join(' ') || null;
}

let observing = false;
let target: HTMLElement | null = null;

function pageIsDark(): boolean {
  for (const element of [document.documentElement, document.body]) {
    const theme = element.getAttribute('data-theme') ?? element.getAttribute('theme');
    if (theme === 'dark' || theme === 'light') return theme === 'dark';
    if (element.matches('.dark, .dark-mode, .theme-dark, .bili-dark')) return true;
  }
  // Read the host page's own tokens/background, never extension preferences.
  const body = getComputedStyle(document.body);
  const root = getComputedStyle(document.documentElement);
  const color = body.getPropertyValue('--bg1').trim() || root.getPropertyValue('--bg1').trim();
  const values = [color, body.backgroundColor, root.backgroundColor];
  for (const value of values) {
    let rgb: number[] | null = null;
    if (/^#[a-f\d]{6}$/i.test(value)) rgb = [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
    else if (/^#[a-f\d]{3}$/i.test(value)) rgb = [1, 2, 3].map((offset) => parseInt(value[offset].repeat(2), 16));
    else if (/^rgba?\(/.test(value)) {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      if (channels.length >= 3 && (channels.length < 4 || channels[3] >= .95)) rgb = channels.slice(0, 3);
    }
    if (rgb) return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 128;
  }
  if (body.colorScheme === 'dark' || body.colorScheme === 'light') return body.colorScheme === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

export function followAssistantPageTheme(element: HTMLElement): void {
  target = element;
  const update = () => { if (target) target.dataset.theme = pageIsDark() ? 'dark' : 'light'; };
  update();
  if (observing) return;
  observing = true;
  const observer = new MutationObserver(update);
  const config = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'theme'] };
  observer.observe(document.documentElement, config);
  observer.observe(document.body, config);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
}
