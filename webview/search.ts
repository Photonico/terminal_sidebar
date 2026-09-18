import type { SearchAddon, ISearchOptions } from '@xterm/addon-search';
import type { IDisposable } from '@xterm/xterm';

/*! Codicons find control icons, unmodified paths, Copyright Microsoft Corporation.
 * Source: https://github.com/microsoft/vscode-codicons/tree/main/src/icons
 * Licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/
 */
const find_icons = {
  caseSensitive: "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M4.02602 3.34176C4.16218 2.93404 4.83818 2.93398 4.97426 3.34176L6.97426 9.34274C6.97526 9.34674 6.97817 9.35544 6.97817 9.35544L7.97426 12.3427C8.06126 12.6047 7.91984 12.8875 7.65786 12.9756C7.60486 12.9926 7.55165 13.0009 7.49965 13.0009C7.29082 13.0008 7.09602 12.868 7.02602 12.6591L6.14028 10.0009H2.86L1.97426 12.6591C1.88728 12.919 1.60634 13.0634 1.34243 12.9746C1.08043 12.8866 0.93902 12.6038 1.02602 12.3418L2.02211 9.35544C2.02311 9.35144 2.02602 9.34274 2.02602 9.34274L4.02602 3.34176ZM3.19399 8.99997H5.80629L4.49965 5.08102L3.19399 8.99997Z\"/><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M11.8581 6.66794C13.165 6.73296 13.9427 7.48427 13.9967 8.69626L13.9997 8.83297V12.5078C13.9957 12.7568 13.809 12.9621 13.568 12.9951L13.4997 13C13.2469 12.9998 13.0376 12.8121 13.0045 12.5683L12.9997 12.5V12.4297C12.3407 12.8066 11.7316 13 11.1666 13C9.94081 12.9998 8.99965 12.1369 8.99965 10.833C8.99967 9.68299 9.79211 8.82889 11.1061 8.66989C11.7279 8.59493 12.3589 8.64164 12.9987 8.80954C12.9915 8.07194 12.6279 7.70704 11.8082 7.66598C11.1672 7.63398 10.7158 7.72415 10.4518 7.90915C10.2258 8.06799 9.91347 8.01301 9.75551 7.78708C9.59671 7.56115 9.65178 7.24878 9.87758 7.09079C10.3165 6.78283 10.9138 6.64715 11.6666 6.6611L11.8581 6.66794ZM12.7965 9.8154C12.2587 9.66749 11.7361 9.62551 11.2262 9.68747C10.4042 9.78747 9.99868 10.2244 9.99868 10.8574C9.99884 11.5881 10.474 12.0242 11.1657 12.0244C11.6196 12.0244 12.1777 11.8137 12.8336 11.3818L12.9987 11.2695V9.87594L12.7965 9.8154Z\"/>",
  wholeWord: "<path d=\"M15.5 12.5C15.776 12.5 16 12.724 16 13V13.5C16 14.327 15.327 15 14.5 15H1.5C0.673 15 0 14.327 0 13.5V13C0 12.724 0.224 12.5 0.5 12.5C0.776 12.5 1 12.724 1 13V13.5C1 13.775 1.224 14 1.5 14H14.5C14.776 14 15 13.775 15 13.5V13C15 12.724 15.224 12.5 15.5 12.5Z\"/><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M4.8584 5.6709C6.16516 5.73603 6.94308 6.48734 6.99707 7.69922L7 7.83594V11.5107C6.996 11.7596 6.80919 11.9649 6.56836 11.998L6.5 12.0029C6.24709 12.0029 6.038 11.8152 6.00488 11.5713L6 11.5029V11.4326C5.341 11.8096 4.73199 12.0029 4.16699 12.0029C2.941 12.0029 2 11.1399 2 9.83594C2.00003 8.68597 2.79247 7.83185 4.10645 7.67285C4.7283 7.59793 5.35918 7.64552 5.99902 7.81348C5.99202 7.07548 5.62762 6.70995 4.80762 6.66895C4.16686 6.637 3.7161 6.72717 3.45215 6.91211C3.22615 7.07111 2.91386 7.01604 2.75586 6.79004C2.5969 6.56404 2.65194 6.25174 2.87793 6.09375C3.31692 5.78579 3.91404 5.65006 4.66699 5.66406L4.8584 5.6709ZM5.79688 8.81836C5.25888 8.67037 4.73558 8.62843 4.22559 8.69043C3.40389 8.79054 2.99902 9.22747 2.99902 9.86035C2.99917 10.5911 3.47413 11.0273 4.16602 11.0273C4.62001 11.0273 5.17799 10.8168 5.83398 10.3848L5.99902 10.2725V8.87891L5.79688 8.81836Z\"/><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M9.55078 2.00586C9.78578 2.02986 9.97307 2.21715 9.99707 2.45215C10 2.46907 10 2.48601 10 2.50293V6.60254C10.418 6.22566 10.9371 6.00293 11.5 6.00293C12.881 6.00293 14 7.34596 14 9.00293C14 10.6599 12.881 12.0029 11.5 12.0029C10.9371 12.0029 10.418 11.7802 10 11.4033V11.5029C10 11.7619 9.80278 11.974 9.55078 12C9.53385 12.003 9.51693 12.0029 9.5 12.0029C9.224 12.0029 9 11.7789 9 11.5029V2.50293C9 2.486 9.00095 2.46907 9.00293 2.45215C9.02793 2.20015 9.241 2.00293 9.5 2.00293C9.51692 2.00293 9.53386 2.00388 9.55078 2.00586ZM11.4355 7.00391C11.0307 7.03208 10.5769 7.31545 10.29 7.82227C10.1232 8.12611 10.018 8.49479 10.002 8.89453C9.99995 8.92952 10 8.96597 10 9.00195C10 9.03795 10.001 9.07438 10.002 9.10938C10.018 9.50814 10.1222 9.87582 10.2891 10.1797C10.576 10.6875 11.0307 10.9728 11.4355 11C11.4565 11.002 11.478 11.002 11.5 11.002C11.522 11.002 11.5435 11.001 11.5645 11C11.9693 10.9728 12.424 10.6875 12.7109 10.1797C12.8778 9.87582 12.982 9.50814 12.998 9.10938C13 9.07438 13 9.03795 13 9.00195C13 8.96597 12.999 8.92952 12.998 8.89453C12.982 8.49479 12.8768 8.12611 12.71 7.82227C12.4231 7.31545 11.9693 7.03109 11.5645 7.00391C11.5435 7.00191 11.522 7.00195 11.5 7.00195C11.478 7.00195 11.4565 7.00291 11.4355 7.00391Z\"/>",
  regex: "<path d=\"M11.498 5H9.705L10.973 3.732C11.168 3.537 11.168 3.22 10.973 3.025C10.778 2.83 10.461 2.83 10.266 3.025L8.998 4.293V2.5C8.998 2.224 8.774 2 8.498 2C8.222 2 7.998 2.224 7.998 2.5V4.293L6.73 3.025C6.535 2.83 6.218 2.83 6.023 3.025C5.828 3.22 5.828 3.537 6.023 3.732L7.291 5H5.498C5.222 5 4.998 5.224 4.998 5.5C4.998 5.776 5.222 6 5.498 6H7.291L6.023 7.268C5.828 7.463 5.828 7.78 6.023 7.975C6.121 8.073 6.249 8.121 6.377 8.121C6.505 8.121 6.633 8.072 6.731 7.975L7.999 6.707V8.5C7.999 8.776 8.223 9 8.499 9C8.775 9 8.999 8.776 8.999 8.5V6.707L10.267 7.975C10.365 8.073 10.493 8.121 10.621 8.121C10.749 8.121 10.877 8.072 10.975 7.975C11.17 7.78 11.17 7.463 10.975 7.268L9.707 6H11.5C11.776 6 12 5.776 12 5.5C12 5.224 11.776 5 11.5 5H11.498ZM5 12C5 12.552 4.552 13 4 13C3.448 13 3 12.552 3 12C3 11.448 3.448 11 4 11C4.552 11 5 11.448 5 12Z\"/>",
  previous: "<path d=\"M13.854 7.14576L8.85401 2.14576C8.65901 1.95076 8.34201 1.95076 8.14701 2.14576L3.14601 7.14576C2.95101 7.34076 2.95101 7.65776 3.14601 7.85276C3.34101 8.04776 3.65801 8.04776 3.85301 7.85276L7.99901 3.70676V13.4998C7.99901 13.7758 8.22301 13.9998 8.49901 13.9998C8.77501 13.9998 8.99901 13.7758 8.99901 13.4998V3.70676L13.145 7.85276C13.243 7.95076 13.371 7.99876 13.499 7.99876C13.627 7.99876 13.755 7.94976 13.853 7.85276C14.048 7.65776 14.048 7.34076 13.853 7.14576H13.854Z\"/>",
  next: "<path d=\"M13.854 8.146C13.659 7.951 13.342 7.951 13.147 8.146L9.00096 12.292V2.5C9.00096 2.224 8.77696 2 8.50096 2C8.22496 2 8.00096 2.224 8.00096 2.5V12.293L3.85496 8.147C3.65996 7.952 3.34296 7.952 3.14796 8.147C2.95296 8.342 2.95296 8.659 3.14796 8.854L8.14796 13.854C8.24596 13.952 8.37396 14 8.50196 14C8.62996 14 8.75796 13.951 8.85596 13.854L13.856 8.854C14.051 8.659 14.051 8.342 13.856 8.147L13.854 8.146Z\"/>",
  close: "<path d=\"M13.85 13.1502C14.05 13.3502 14.05 13.6602 13.85 13.8602C13.75 13.9602 13.62 14.0102 13.5 14.0102C13.38 14.0102 13.24 13.9602 13.15 13.8602L8 8.71023L2.85 13.8602C2.75 13.9602 2.62 14.0102 2.5 14.0102C2.38 14.0102 2.24 13.9602 2.15 13.8602C1.95 13.6602 1.95 13.3502 2.15 13.1502L7.3 8.00023L2.15 2.85023C1.95 2.65023 1.95 2.34023 2.15 2.14023C2.35 1.94023 2.66 1.94023 2.86 2.14023L8.01 7.29023L13.16 2.14023C13.36 1.94023 13.67 1.94023 13.87 2.14023C14.07 2.34023 14.07 2.65023 13.87 2.85023L8.72 8.00023L13.87 13.1502H13.85Z\"/>",
};

