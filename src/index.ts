import {
  OperationLock,
  SessionStateSchema,
  createSessionState,
  filterTodos,
  updateSessionState,
} from "./session";
import type { SessionState, TodoItem } from "./session";

declare const logseq: any;

type FocusSnapshot = {
  selector: string;
  selectionStart?: number;
  selectionEnd?: number;
};

const UI_KEY = "fetch-todos-selector";
const COMMAND_TRIGGER_DELAY_MS = 40;
const MAIN_UI_OPEN_DELAY_MS = 0;
const ESCAPE_CLOSE_GUARD_MS = 150;
const THEME_CSS_PROPS = [
  "--ls-primary-background-color",
  "--ls-secondary-background-color",
  "--ls-tertiary-background-color",
  "--ls-primary-text-color",
  "--ls-secondary-text-color",
  "--ls-border-color",
  "--ls-link-text-color",
  "--ls-selection-background-color",
] as const;
const operationLock = new OperationLock();
const sessions = new Map<string, SessionState>();
let activeSessionId: string | null = null;
let keyboardListenersBound = false;
let uiEventHandlersBound = false;
let selectorStylesLoaded = false;
let escapeCloseBlockedUntil = 0;
let debugLoggingEnabled = false;
const NESTING_DEPTH_OPTIONS = [
  { value: "0", label: "Page/root only" },
  { value: "1", label: "1 level deep" },
  { value: "2", label: "2 levels deep" },
  { value: "3", label: "3 levels deep" },
  { value: "all", label: "All levels" },
] as const;

function isDebugEnabled(): boolean {
  return debugLoggingEnabled;
}

function debugLog(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.info("[Fetch TODOs]", ...args);
  }
}

function setDebugLoggingEnabled(enabled: boolean): void {
  if (debugLoggingEnabled === enabled) {
    return;
  }

  debugLoggingEnabled = enabled;
  console.info(`[Fetch TODOs] debug logging ${enabled ? "enabled" : "disabled"}`);
}

function syncDebugLoggingSetting(settings: unknown = logseq.settings): void {
  const nextSettings = settings as { debugLogging?: unknown } | undefined;
  setDebugLoggingEnabled(Boolean(nextSettings?.debugLogging));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function blockEscapeCloseTemporarily(): void {
  escapeCloseBlockedUntil = Date.now() + ESCAPE_CLOSE_GUARD_MS;
}

function isEscapeCloseBlocked(): boolean {
  return Date.now() < escapeCloseBlockedUntil;
}

function saveSession(state: SessionState): SessionState {
  const parsed = SessionStateSchema.parse(state);
  sessions.set(parsed.sessionId, parsed);
  return parsed;
}

function getSession(sessionId: string | null): SessionState | null {
  if (!sessionId) {
    return null;
  }
  return sessions.get(sessionId) ?? null;
}

function updateSession(
  sessionId: string,
  updater: (current: SessionState) => SessionState,
): SessionState | null {
  const current = sessions.get(sessionId);
  if (!current) {
    return null;
  }
  const next = updater(current);
  const parsed = SessionStateSchema.parse(next);
  sessions.set(sessionId, parsed);
  return parsed;
}

function setSessionPatch(sessionId: string, patch: Partial<SessionState>): SessionState | null {
  const current = sessions.get(sessionId);
  if (!current) {
    return null;
  }
  const next = updateSessionState(current, patch);
  sessions.set(sessionId, next);
  return next;
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  const selector = [
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1,
  );
}

function bindKeyboardListeners(): void {
  if (keyboardListenersBound) {
    return;
  }
  keyboardListenersBound = true;

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    const session = getSession(activeSessionId);
    if (!session) {
      return;
    }

    const modal = document.querySelector<HTMLElement>(`.fts-modal[data-session-id='${session.sessionId}']`);
    if (!modal) {
      return;
    }

    if (event.key === "Escape") {
      if (isEscapeCloseBlocked()) {
        debugLog("ignored early Escape", { sessionId: session.sessionId });
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeSession(session.sessionId, "escape-keydown");
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement as HTMLElement | null;

    if (!activeElement || !modal.contains(activeElement)) {
      event.preventDefault();
      first.focus();
      return;
    }

    if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      event.stopPropagation();
      last.focus();
      return;
    }

    if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      event.stopPropagation();
      first.focus();
    }
  }, true);
}

function getAppRoot(): HTMLElement | null {
  return document.getElementById("app");
}

