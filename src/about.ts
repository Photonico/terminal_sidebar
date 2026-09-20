import { randomBytes as random_bytes } from 'node:crypto';
import * as vscode from 'vscode';

interface about_information {
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  repository?: string;
}

/** Only package metadata is displayed; the webview cannot choose files or URLs. */
export function about_metadata(value: unknown): about_information {
  const metadata = record(value);
  const repository_value = typeof metadata.repository === 'string'
    ? metadata.repository : record(metadata.repository).url;
  let repository: string | undefined;
  if (typeof repository_value === 'string') {
    try {
      const url = new URL(repository_value.replace(/^git\+/, ''));
      if (url.protocol === 'https:' && url.hostname === 'github.com'
        && !url.username && !url.password && !url.port && /^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\.git\/?$/, '');
        url.search = '';
        url.hash = '';
        repository = url.toString();
      }
    } catch { /* Invalid optional metadata is omitted rather than linked. */ }
  }
  return {
    name: text(metadata.displayName, text(metadata.name, 'Terminal Sidebar')),
    description: text(metadata.description, ''),
    version: text(metadata.version, 'Unknown'),
    author: text(typeof metadata.author === 'string' ? metadata.author : record(metadata.author).name, 'Unknown'),
    license: text(metadata.license, 'Unknown'),
    repository,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function escape_html(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export class about_panel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;

  constructor(private readonly context: vscode.ExtensionContext) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const information = about_metadata(this.context.extension.packageJSON);
    const logo = vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'logo.png');
    const panel = vscode.window.createWebviewPanel('terminalSidebar.about', `About ${information.name}`,
      vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'assets')],
      });
    this.panel = panel;
    panel.iconPath = logo;
    const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (this.panel !== panel) return;
      try {
        const action = record(message).type;
        if (action === 'open_repository' && information.repository) {
          await vscode.env.openExternal(vscode.Uri.parse(information.repository));
        } else if (action === 'open_license') {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.context.extensionUri, 'LICENSE'));
          await vscode.window.showTextDocument(document, { preview: true });
        }
      } catch {
        if (this.panel === panel) void vscode.window.showErrorMessage('Terminal Sidebar could not open the requested information.');
      }
    });
    panel.onDidDispose(() => {
      listener.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
    const nonce = random_bytes(18).toString('base64');
    panel.webview.html = about_html(information, panel.webview.asWebviewUri(logo).toString(), panel.webview.cspSource, nonce);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}

export function about_html(information: about_information, logo: string, csp_source: string, nonce: string): string {
  const escaped = Object.fromEntries(Object.entries(information).map(([key, value]) => [key, escape_html(value ?? '')]));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escape_html(csp_source)}; style-src 'nonce-${escape_html(nonce)}'; script-src 'nonce-${escape_html(nonce)}';">
<title>About ${escaped.name}</title>
<style nonce="${escape_html(nonce)}">
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
main { box-sizing: border-box; max-width: 640px; margin: 0 auto; padding: 32px 24px; }
header { display: flex; align-items: center; gap: 20px; margin-bottom: 24px; }
img { width: 80px; height: 80px; object-fit: contain; flex: none; }
h1 { margin: 0 0 8px; font-size: 1.8em; font-weight: 600; }
p { line-height: 1.5; margin: 0; }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: baseline; gap: 16px 24px; }
dt { color: var(--vscode-descriptionForeground); }
dd { margin: 0; overflow-wrap: anywhere; }
button { border: 1px solid transparent; border-radius: 4px; cursor: pointer; font: inherit; padding: 6px 10px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground); }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.repository { padding: 0; text-align: left; color: var(--vscode-textLink-foreground); background: transparent; overflow-wrap: anywhere; }
.repository:hover { color: var(--vscode-textLink-activeForeground); background: transparent; text-decoration: underline; }
@media (max-width: 360px) { header { align-items: flex-start; } img { width: 48px; height: 48px; } dl { gap: 12px; } }
</style></head><body><main>
<header><img src="${escape_html(logo)}" alt="${escaped.name} logo"><div><h1>${escaped.name}</h1><p>${escaped.description}</p></div></header>
<dl><dt>Version</dt><dd>${escaped.version}</dd><dt>Author</dt><dd>${escaped.author}</dd>
${information.repository ? `<dt>Repository</dt><dd><button class="repository" data-action="open_repository" title="Open GitHub repository in your browser" aria-label="Open GitHub repository">${escaped.repository}</button></dd>` : ''}
<dt>License</dt><dd><button data-action="open_license" title="Read the ${escaped.license} license" aria-label="Read the ${escaped.license} license">${escaped.license}</button></dd></dl>
</main><script nonce="${escape_html(nonce)}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (button) vscode.postMessage({ type: button.dataset.action });
});
</script></body></html>`;
}
