import { describe, expect, it } from "vitest";

import { OperationLock, createSessionState, filterTodos, updateSessionState } from "../src/session";

describe("session helpers", () => {
  it("creates a valid default session", () => {
    const session = createSessionState("block-123");
    expect(session.sourceBlockUuid).toBe("block-123");
    expect(session.status).toBe("loading");
    expect(session.selectedIndices).toEqual([]);
  });

  it("filters todos by content and metadata", () => {
    const session = createSessionState("block-123");
    const updated = updateSessionState(session, {
      status: "ready",
      pageName: "Project",
      todos: [
        {
          uuid: "todo-1",
          content: "Write launch post",
          pageName: "Project",
          path: "[[Project]] > Marketing > Write launch post",
        },
        {
          uuid: "todo-2",
          content: "Fix sync race",
          pageName: "Project",
          path: "[[Project]] > Engineering > Fix sync race",
        },
      ],
    });

    expect(filterTodos(updated.todos, "marketing")).toHaveLength(1);
    expect(filterTodos(updated.todos, "race")).toHaveLength(1);
    expect(filterTodos(updated.todos, "project")).toHaveLength(2);
  });
});

describe("operation lock", () => {
  it("runs operations one at a time", async () => {
    const lock = new OperationLock();
    const order: string[] = [];

    await Promise.all([
      lock.run(async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("a-end");
      }),
      lock.run(async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});