async function syncThemeVariables(): Promise<void> {
  const resolved = await logseq.UI.resolveThemeCssPropsVals([...THEME_CSS_PROPS]);
  if (!resolved) {
    return;
  }

  for (const prop of THEME_CSS_PROPS) {
    const value = resolved[prop];
    if (typeof value === "string" && value.trim().length > 0) {
      document.documentElement.style.setProperty(prop, value);
    }
  }
}

function getFocusSnapshot(session: SessionState): FocusSnapshot {
  const sessionId = session.sessionId;
  const activeElement = document.activeElement;
  const defaultSelector =
    session.status === "ready"
      ? `#fts-search-${sessionId}`
      : `.fts-modal[data-session-id='${sessionId}']`;

  if (!(activeElement instanceof HTMLElement)) {
    return { selector: defaultSelector };
  }

  if (!activeElement.closest(`.fts-root[data-session-id='${sessionId}']`)) {
    return { selector: defaultSelector };
  }

  if (activeElement.id === `fts-search-${sessionId}` && activeElement instanceof HTMLInputElement) {
    return {
      selector: `#fts-search-${sessionId}`,
      selectionStart: activeElement.selectionStart ?? activeElement.value.length,
      selectionEnd: activeElement.selectionEnd ?? activeElement.value.length,
    };
  }

  if (activeElement.matches(`.fts-item[data-session-id='${sessionId}']`)) {
    const itemIndex = activeElement.dataset.index;
    if (itemIndex) {
      return {
        selector: `.fts-item[data-session-id='${sessionId}'][data-index='${itemIndex}']`,
      };
    }
  }

  if (activeElement.dataset.sessionId === sessionId && activeElement.dataset.action) {
    const selector = `[data-session-id='${sessionId}'][data-action='${activeElement.dataset.action}']`;
    return { selector };
  }

  return { selector: `.fts-modal[data-session-id='${sessionId}']` };
}

function attachModalHandlers(sessionId: string, focusSnapshot: FocusSnapshot): void {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }

  window.requestAnimationFrame(() => {
    const nextSession = getSession(sessionId);
    if (!nextSession || activeSessionId !== sessionId) {
      return;
    }

    const modal = document.querySelector<HTMLElement>(`.fts-modal[data-session-id='${sessionId}']`);
    if (!modal) {
      return;
    }

    const focusTarget =
      document.querySelector<HTMLElement>(focusSnapshot.selector) ??
      (nextSession.status === "ready"
        ? document.querySelector<HTMLElement>(`#fts-search-${sessionId}`)
        : null) ??
      modal;

    focusTarget.focus({ preventScroll: true });

    if (focusTarget instanceof HTMLInputElement && focusSnapshot.selector === `#fts-search-${sessionId}`) {
      const selectionStart = focusSnapshot.selectionStart ?? focusTarget.value.length;
      const selectionEnd = focusSnapshot.selectionEnd ?? selectionStart;
      focusTarget.setSelectionRange(selectionStart, selectionEnd);
    }

    if (!nextSession.hasInitialFocus) {
      setSessionPatch(sessionId, { hasInitialFocus: true });
    }
  });
}

function closeSession(sessionId: string, reason = "unknown", restoreEditingCursor = true): void {
  debugLog("closing session", { sessionId, reason });
  sessions.delete(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = null;
  }
  const appRoot = getAppRoot();
  if (appRoot) {
    appRoot.innerHTML = "";
  }
  logseq.hideMainUI({ restoreEditingCursor });
}

