import {
  OperationLock,
  SessionStateSchema,
  createSessionState,
  filterTodos,
  updateSessionState,
} from "./session";
import type { SessionState, TodoItem } from "./session";

declare const logseq: any;

type ModelEvent = {
  dataset?: Record<string, string>;
  index?: string | number;
  value?: string;
  key?: string;
  target?: {
    value?: string;
    key?: string;
  };
  event?: {
    key?: string;
    target?: {
      value?: string;
    };
  };
};

const UI_KEY = "fetch-todos-selector";
const COMMAND_TRIGGER_DELAY_MS = 40;
const MAIN_UI_OPEN_DELAY_MS = 0;
const ESCAPE_CLOSE_GUARD_MS = 800;
const operationLock = new OperationLock();
const sessions = new Map<string, SessionState>();
let activeSessionId: string | null = null;
let keyboardListenersBound = false;
let selectorStylesLoaded = false;
let escapeCloseBlockedUntil = 0;
let debugLoggingEnabled = false;

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

function getEventSessionId(event: unknown): string | null {
  const modelEvent = event as ModelEvent | undefined;
  return modelEvent?.dataset?.sessionId ?? activeSessionId;
}

function getEventTodoIndex(event: unknown): number | null {
  const modelEvent = event as ModelEvent | undefined;
  const indexRaw = modelEvent?.dataset?.index ?? modelEvent?.index;
  const parsed = Number.parseInt(String(indexRaw), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getEventTextValue(event: unknown): string | null {
  const modelEvent = event as ModelEvent | undefined;
  if (typeof modelEvent?.value === "string") {
    return modelEvent.value;
  }
  if (typeof modelEvent?.target?.value === "string") {
    return modelEvent.target.value;
  }
  if (typeof modelEvent?.event?.target?.value === "string") {
    return modelEvent.event.target.value;
  }
  return null;
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

    const eventTarget = event.target;
    const isEventInsideModal = eventTarget instanceof Node && modal.contains(eventTarget);

    if (event.key === "Escape") {
      if (isEscapeCloseBlocked()) {
        debugLog("ignored early Escape", { sessionId: session.sessionId });
        return;
      }
      if (!isEventInsideModal) {
        return;
      }
      event.preventDefault();
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
      last.focus();
      return;
    }

    if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function attachModalHandlers(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session || session.hasInitialFocus) {
    return;
  }

  const focusTarget =
    document.querySelector<HTMLElement>(`#fts-search-${sessionId}`) ??
    document.querySelector<HTMLElement>(`.fts-close-btn[data-session-id='${sessionId}']`);
  focusTarget?.focus();
  setSessionPatch(sessionId, { hasInitialFocus: true });
}

function closeSession(sessionId: string, reason = "unknown"): void {
  debugLog("closing session", { sessionId, reason });
  sessions.delete(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = null;
  }
  logseq.provideUI({
    key: UI_KEY,
    template: null,
  });
}

function ensureSelectorStyles(): void {
  if (selectorStylesLoaded) {
    return;
  }
  selectorStylesLoaded = true;

  logseq.provideStyle(`
    .fts-wrapper,
    .fts-wrapper * {
      pointer-events: auto !important;
      -webkit-app-region: no-drag !important;
    }

    .fts-wrapper {
      width: min(42rem, calc(100vw - 1.5rem));
      max-width: calc(100vw - 1.5rem);
    }

    .fts-modal {
      width: 100%;
      max-height: min(80vh, 46rem);
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
      font-size: 0.95rem;
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
      flex-direction: column;
      gap: 0.75rem;
      min-height: 10rem;
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
    }

    .fts-search:focus,
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
      font-size: 0.8rem;
      font-weight: 500;
      white-space: nowrap;
    }

    .fts-action-btn:hover {
      background: var(--ls-tertiary-background-color, #f1f5f9);
    }

    .fts-count {
      font-size: 0.8rem;
      color: var(--ls-secondary-text-color, #64748b);
    }

    .fts-list {
      border: 1px solid var(--ls-border-color, #d4d4d8);
      border-radius: 0.6rem;
      overflow: auto;
      max-height: min(48vh, 24rem);
      background: var(--ls-secondary-background-color, #ffffff);
    }

    .fts-state {
      padding: 1.25rem;
      color: var(--ls-secondary-text-color, #64748b);
      text-align: center;
      line-height: 1.4;
      font-size: 0.88rem;
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

    .fts-item.is-selected {
      background: var(--ls-selection-background-color, rgba(37, 99, 235, 0.14));
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
      font-size: 0.75rem;
      color: var(--ls-link-text-color, #2563eb);
      font-weight: 700;
    }

    .fts-item.is-selected .fts-check {
      border-color: var(--ls-link-text-color, #2563eb);
      background: var(--ls-selection-background-color, rgba(37, 99, 235, 0.22));
    }

    .fts-content {
      font-size: 0.88rem;
      color: var(--ls-primary-text-color, #0f172a);
      margin-bottom: 0.18rem;
      line-height: 1.35;
    }

    .fts-meta {
      display: block;
      font-size: 0.74rem;
      color: var(--ls-secondary-text-color, #64748b);
      line-height: 1.3;
    }

    .fts-footer {
      margin-top: auto;
      position: sticky;
      bottom: 0;
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
      font-size: 0.82rem;
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
      .fts-wrapper {
        width: calc(100vw - 0.9rem);
        max-width: calc(100vw - 0.9rem);
      }

      .fts-modal {
        width: 100%;
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
  `);
}

function renderReadyState(session: SessionState): string {
  const filtered = filterTodos(session.todos, session.searchQuery);
  const selectedCount = session.selectedIndices.length;

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
                data-on-click="toggleTodo"
              >
                <span class="fts-check" aria-hidden="true">${selected ? "✓" : ""}</span>
                <span>
                  <span class="fts-content">${escapeHtml(todo.content)}</span>
                  <span class="fts-meta">Path: ${escapeHtml(todo.path)}</span>
                  <span class="fts-meta">Parent: ${escapeHtml(todo.parentHeading)}</span>
                  <span class="fts-meta">Snippet: ${escapeHtml(todo.pageSnippet)}</span>
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
        placeholder="Search TODOs, paths, or snippets"
        value="${escapeHtml(session.searchQuery)}"
        aria-label="Search TODOs"
        data-on-input="updateSearchQuery"
        data-session-id="${session.sessionId}"
      />
      <div class="fts-actions">
        <button
          type="button"
          class="fts-action-btn"
          data-on-click="selectAllTodos"
          data-session-id="${session.sessionId}"
        >
          Select all
        </button>
        <button
          type="button"
          class="fts-action-btn"
          data-on-click="clearSelection"
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

function renderTodoSelector(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session || activeSessionId !== sessionId) {
    return;
  }

  ensureSelectorStyles();
  bindKeyboardListeners();

  const selectedCount = session.selectedIndices.length;
  const addDisabled = session.status !== "ready" || selectedCount === 0;
  const titlePage = session.pageName ? `[[${escapeHtml(session.pageName)}]]` : "referenced page";

  logseq.provideUI({
    key: UI_KEY,
    style: {
      position: "fixed",
      zIndex: 9999,
      top: "4.5rem",
      right: "0.75rem",
      left: "auto",
      bottom: "auto",
      width: "min(42rem, calc(100vw - 1.5rem))",
      maxHeight: "min(86vh, 50rem)",
      overflow: "visible",
      background: "transparent",
      pointerEvents: "auto",
    },
    attrs: {
      class: "fts-wrapper",
    },
    template: `
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
            data-on-click="closeSelector"
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
              data-on-click="closeSelector"
              data-session-id="${session.sessionId}"
            >
              Cancel
            </button>
            <button
              type="button"
              class="fts-primary-btn"
              data-on-click="addSelectedTodos"
              data-session-id="${session.sessionId}"
              ${addDisabled ? "disabled" : ""}
            >
              Add TODOs
            </button>
          </div>
        </footer>
      </section>
    `,
  });
  attachModalHandlers(sessionId);
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

async function fetchTodosFromPage(pageName: string): Promise<TodoItem[]> {
  const blocksRaw = await logseq.Editor.getPageBlocksTree(pageName);
  const blocks = Array.isArray(blocksRaw) ? blocksRaw : [];
  const todos: TodoItem[] = [];

  const walk = (block: any, ancestors: string[]): void => {
    const content = String(block?.content ?? "");
    const todoText = extractTodoText(content);
    const heading = extractHeading(content);
    const cleanedAncestors = ancestors.filter(Boolean);

    if (todoText && block?.uuid) {
      const parentHeading = cleanedAncestors[cleanedAncestors.length - 1] ?? "Page root";
      const pathSegments = [`[[${pageName}]]`, ...cleanedAncestors];
      const path = pathSegments.join(" > ");
      const pageSnippet = normalizeText(content).slice(0, 140) || todoText;

      todos.push({
        uuid: String(block.uuid),
        content: todoText,
        pageName,
        parentHeading,
        path,
        pageSnippet,
      });
    }

    const nextAncestors = todoText ? cleanedAncestors : heading ? [...cleanedAncestors, heading] : cleanedAncestors;
    const children = Array.isArray(block?.children) ? block.children : [];
    for (const child of children) {
      walk(child, nextAncestors);
    }
  };

  for (const block of blocks) {
    walk(block, []);
  }

  return todos;
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

    const todos = await fetchTodosFromPage(pageName);
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

logseq.provideModel({
  async updateSearchQuery(event: unknown) {
    const sessionId = getEventSessionId(event);
    if (!sessionId) {
      return;
    }

    const value = getEventTextValue(event);
    if (value === null) {
      return;
    }

    const updated = setSessionPatch(sessionId, {
      searchQuery: value,
    });
    if (updated) {
      renderTodoSelector(sessionId);
    }
  },

  async toggleTodo(event: unknown) {
    const sessionId = getEventSessionId(event);
    const todoIndex = getEventTodoIndex(event);
    if (!sessionId || todoIndex === null) {
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

    if (updated) {
      renderTodoSelector(sessionId);
    }
  },

  async selectAllTodos(event: unknown) {
    const sessionId = getEventSessionId(event);
    const session = getSession(sessionId);
    if (!session || session.status !== "ready") {
      return;
    }

    const filteredIndices = filterTodos(session.todos, session.searchQuery).map(({ index }) => index);
    const selectedSet = new Set([...session.selectedIndices, ...filteredIndices]);
    const selectedIndices = Array.from(selectedSet).sort((a, b) => a - b);

    setSessionPatch(session.sessionId, { selectedIndices });
    renderTodoSelector(session.sessionId);
  },

  async clearSelection(event: unknown) {
    const sessionId = getEventSessionId(event);
    if (!sessionId) {
      return;
    }

    setSessionPatch(sessionId, { selectedIndices: [] });
    renderTodoSelector(sessionId);
  },

  async closeSelector(event: unknown) {
    const sessionId = getEventSessionId(event);
    if (!sessionId) {
      return;
    }
    closeSession(sessionId, "close-button");
  },

  async addSelectedTodos(event: unknown) {
    const sessionId = getEventSessionId(event);
    if (!sessionId) {
      return;
    }

    await operationLock.run(async () => {
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

      if (selectedTodos.length === 0) {
        setSessionPatch(sessionId, {
          selectedIndices: [],
        });
        renderTodoSelector(sessionId);
        return;
      }

      const [firstTodo, ...remainingTodos] = selectedTodos;
      await logseq.Editor.updateBlock(session.sourceBlockUuid, `((${firstTodo.uuid}))`);

      let insertAfterUuid = session.sourceBlockUuid;
      for (const todo of remainingTodos) {
        const inserted = await logseq.Editor.insertBlock(insertAfterUuid, `((${todo.uuid}))`, {
          sibling: true,
          before: false,
          focus: false,
        });
        if (inserted?.uuid) {
          insertAfterUuid = inserted.uuid;
        }
      }

      closeSession(sessionId, "add-selected-complete");
      await logseq.App.showMsg(`Inserted ${selectedTodos.length} TODO reference(s).`);
    });
  },
});

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

  logseq.App.showMsg("Fetch TODOs plugin loaded!");
}

logseq.ready(main).catch((error: unknown) => {
  console.error("Fetch TODOs failed to start", error);
});
