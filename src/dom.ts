type Child = Node | string | number | false | null | undefined;
type Props = Record<string, string | number | boolean | EventListener | undefined> & {
  class?: string;
  dataset?: never;
};

/**
 * Tiny element factory. Children become text nodes, so imported content can
 * never be interpreted as HTML.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = String(value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

const SVG = 'http://www.w3.org/2000/svg';
export function svg(
  tag: string,
  attrs: Record<string, string | number> = {},
  ...children: (SVGElement | string)[]
): SVGElement {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  for (const child of children)
    element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  return element;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

/** Save text as a file without any network request (blob: URLs stay in the tab). */
export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const formatDate = (time?: number) =>
  time ? new Date(time).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
export const formatNumber = (n: number) => n.toLocaleString('en');