function ensureSelectorStyles(): void {
  if (selectorStylesLoaded) {
    return;
  }
  selectorStylesLoaded = true;

  const styleElement = document.createElement("style");
  styleElement.id = UI_KEY;
  styleElement.textContent = `
    html,
    body,
    #app {
      width: 100%;
      height: 100%;
      margin: 0;
      background: transparent;
    }

    body {
      overflow: hidden;
    }

    .fts-root,
    .fts-root * {
      box-sizing: border-box;
      -webkit-app-region: no-drag;
    }

    .fts-root {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      color: var(--ls-primary-text-color, #0f172a);
      font-size: 1.05rem;
    }

    .fts-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(15, 23, 42, 0.18);
    }

    .fts-wrapper {
      position: relative;
      z-index: 1;
      min-height: 100%;
      display: flex;
      justify-content: center;
      padding: 4.5rem 0.75rem 0.75rem;
    }

    .fts-modal {
      width: min(42rem, calc(100vw - 1.5rem));
      max-height: min(86vh, 50rem);
      display: flex;
      flex-direction: column;
      border-radius: 0.75rem;
      border: 1px solid var(--ls-border-color, #d4d4d8);
      background: var(--ls-primary-background-color, #ffffff);
      color: var(--ls-primary-text-color, #0f172a);
      box-shadow: 0 20px 40px rgba(15, 23, 42, 0.25);
      overflow: hidden;
    }

    .fts-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.875rem 1rem;
      border-bottom: 1px solid var(--ls-border-color, #d4d4d8);
    }

    .fts-title {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 600;
      color: var(--ls-primary-text-color, #0f172a);
    }

    .fts-close-btn {
      width: 2rem;
      height: 2rem;
      border: 1px solid var(--ls-border-color, #d4d4d8);
      border-radius: 0.5rem;
      cursor: pointer;
      color: var(--ls-secondary-text-color, #475569);
      background: var(--ls-secondary-background-color, #f8fafc);
    }

    .fts-close-btn:hover {
      background: var(--ls-tertiary-background-color, #eef2ff);
    }

    .fts-body {
      padding: 0.875rem 1rem 0;
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 0.75rem;
      min-height: 0;
      overflow: hidden;
    }

    .fts-tools {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .fts-search {
      flex: 1;
      min-width: 12rem;
      border: 1px solid var(--ls-border-color, #d4d4d8);
      border-radius: 0.5rem;
      padding: 0.5rem 0.625rem;
      background: var(--ls-secondary-background-color, #ffffff);
      color: var(--ls-primary-text-color, #0f172a);
      font-size: 0.95rem;
    }

    .fts-depth {
      border: 1px solid var(--ls-border-color, #d4d4d8);
      border-radius: 0.5rem;
      padding: 0.5rem 0.625rem;
      background: var(--ls-secondary-background-color, #ffffff);
      color: var(--ls-primary-text-color, #0f172a);
      font-size: 0.9rem;
      min-width: 10.5rem;
      max-width: 12rem;
    }

    .fts-search:focus,
    .fts-depth:focus,
    .fts-action-btn:focus,
    .fts-close-btn:focus,
    .fts-item:focus,
    .fts-primary-btn:focus,
    .fts-secondary-btn:focus {
      outline: 2px solid var(--ls-link-text-color, #2563eb);
      outline-offset: 1px;
    }

    .fts-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .fts-action-btn {
      border: 1px solid var(--ls-border-color, #d4d4d8);
      border-radius: 0.5rem;
      background: var(--ls-secondary-background-color, #ffffff);
      color: var(--ls-primary-text-color, #0f172a);
      padding: 0.45rem 0.65rem;
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 500;
      white-space: nowrap;
    }

    .fts-action-btn:hover {
      background: var(--ls-tertiary-background-color, #f1f5f9);
    }

    .fts-count {
      font-size: 0.9rem;
      color: var(--ls-secondary-text-color, #64748b);
    }

    .fts-list {
      flex: 1;
      border: 1px solid var(--ls-border-color, #d4d4d8);
      border-radius: 0.6rem;
      overflow: auto;
      min-height: 12rem;
      background: var(--ls-secondary-background-color, #ffffff);
    }

    .fts-state {
      padding: 1.25rem;
      color: var(--ls-secondary-text-color, #64748b);
      text-align: center;
      line-height: 1.4;
      font-size: 0.98rem;
    }

    .fts-item {
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--ls-border-color, #d4d4d8);
      background: transparent;
      padding: 0.7rem 0.8rem;
      display: grid;
      grid-template-columns: 1.2rem 1fr;
      column-gap: 0.6rem;
      text-align: left;
      cursor: pointer;
      color: inherit;
      align-items: start;
    }

    .fts-item:last-child {
      border-bottom: 0;
    }

    .fts-item:hover {
      background: var(--ls-tertiary-background-color, #f8fafc);
    }

    .fts-check {
      width: 1rem;
      height: 1rem;
      border: 1px solid var(--ls-border-color, #94a3b8);
      border-radius: 0.25rem;
      margin-top: 0.15rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.82rem;
      line-height: 1;
      color: var(--ls-link-text-color, #2563eb);
      font-weight: 700;
    }

    .fts-item.is-selected .fts-check {
      border-color: var(--ls-link-text-color, #2563eb);
      background: var(--ls-link-text-color, #2563eb);
      color: #ffffff;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
      text-shadow: 0 0 1px rgba(0, 0, 0, 0.3);
    }

    .fts-content {
      font-size: 0.98rem;
      color: var(--ls-primary-text-color, #0f172a);
      margin-bottom: 0.18rem;
      line-height: 1.35;
    }

    .fts-meta {
      display: block;
      font-size: 0.84rem;
      color: var(--ls-secondary-text-color, #64748b);
      line-height: 1.3;
    }

    .fts-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      border-top: 1px solid var(--ls-border-color, #d4d4d8);
      padding: 0.75rem 1rem;
      background: var(--ls-primary-background-color, #ffffff);
    }

    .fts-footer-actions {
      display: flex;
      gap: 0.5rem;
    }

    .fts-secondary-btn,
    .fts-primary-btn {
      border-radius: 0.5rem;
      border: 1px solid var(--ls-border-color, #d4d4d8);
      font-size: 0.92rem;
      font-weight: 600;
      padding: 0.52rem 0.9rem;
      cursor: pointer;
    }

    .fts-secondary-btn {
      background: var(--ls-secondary-background-color, #ffffff);
      color: var(--ls-primary-text-color, #0f172a);
    }

    .fts-primary-btn {
      border-color: var(--ls-link-text-color, #2563eb);
      background: var(--ls-link-text-color, #2563eb);
      color: #ffffff;
    }

    .fts-primary-btn[disabled] {
      cursor: not-allowed;
      opacity: 0.5;
    }

    @media (max-width: 640px) {
      .fts-modal {
        width: calc(100vw - 0.9rem);
        max-height: 84vh;
      }

      .fts-tools {
        flex-direction: column;
        align-items: stretch;
      }

      .fts-actions {
        width: 100%;
        justify-content: flex-end;
      }

      .fts-footer {
        flex-direction: column;
        align-items: stretch;
      }

      .fts-footer-actions {
        justify-content: flex-end;
      }
    }
  `;
  document.head.appendChild(styleElement);
}

