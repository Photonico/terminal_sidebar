import { randomBytes as random_bytes } from 'node:crypto';
import * as vscode from 'vscode';
import { usage_guides, usage_languages, type usage_guide, type usage_language } from './usage_content';

const language_key = 'usage_language';
const language_labels: Record<usage_language, { label: string; title: string; html_lang: string }> = {
  en: { label: 'EN', title: 'Read in English', html_lang: 'en' },
  zh: { label: '中文', title: '阅读中文说明', html_lang: 'zh-Hans' },
  ja: { label: '日本語', title: '日本語の説明を読む', html_lang: 'ja' },
};

export function is_usage_language(value: unknown): value is usage_language {
  return typeof value === 'string' && usage_languages.includes(value as usage_language);
}

export function initial_usage_language(saved: unknown, locale: string): usage_language {
  if (is_usage_language(saved)) return saved;
  return /^zh(?:-|$)/i.test(locale) ? 'zh' : /^ja(?:-|$)/i.test(locale) ? 'ja' : 'en';
}

/** Bundled, offline help. The only incoming action is a validated language choice. */
export class usage_panel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private language?: usage_language;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  show(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('terminalSidebar.usage', 'Terminal Sidebar: Usage',
      vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    this.panel = panel;
    this.language ??= initial_usage_language(this.context.globalState.get(language_key), vscode.env.language);
    const listener = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (this.panel !== panel || !message || typeof message !== 'object' || Array.isArray(message)) return;
      const value = message as Record<string, unknown>;
      if (value.type !== 'usage_language' || !is_usage_language(value.language)) return;
      const language = value.language;
      this.language = language;
      // Serialize quick switches so the newest choice is always the last stored value.
      this.writes = this.writes.then(() => this.context.globalState.update(language_key, language)).catch(() => {
        if (this.panel === panel) void vscode.window.showWarningMessage('The Usage language could not be remembered.');
      });
    });
    panel.onDidDispose(() => {
      listener.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
    panel.webview.html = usage_html(this.language, random_bytes(18).toString('base64'));
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}

function escape_html(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Inline code is the only markup in help text; escape before adding its fixed tags. */
function inline_text(value: string): string {
  return escape_html(value).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function guide_html(language: usage_language, guide: usage_guide, selected: usage_language): string {
  return `<article id="guide-${language}" lang="${language_labels[language].html_lang}" ${language !== selected ? 'hidden' : ''}>
<h1>Terminal Sidebar · ${escape_html(guide.title)}</h1><p class="summary">${escape_html(guide.summary)}</p>
<nav aria-label="${escape_html(guide.contents)}"><h2>${escape_html(guide.contents)}</h2><ol>${guide.sections.map(section =>
    `<li><a href="#${language}-${section.id}" title="${escape_html(section.title)}">${escape_html(section.title)}</a></li>`).join('')}</ol></nav>
${guide.sections.map(section => `<section id="${language}-${section.id}"><h2>${escape_html(section.title)}</h2>
${(section.paragraphs ?? []).map(paragraph => `<p>${inline_text(paragraph)}</p>`).join('')}
${section.items ? `<ul>${section.items.map(item => `<li>${inline_text(item)}</li>`).join('')}</ul>` : ''}
${section.code ? `<pre><code>${escape_html(section.code)}</code></pre>` : ''}</section>`).join('')}
</article>`;
}

export function usage_html(selected: usage_language, nonce: string): string {
  return `<!DOCTYPE html><html lang="${language_labels[selected].html_lang}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${escape_html(nonce)}'; script-src 'nonce-${escape_html(nonce)}';">
<title>Terminal Sidebar: Usage</title><style nonce="${escape_html(nonce)}">
:root { color-scheme: light dark; }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.6; }
[hidden] { display: none !important; }
* { box-sizing: border-box; }
header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 24px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-widget-border, transparent); }
header strong { font-weight: 600; }
.languages { display: flex; gap: 4px; }
button { cursor: pointer; border: 1px solid transparent; border-radius: var(--vscode-cornerRadius-small, 4px); padding: 4px 10px; font: inherit; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground); }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button[aria-pressed="true"]:hover { background: var(--vscode-button-hoverBackground); }
button:focus-visible, a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
main { max-width: 960px; margin: 0 auto; padding: 24px; }
h1 { margin: 0 0 8px; font-size: 1.8em; font-weight: 600; line-height: 1.3; }
h2 { margin: 24px 0 10px; font-size: 1.3em; font-weight: 600; line-height: 1.4; }
p { margin: 10px 0; }
.summary { color: var(--vscode-descriptionForeground); }
section { scroll-margin-top: 72px; }
nav { border-block: 1px solid var(--vscode-widget-border, transparent); padding-block: 8px; }
nav h2 { margin-top: 8px; }
nav ol { columns: 2; column-gap: 32px; }
li { margin-bottom: 8px; break-inside: avoid; }
ul, ol { padding-inline-start: 24px; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; }
a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
code { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textPreformat-foreground, var(--vscode-foreground)); background: var(--vscode-textPreformat-background); padding: 1px 3px; border-radius: var(--vscode-cornerRadius-small, 4px); overflow-wrap: anywhere; }
pre { overflow: auto; padding: 14px; border-radius: var(--vscode-cornerRadius-small, 4px); background: var(--vscode-textCodeBlock-background); }
pre code { padding: 0; background: transparent; white-space: pre; overflow-wrap: normal; }
@media (max-width: 500px) { header { flex-wrap: wrap; padding: 10px 16px; } main { padding: 20px 16px; } nav ol { columns: 1; } section { scroll-margin-top: 110px; } }
</style></head><body>
<header><strong>Usage</strong><div class="languages" role="group" aria-label="Language">${usage_languages.map(language => {
    const option = language_labels[language];
    return `<button type="button" data-language="${language}" lang="${option.html_lang}" title="${option.title}" aria-label="${option.title}" aria-pressed="${language === selected}">${option.label}</button>`;
  }).join('')}</div></header>
<main>${usage_languages.map(language => guide_html(language, usage_guides[language], selected)).join('')}</main>
<script nonce="${escape_html(nonce)}">
const vscode = acquireVsCodeApi();
function select_language(language) {
  if (!['en', 'zh', 'ja'].includes(language)) return;
  document.documentElement.lang = language === 'zh' ? 'zh-Hans' : language;
  document.querySelectorAll('article').forEach(article => { article.hidden = article.id !== 'guide-' + language; });
  document.querySelectorAll('button[data-language]').forEach(option => option.setAttribute('aria-pressed', String(option.dataset.language === language)));
}
const previous_state = vscode.getState();
if (previous_state && typeof previous_state === 'object') select_language(previous_state.language);
document.querySelectorAll('button[data-language]').forEach(button => button.addEventListener('click', () => {
  const language = button.dataset.language;
  if (!['en', 'zh', 'ja'].includes(language)) return;
  select_language(language);
  window.scrollTo(0, 0);
  vscode.setState({ language });
  vscode.postMessage({ type: 'usage_language', language });
}));
</script></body></html>`;
}
