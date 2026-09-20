import { terminal_menu, type menu_item } from './menu';

export interface tab_action_handlers {
  create(): void;
  preview(): void;
  find(): void;
  find_all(): void;
  close(): void;
  close_all(): void;
}

/** Both sidebars expose the same actions and keyboard-accessible context menus. */
export class tab_actions {
  readonly root = document.createElement('div');
  private readonly create: HTMLButtonElement;
  private readonly find: HTMLButtonElement;
  private readonly close: HTMLButtonElement;

  constructor(private readonly menu: terminal_menu, private readonly actions: tab_action_handlers) {
    this.root.className = 'tab_action_group';
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Tab actions');
    const button = (icon: string, label: string, hint: string, action: () => void) => {
      const element = document.createElement('button');
      element.type = 'button'; element.className = 'icon-button tab_action';
      element.title = `${label} · ${hint}`;
      element.setAttribute('aria-label', label);
      element.setAttribute('data-vscode-context', '{"preventDefaultContextMenuItems":true}');
      const glyph = document.createElement('span');
      glyph.className = `codicon codicon-${icon}`; glyph.setAttribute('aria-hidden', 'true');
      element.append(glyph); element.addEventListener('click', action);
      this.root.append(element);
      return element;
    };
    this.create = button('add', 'New terminal', 'Right-click for terminal or document preview', actions.create);
    this.find = button('search', 'Find in active tab', 'Right-click to search all open tabs', actions.find);
    this.close = button('close', 'Close active tab', 'Right-click for more close actions', actions.close);
    this.bind_menu(this.create, [
      { label: 'New terminal', action: actions.create },
      { label: 'Preview in Sidebar Terminal', action: actions.preview },
    ]);
    this.bind_menu(this.find, [
      { label: 'Find in active tab', action: actions.find },
      { label: 'Find in all open tabs', action: actions.find_all },
    ]);
    this.bind_menu(this.close, [
      { label: 'Close active tab', action: actions.close },
      { label: 'Close all open tabs', action: actions.close_all },
    ]);
  }

  new_menu(event: MouseEvent, anchor: HTMLElement): void {
    this.show(event, anchor, [
      { label: 'New terminal', action: this.actions.create },
      { label: 'Preview in Sidebar Terminal', action: this.actions.preview },
    ]);
  }

  private bind_menu(button: HTMLButtonElement, items: menu_item[]): void {
    button.addEventListener('contextmenu', event => this.show(event, button, items));
    button.addEventListener('keydown', event => {
      if (!button.disabled && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        this.show(event, button, items);
      }
    });
  }

  private show(event: MouseEvent | KeyboardEvent, anchor: HTMLElement, items: menu_item[]): void {
    event.preventDefault(); event.stopPropagation();
    const bounds = anchor.getBoundingClientRect();
    this.menu.show(items, ('clientX' in event && event.clientX) || bounds.left,
      ('clientY' in event && event.clientY) || bounds.bottom, () => anchor.focus());
  }

  update(available: boolean, has_tab: boolean, saving: boolean): void {
    this.create.disabled = !available || saving;
    this.find.disabled = !available || !has_tab || saving;
    this.close.disabled = !has_tab || saving;
  }
}