function renderReadyState(session: SessionState): string {
  const filtered = filterTodos(session.todos, session.searchQuery);
  const selectedCount = session.selectedIndices.length;
  const nestingOptionsHtml = NESTING_DEPTH_OPTIONS
    .map(
      (option) =>
        `<option value="${option.value}" ${session.nestingDepth === option.value ? "selected" : ""}>${option.label}</option>`,
    )
    .join("");

  const listHtml =
    filtered.length === 0
      ? `<div class="fts-state">No TODOs match your search.</div>`
      : filtered
          .map(({ index, todo }) => {
            const selected = session.selectedIndices.includes(index);
            return `
              <button
                type="button"
                class="fts-item ${selected ? "is-selected" : ""}"
                role="checkbox"
                aria-checked="${selected ? "true" : "false"}"
                data-session-id="${session.sessionId}"
                data-index="${index}"
                data-action="toggleTodo"
              >
                <span class="fts-check" aria-hidden="true">${selected ? "✓" : ""}</span>
                <span>
                  <span class="fts-content">${escapeHtml(todo.content)}</span>
                  <span class="fts-meta">Path: ${escapeHtml(todo.path)}</span>
                </span>
              </button>
            `;
          })
          .join("");

  return `
    <div class="fts-tools">
      <input
        id="fts-search-${session.sessionId}"
        class="fts-search"
        type="text"
        placeholder="Search TODOs or paths"
        value="${escapeHtml(session.searchQuery)}"
        aria-label="Search TODOs"
        data-action="updateSearchQuery"
        data-session-id="${session.sessionId}"
      />
      <select
        class="fts-depth"
        data-action="updateNestingDepth"
        data-session-id="${session.sessionId}"
        aria-label="Nesting depth to search"
      >
        ${nestingOptionsHtml}
      </select>
      <div class="fts-actions">
        <button
          type="button"
          class="fts-action-btn"
          data-action="selectAllTodos"
          data-session-id="${session.sessionId}"
        >
          Select all
        </button>
        <button
          type="button"
          class="fts-action-btn"
          data-action="clearSelection"
          data-session-id="${session.sessionId}"
        >
          Clear
        </button>
      </div>
    </div>
    <div class="fts-count">${selectedCount} selected</div>
    <div class="fts-list" role="listbox" aria-label="TODOs from ${escapeHtml(session.pageName)}">
      ${listHtml}
    </div>
  `;
}

