import { z } from "zod";

export const TodoItemSchema = z.object({
  uuid: z.string().min(1),
  content: z.string().min(1),
  pageName: z.string().min(1),
  path: z.string().min(1),
  ancestors: z.array(z.string().min(1)),
});

export type TodoItem = z.infer<typeof TodoItemSchema>;

export const SessionStatusSchema = z.enum(["loading", "ready", "empty", "error"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionStateSchema = z.object({
  sessionId: z.string().min(1),
  sourceBlockUuid: z.string().nullable(),
  pageName: z.string(),
  nestingDepth: z.string(),
  insertWithHierarchy: z.boolean(),
  status: SessionStatusSchema,
  todos: z.array(TodoItemSchema),
  selectedIndices: z.array(z.number().int().nonnegative()),
  searchQuery: z.string(),
  errorMessage: z.string().optional(),
  hasInitialFocus: z.boolean(),
});

export type SessionState = z.infer<typeof SessionStateSchema>;

export function createSessionState(sourceBlockUuid: string | null): SessionState {
  return SessionStateSchema.parse({
    sessionId: createSessionId(),
    sourceBlockUuid,
    pageName: "",
    nestingDepth: "0",
    insertWithHierarchy: false,
    status: "loading",
    todos: [],
    selectedIndices: [],
    searchQuery: "",
    errorMessage: undefined,
    hasInitialFocus: false,
  });
}

export function updateSessionState(
  current: SessionState,
  patch: Partial<SessionState>,
): SessionState {
  return SessionStateSchema.parse({
    ...current,
    ...patch,
  });
}

export function filterTodos(todos: TodoItem[], query: string): Array<{ index: number; todo: TodoItem }> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return todos.map((todo, index) => ({ index, todo }));
  }

  return todos
    .map((todo, index) => ({ index, todo }))
    .filter(({ todo }) => {
      const haystack = [todo.content, todo.path].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });
}

export class OperationLock {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release: () => void = () => undefined;

    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function createSessionId(): string {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `fts-${Date.now()}-${randomPart}`;
}