export interface search_target {
  id: string;
  search: SearchAddon;
}

interface search_options {
  parent: HTMLElement;
  before: HTMLElement;
  target(): search_target | undefined;
  focus(id: string): void;
  layout(): void;
  replace?(): void;
}

export function is_find_shortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>, is_mac: boolean): boolean {
  return event.key.toLowerCase() === 'f' && !event.altKey && !event.shiftKey && !event.isComposing
    && (is_mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

export function is_replace_shortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'> & { code?: string }, is_mac: boolean): boolean {
  if (event.isComposing || event.shiftKey) return false;
  // On macOS Option+F produces "ƒ" in KeyboardEvent.key; code retains the physical shortcut.
  return is_mac ? (event.code === 'KeyF' || event.key.toLowerCase() === 'f') && event.metaKey && event.altKey && !event.ctrlKey
    : event.key.toLowerCase() === 'h' && event.ctrlKey && !event.metaKey && !event.altKey;
}

/** One compact find widget follows the selected terminal; addons remain per terminal. */
export class terminal_search {
  readonly root = document.createElement('section');
  private readonly input = document.createElement('input');
  private readonly status = document.createElement('span');
  private readonly toggles = new Map<'caseSensitive' | 'wholeWord' | 'regex', HTMLButtonElement>();
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private target?: search_target;
  private results_listener?: IDisposable;

  constructor(private readonly options: search_options) {
    this.root.className = 'terminal_find';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Find in terminal');
    this.root.setAttribute('role', 'search');
    const row = document.createElement('div');
    row.className = 'terminal_find_row';
    const field = document.createElement('div');
    field.className = 'terminal_find_field';
    const controls = document.createElement('div');
    controls.className = 'terminal_find_options';
    this.root.append(row);
    if (options.replace) {
      const replace = document.createElement('button');
      replace.type = 'button';
      replace.className = 'terminal_find_button';
      replace.title = 'Replace in editable copy';
      replace.setAttribute('aria-label', replace.title);
      replace.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" d="m6 3 5 5-5 5"/></svg>';
      replace.addEventListener('click', () => options.replace!());
      row.append(replace);
    }
    row.append(field);
    field.append(this.input, controls);
    this.input.type = 'text';
    this.input.className = 'terminal_find_input';
    this.input.placeholder = 'Find';
    this.input.setAttribute('aria-label', 'Find in terminal');
    this.input.setAttribute('aria-describedby', 'terminal_find_status');
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.maxLength = 4096;
    for (const [key, label] of [
      ['caseSensitive', 'Match Case'], ['wholeWord', 'Match Whole Word'], ['regex', 'Use Regular Expression'],
    ] as const) {
      const button = this.button(controls, key, label, () => {
        button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
        this.find(false, true);
      });
      button.setAttribute('aria-pressed', 'false');
      this.toggles.set(key, button);
    }

    this.status.id = 'terminal_find_status';
    this.status.className = 'terminal_find_status';
    this.status.role = 'status';
    this.status.setAttribute('aria-live', 'polite');
    row.append(this.status);
    const actions = document.createElement('div');
    actions.className = 'terminal_find_actions';
    row.append(actions);
    this.previous = this.button(actions, 'previous', 'Previous Match (Shift+Enter)', () => this.find(true));
    this.next = this.button(actions, 'next', 'Next Match (Enter)', () => this.find(false));
    this.button(actions, 'close', 'Close (Escape)', () => this.close());
    this.set_status('');
    this.input.addEventListener('input', () => this.find(false, true));
    this.input.addEventListener('blur', () => this.target?.search.clearActiveDecoration());
    this.root.addEventListener('keydown', event => {
      if (event.isComposing) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (event.key === 'Enter' && event.target === this.input) {
        event.preventDefault();
        this.find(event.shiftKey);
      }
    });
    options.parent.insertBefore(this.root, options.before);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  private button(parent: HTMLElement, icon: keyof typeof find_icons, label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'terminal_find_button';
    button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${find_icons[icon]}</svg>`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', action);
    parent.append(button);
    return button;
  }

  open(): void {
    if (!this.options.target()) {
      return;
    }
    this.root.hidden = false;
    this.refresh();
    this.input.focus();
    this.input.select();
    this.options.layout();
  }

  refresh(): void {
    if (!this.visible) {
      return;
    }
    const target = this.options.target();
    if (target?.id === this.target?.id) {
      return;
    }
    this.results_listener?.dispose();
    this.results_listener = undefined;
    this.target?.search.clearDecorations();
    this.target = target;
    if (!target) {
      this.close(false);
      return;
    }
    this.results_listener = target.search.onDidChangeResults(result => {
      const has_results = !!this.input.value && result.resultCount > 0;
      this.set_status(!this.input.value ? '' : !has_results ? 'No results'
        : result.resultIndex < 0 ? `${result.resultCount}+ results` : `${result.resultIndex + 1} of ${result.resultCount}`, has_results);
      this.root.classList.toggle('terminal_find_no_results', !!this.input.value && !has_results);
    });
    this.find(false, true);
  }

  private find(previous: boolean, incremental = false): void {
    if (!this.target) {
      return;
    }
    this.input.removeAttribute('aria-invalid');
    this.root.classList.remove('terminal_find_no_results');
    if (!this.input.value) {
      this.target.search.clearDecorations();
      this.set_status('');
      return;
    }
    const options: ISearchOptions = { incremental };
    for (const [key, button] of this.toggles) {
      options[key] = button.getAttribute('aria-pressed') === 'true';
    }
    if (options.regex) {
      try {
        new RegExp(this.input.value);
      } catch {
        this.target.search.clearDecorations();
        this.input.setAttribute('aria-invalid', 'true');
        this.set_status('Invalid regular expression');
        this.root.classList.add('terminal_find_no_results');
        return;
      }
    }
    const styles = getComputedStyle(document.body);
    const color = (...tokens: string[]): string => tokens.map(token => styles.getPropertyValue(`--vscode-${token}`).trim()).find(Boolean) || styles.color;
    const match = color('terminal-findMatchHighlightBorder', 'editor-findMatchHighlightBorder', 'focusBorder');
    const active = color('terminal-findMatchBorder', 'editor-findMatchBorder', 'focusBorder');
    options.decorations = {
      matchBorder: match,
      matchOverviewRuler: match,
      activeMatchBorder: active,
      activeMatchColorOverviewRuler: active,
    };
    const found = previous ? this.target.search.findPrevious(this.input.value, options) : this.target.search.findNext(this.input.value, options);
    if (!found) {
      this.set_status('No results');
      this.root.classList.add('terminal_find_no_results');
    }
  }

  private set_status(text: string, has_results = false): void {
    this.status.textContent = text;
    this.status.title = text;
    this.previous.disabled = !has_results;
    this.next.disabled = !has_results;
  }

  /** Release before disposing an xterm instance; clearDecorations needs its live buffer. */
  release(id: string): void {
    if (this.target?.id === id) {
      this.close(false);
    }
  }

  close(restore = true): void {
    const id = this.target?.id;
    this.results_listener?.dispose();
    this.results_listener = undefined;
    this.target?.search.clearDecorations();
    this.target = undefined;
    this.root.hidden = true;
    this.options.layout();
    if (restore && id) {
      this.options.focus(id);
    }
  }

  dispose(): void {
    this.close(false);
    this.root.remove();
  }
}