function renderSessionBody(session: SessionState): string {
  if (session.status === "loading") {
    return `<div class="fts-state" role="status">Loading TODOs from referenced page...</div>`;
  }

  if (session.status === "error") {
    return `<div class="fts-state" role="alert">${escapeHtml(session.errorMessage ?? "Unknown error")}</div>`;
  }

  if (session.status === "empty") {
    return `<div class="fts-state">No TODOs found in [[${escapeHtml(session.pageName)}]].</div>`;
  }

  return renderReadyState(session);
}

function setTodoItemSelectedState(itemElement: HTMLElement, selected: boolean): void {
  itemElement.classList.toggle("is-selected", selected);
  itemElement.setAttribute("aria-checked", selected ? "true" : "false");

  const checkElement = itemElement.querySelector<HTMLElement>(".fts-check");
  if (checkElement) {
    checkElement.textContent = selected ? "✓" : "";
  }
}

function syncSelectionSummary(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session || session.status !== "ready" || activeSessionId !== sessionId) {
    return;
  }

  const selectedCount = session.selectedIndices.length;
  const countLabel = `${selectedCount} selected`;
  const rootSelector = `.fts-root[data-session-id='${sessionId}']`;

  for (const countElement of Array.from(document.querySelectorAll<HTMLElement>(`${rootSelector} .fts-count`))) {
    countElement.textContent = countLabel;
  }

  const addButton = document.querySelector<HTMLButtonElement>(
    `.fts-primary-btn[data-session-id='${sessionId}'][data-action='addSelectedTodos']`,
  );
  if (addButton) {
    addButton.disabled = selectedCount === 0;
  }
}

function syncVisibleTodoSelectionState(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session || session.status !== "ready" || activeSessionId !== sessionId) {
    return;
  }

  const selectedSet = new Set(session.selectedIndices);
  for (const itemElement of Array.from(document.querySelectorAll<HTMLElement>(`.fts-item[data-session-id='${sessionId}']`))) {
    const todoIndex = Number.parseInt(itemElement.dataset.index ?? "", 10);
    if (Number.isNaN(todoIndex)) {
      continue;
    }

    setTodoItemSelectedState(itemElement, selectedSet.has(todoIndex));
  }

  syncSelectionSummary(sessionId);
}

function renderTodoSelector(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session || activeSessionId !== sessionId) {
    return;
  }

  ensureSelectorStyles();
  bindUIEventHandlers();
  bindKeyboardListeners();

  const selectedCount = session.selectedIndices.length;
  const addDisabled = session.status !== "ready" || selectedCount === 0;
  const titlePage = session.pageName ? `[[${escapeHtml(session.pageName)}]]` : "referenced page";
  const focusSnapshot = getFocusSnapshot(session);
  const appRoot = getAppRoot();
  if (!appRoot) {
    return;
  }

  appRoot.innerHTML = `
      <div class="fts-root" data-session-id="${session.sessionId}">
        <button
          type="button"
          class="fts-backdrop"
          aria-label="Close TODO selector"
          data-action="closeSelector"
          data-session-id="${session.sessionId}"
        ></button>
        <div class="fts-wrapper">
      <section
        class="fts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fts-title-${session.sessionId}"
        data-session-id="${session.sessionId}"
        tabindex="-1"
      >
        <header class="fts-header">
          <h2 class="fts-title" id="fts-title-${session.sessionId}">Select TODOs from ${titlePage}</h2>
          <button
            type="button"
            class="fts-close-btn"
            aria-label="Close TODO selector"
            data-action="closeSelector"
            data-session-id="${session.sessionId}"
          >
            ×
          </button>
        </header>
        <div class="fts-body">
          ${renderSessionBody(session)}
        </div>
        <footer class="fts-footer">
          <span class="fts-count">${selectedCount} selected</span>
          <div class="fts-footer-actions">
            <button
              type="button"
              class="fts-secondary-btn"
              data-action="closeSelector"
              data-session-id="${session.sessionId}"
            >
              Cancel
            </button>
            <button
              type="button"
              class="fts-primary-btn"
              data-action="addSelectedTodos"
              data-session-id="${session.sessionId}"
              ${addDisabled ? "disabled" : ""}
            >
              Add TODOs
            </button>
          </div>
        </footer>
      </section>
        </div>
      </div>
    `;

  logseq.setMainUIInlineStyle({
    position: "fixed",
    zIndex: 9999,
    inset: "0",
    width: "100vw",
    height: "100vh",
    background: "transparent",
    pointerEvents: "auto",
  });
  if (!logseq.isMainUIVisible) {
    logseq.showMainUI({ autoFocus: true });
  }
  attachModalHandlers(sessionId, focusSnapshot);
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function extractPageReference(content: string): string | null {
  const match = content.match(/\[\[([^\]]+)\]\]/);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

async function getReferencedPageName(currentBlock: any): Promise<string | null> {
  const directReference = extractPageReference(String(currentBlock?.content ?? ""));
  if (directReference) {
    return directReference;
  }

  if (!currentBlock?.parent?.id) {
    return null;
  }

  const parentBlock = await logseq.Editor.getBlock(currentBlock.parent.id);
  if (!parentBlock) {
    return null;
  }

  return extractPageReference(String(parentBlock.content ?? ""));
}

function normalizeText(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function extractTodoText(content: string): string | null {
  const firstLine = content.split("\n")[0].split(":LOGBOOK:")[0].trim();
  const match = firstLine.match(/^TODO\s+(.+)/i);
  if (!match) {
    return null;
  }
  return normalizeText(match[1]);
}

function extractHeading(content: string): string {
  const firstLine = content.split("\n")[0] ?? "";
  if (firstLine.trim().startsWith(":")) {
    return "";
  }
  return normalizeText(firstLine.replace(/^TODO\s+/i, "").replace(/^\s*[-*]\s*/, ""));
}

async function fetchTodosFromPage(pageName: string, maxDepth: number | null): Promise<TodoItem[]> {
  const blocksRaw = await logseq.Editor.getPageBlocksTree(pageName);
  const blocks = Array.isArray(blocksRaw) ? blocksRaw : [];
  const todos: TodoItem[] = [];

  const walk = (block: any, ancestors: string[], depth: number, maxDepth: number | null): void => {
    if (maxDepth !== null && depth > maxDepth) {
      return;
    }

    const content = String(block?.content ?? "");
    const todoText = extractTodoText(content);
    const heading = extractHeading(content);
    const cleanedAncestors = ancestors.filter(Boolean);

    if (todoText && block?.uuid) {
      const pathSegments = [`[[${pageName}]]`, ...cleanedAncestors, todoText];
      const path = pathSegments.join(" > ");

      todos.push({
        uuid: String(block.uuid),
        content: todoText,
        pageName,
        path,
      });
    }

    const nextAncestors = todoText ? cleanedAncestors : heading ? [...cleanedAncestors, heading] : cleanedAncestors;
    const children = Array.isArray(block?.children) ? block.children : [];
    for (const child of children) {
      walk(child, nextAncestors, depth + 1, maxDepth);
    }
  };

  for (const block of blocks) {
    walk(block, [], 0, maxDepth);
  }

  return todos;
}

function getMaxNestingDepth(depthValue: string): number | null {
  if (depthValue === "all") {
    return null;
  }
  const parsed = Number.parseInt(depthValue, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

async function reloadTodosForSession(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }

  if (!session.pageName) {
    return;
  }

  const maxDepth = getMaxNestingDepth(session.nestingDepth);
  const todos = await fetchTodosFromPage(session.pageName, maxDepth);
  if (todos.length === 0) {
    setSessionPatch(sessionId, {
      status: "empty",
      todos: [],
      selectedIndices: [],
    });
    renderTodoSelector(sessionId);
    return;
  }

  setSessionPatch(sessionId, {
    status: "ready",
    todos,
    selectedIndices: [],
    searchQuery: "",
    errorMessage: undefined,
  });
  renderTodoSelector(sessionId);
}

async function hydrateSession(sessionId: string, currentBlock: any): Promise<void> {
  try {
    const pageName = await getReferencedPageName(currentBlock);
    if (!pageName) {
      setSessionPatch(sessionId, {
        status: "error",
        errorMessage: "No page reference found in the current block or its parent.",
      });
      renderTodoSelector(sessionId);
      return;
    }

    setSessionPatch(sessionId, {
      pageName,
      status: "loading",
      errorMessage: undefined,
    });
    renderTodoSelector(sessionId);

    const maxDepth = getMaxNestingDepth(getSession(sessionId)?.nestingDepth ?? "0");
    const todos = await fetchTodosFromPage(pageName, maxDepth);
    if (todos.length === 0) {
      setSessionPatch(sessionId, {
        pageName,
        status: "empty",
        todos: [],
        selectedIndices: [],
      });
      renderTodoSelector(sessionId);
      return;
    }

    setSessionPatch(sessionId, {
      pageName,
      status: "ready",
      todos,
      selectedIndices: [],
      searchQuery: "",
      errorMessage: undefined,
    });
    renderTodoSelector(sessionId);
  } catch (error) {
    debugLog("hydrateSession failed", error);
    setSessionPatch(sessionId, {
      status: "error",
      errorMessage: "Failed to load TODOs from the referenced page.",
    });
    renderTodoSelector(sessionId);
  }
}

async function showTodoSelector(): Promise<void> {
  await operationLock.run(async () => {
    debugLog("show selector start", { activeSessionId });

    if (activeSessionId) {
      closeSession(activeSessionId, "replace-session");
    }

    const currentBlock = await logseq.Editor.getCurrentBlock();
    const session = saveSession(createSessionState(currentBlock?.uuid ?? null));
    activeSessionId = session.sessionId;
    debugLog("created session", {
      sessionId: session.sessionId,
      hasCurrentBlock: Boolean(currentBlock?.uuid),
    });

    await delay(MAIN_UI_OPEN_DELAY_MS);
    if (activeSessionId !== session.sessionId) {
      debugLog("abort selector render due session mismatch", {
        expectedSessionId: session.sessionId,
        activeSessionId,
      });
      return;
    }

    await syncThemeVariables();
    blockEscapeCloseTemporarily();
    renderTodoSelector(session.sessionId);
    debugLog("selector rendered", { sessionId: session.sessionId });

    if (!currentBlock) {
      setSessionPatch(session.sessionId, {
        status: "error",
        errorMessage: "No current block found.",
      });
      renderTodoSelector(session.sessionId);
      debugLog("current block missing", { sessionId: session.sessionId });
      return;
    }

    await hydrateSession(session.sessionId, currentBlock);
    debugLog("session hydrated", { sessionId: session.sessionId });
  });
}

function triggerTodoSelectorOpen(triggerSource: "slash" | "palette"): void {
  debugLog("schedule selector open", { triggerSource });
  window.setTimeout(() => {
    debugLog("trigger selector open", { triggerSource });
    void showTodoSelector().catch((error: unknown) => {
      console.error("Fetch TODOs failed to open selector", error);
    });
  }, COMMAND_TRIGGER_DELAY_MS);
}

function bindUIEventHandlers(): void {
  if (uiEventHandlersBound) {
    return;
  }

  uiEventHandlersBound = true;

  document.addEventListener("input", (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.dataset.action !== "updateSearchQuery") {
      return;
    }

    const sessionId = target.dataset.sessionId ?? activeSessionId;
    if (!sessionId) {
      return;
    }

    const updated = setSessionPatch(sessionId, {
      searchQuery: target.value,
    });

    if (updated) {
      renderTodoSelector(sessionId);
    }
  });

  document.addEventListener("change", (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.action !== "updateNestingDepth") {
      return;
    }

    const sessionId = target.dataset.sessionId ?? activeSessionId;
    if (!sessionId) {
      return;
    }

    const optionExists = NESTING_DEPTH_OPTIONS.some((option) => option.value === target.value);
    const nextNestingDepth = optionExists ? target.value : "0";
    const updated = setSessionPatch(sessionId, {
      nestingDepth: nextNestingDepth,
      status: "loading",
      errorMessage: undefined,
    });

    if (!updated) {
      return;
    }

    renderTodoSelector(sessionId);
    void reloadTodosForSession(sessionId).catch((error: unknown) => {
      debugLog("reloadTodosForSession failed", error);
      setSessionPatch(sessionId, {
        status: "error",
        errorMessage: "Failed to load TODOs from the referenced page.",
      });
      renderTodoSelector(sessionId);
    });
  });

  document.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const actionElement = target.closest<HTMLElement>("[data-action]");
    if (!actionElement) {
      return;
    }

    const action = actionElement.dataset.action;
    const sessionId = actionElement.dataset.sessionId ?? activeSessionId;
    if (!action || !sessionId) {
      return;
    }

    if (action === "toggleTodo") {
      const todoIndex = Number.parseInt(actionElement.dataset.index ?? "", 10);
      if (Number.isNaN(todoIndex)) {
        return;
      }

      const updated = updateSession(sessionId, (current) => {
        if (current.status !== "ready") {
          return current;
        }

        const exists = current.selectedIndices.includes(todoIndex);
        const selectedIndices = exists
          ? current.selectedIndices.filter((index) => index !== todoIndex)
          : [...current.selectedIndices, todoIndex];

        selectedIndices.sort((a, b) => a - b);
        return updateSessionState(current, { selectedIndices });
      });

      if (updated?.status === "ready") {
        setTodoItemSelectedState(actionElement, updated.selectedIndices.includes(todoIndex));
        syncSelectionSummary(sessionId);
      }
      return;
    }

    if (action === "selectAllTodos") {
      const session = getSession(sessionId);
      if (!session || session.status !== "ready") {
        return;
      }

      const filteredIndices = filterTodos(session.todos, session.searchQuery).map(({ index }) => index);
      const selectedSet = new Set([...session.selectedIndices, ...filteredIndices]);
      const selectedIndices = Array.from(selectedSet).sort((a, b) => a - b);

      setSessionPatch(sessionId, { selectedIndices });
      syncVisibleTodoSelectionState(sessionId);
      return;
    }

    if (action === "clearSelection") {
      setSessionPatch(sessionId, { selectedIndices: [] });
      syncVisibleTodoSelectionState(sessionId);
      return;
    }

    if (action === "closeSelector") {
      closeSession(sessionId, "close-button");
      return;
    }

    if (action === "addSelectedTodos") {
      void operationLock.run(async () => {
        const session = getSession(sessionId);
        if (!session || session.status !== "ready") {
          return;
        }

        if (!session.sourceBlockUuid) {
          setSessionPatch(sessionId, {
            status: "error",
            errorMessage: "Current block is unavailable. Re-open the selector and try again.",
          });
          renderTodoSelector(sessionId);
          return;
        }

        if (session.selectedIndices.length === 0) {
          return;
        }

        const selectedTodos = session.selectedIndices
          .map((index) => session.todos[index])
          .filter((todo): todo is TodoItem => Boolean(todo));

        debugLog("resolved selected todos", {
          sessionId,
          selectedCount: session.selectedIndices.length,
          resolvedCount: selectedTodos.length,
        });

        if (selectedTodos.length === 0) {
          setSessionPatch(sessionId, {
            selectedIndices: [],
          });
          renderTodoSelector(sessionId);
          return;
        }

        const [firstTodo, ...remainingTodos] = selectedTodos;
        const firstTodoReference = `((${firstTodo.uuid}))`;
        await logseq.Editor.updateBlock(session.sourceBlockUuid, firstTodoReference);

        debugLog("updated source block with first todo", {
          sessionId,
          sourceBlockUuid: session.sourceBlockUuid,
          firstTodoUuid: firstTodo.uuid,
          remainingCount: remainingTodos.length,
        });

        let insertAfterUuid = session.sourceBlockUuid;
        let lastInsertedContent = firstTodoReference;
        for (const todo of remainingTodos) {
          const todoReference = `((${todo.uuid}))`;
          const inserted = await logseq.Editor.insertBlock(insertAfterUuid, todoReference, {
            sibling: true,
            before: false,
            focus: false,
          });
          if (inserted?.uuid) {
            insertAfterUuid = inserted.uuid;
            lastInsertedContent = todoReference;
          }
        }

        closeSession(sessionId, "add-selected-complete", false);

        if (remainingTodos.length > 0) {
          await logseq.Editor.editBlock(insertAfterUuid, { pos: lastInsertedContent.length });
        }

        await logseq.App.showMsg(`Inserted ${selectedTodos.length} TODO reference(s).`);
      });
    }
  });
}

function main(): void {
  logseq.useSettingsSchema([
    {
      key: "debugLogging",
      type: "boolean",
      default: false,
      title: "Enable debug logs",
      description: "Logs internal plugin details to DevTools console.",
    },
  ]);

  syncDebugLoggingSetting();
  if (typeof logseq.onSettingsChanged === "function") {
    logseq.onSettingsChanged((newSettings: Record<string, unknown>) => {
      syncDebugLoggingSetting(newSettings);
    });
  }

  void syncThemeVariables();
  logseq.App.onThemeChanged(() => {
    void syncThemeVariables();
  });
  logseq.App.onThemeModeChanged(() => {
    void syncThemeVariables();
  });

  logseq.App.registerCommandPalette(
    {
      key: "fetch-todos-cmd",
      label: "Fetch TODOs from page",
    },
    () => {
      debugLog("command palette triggered");
      triggerTodoSelectorOpen("palette");
    },
  );

  logseq.Editor.registerSlashCommand("Fetch TODOs", () => {
    debugLog("slash command triggered");
    triggerTodoSelectorOpen("slash");
  });
}

logseq.ready(main).catch((error: unknown) => {
  console.error("Fetch TODOs failed to start", error);
});
