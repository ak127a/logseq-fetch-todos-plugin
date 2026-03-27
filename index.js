function main() {
  logseq.App.showMsg("Fetch TODOs plugin loaded!");
  
  logseq.App.registerCommandPalette({
    key: "fetch-todos-cmd",
    label: "Fetch TODOs from page",
  }, async () => {
    console.log("Fetch TODOs: Command palette clicked");
    await showTodoSelector();
  });
  
  logseq.Editor.registerSlashCommand(
    "Fetch TODOs",
    async () => {
      console.log("Fetch TODOs: Slash command triggered");
      await showTodoSelector();
    }
  );
}

async function getReferencedPageName() {
  try {
    console.log("Fetch TODOs: getReferencedPageName started");
    const block = await logseq.Editor.getCurrentBlock();
    console.log("Fetch TODOs: currentBlock =", block);
    if (!block) return null;
    
    let content = block.content || "";
    let pageRefMatch = content.match(/\[\[([^\]]+)\]\]/);
    console.log("Fetch TODOs: pageRefMatch from block =", pageRefMatch);
    
    if (!pageRefMatch && block.parent) {
      const parentBlock = await logseq.Editor.getBlock(block.parent.id);
      console.log("Fetch TODOs: parentBlock =", parentBlock);
      if (parentBlock) {
        content = parentBlock.content || "";
        pageRefMatch = content.match(/\[\[([^\]]+)\]\]/);
        console.log("Fetch TODOs: pageRefMatch from parent =", pageRefMatch);
      }
    }
    
    if (pageRefMatch) {
      console.log("Fetch TODOs: returning pageName =", pageRefMatch[1]);
      return pageRefMatch[1];
    }
    console.log("Fetch TODOs: No page reference found, returning null");
    return null;
  } catch (e) {
    logseq.App.showMsg("Error: " + e.message);
    return null;
  }
}

async function fetchTodosFromPage(pageName) {
  try {
    console.log("Fetch TODOs: fetchTodosFromPage started for page:", pageName);
    const blocks = await logseq.Editor.getPageBlocksTree(pageName);
    console.log("Fetch TODOs: Got", blocks.length, "blocks");
    const todos = [];
    
    function findTodos(block) {
      const content = block.content || "";
      console.log("Fetch TODOs: Checking block:", content);
      const todoMatch = content.match(/^(TODO)\s+(.+)/i);
      if (todoMatch) {
        let todoContent = todoMatch[2].trim();
        todoContent = todoContent.split('\n')[0].split(':LOGBOOK:')[0].trim();
        console.log("Fetch TODOs: Found TODO:", todoContent);
        todos.push({
          uuid: String(block.uuid),
          content: todoContent
        });
      }
      if (block.children) {
        block.children.forEach(findTodos);
      }
    }
    
    blocks.forEach(findTodos);
    console.log("Fetch TODOs: Total TODOs found:", todos.length);
    return todos;
  } catch (e) {
    console.error("Fetch TODOs: Error:", e);
    return [];
  }
}

let selectedTodoIndices = [];
let currentTodos = [];
let currentPageName = "";
let sourceBlockUuid = null;

function getEventTodoIndex(e) {
  let idx = null;
  if (e.dataset && e.dataset.index !== undefined) {
    idx = e.dataset.index;
  } else if (e.index !== undefined) {
    idx = e.index;
  }
  const parsed = Number.parseInt(String(idx), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function renderTodoSelector() {
  const pageName = currentPageName;
  const todos = currentTodos;
  logseq.setMainUIInlineStyle({
    zIndex: "9999",
    width: "320px",
    maxHeight: "70vh",
    overflow: "auto",
    top: "80px",
    right: "24px",
  });
  logseq.provideUI({
    key: "fetch-todos-selector",
    template: `
      <div class="fts-container">
        <div class="fts-header">Select TODO from [[${escapeHtml(pageName)}]]</div>
        <div class="fts-list">
          ${todos
            .map(
              (todo, i) => `
            <div class="fts-item">
              <label class="fts-item-label">
                <input
                  class="fts-checkbox"
                  type="checkbox"
                  data-on-change="toggleTodo"
                  data-index="${i}"
                  ${selectedTodoIndices.includes(i) ? "checked" : ""}
                />
                <span class="fts-content">${escapeHtml(todo.content)}</span>
              </label>
            </div>
          `,
            )
            .join("")}
        </div>
        <div class="fts-footer">
          <button class="fts-add-btn" data-on-click="addSelectedTodos">Add TODOs</button>
        </div>
      </div>
    `,
    style: { width: "410px" },
    attrs: { class: "fts-wrapper" },
  });
  logseq.showMainUI();
}

logseq.provideModel({
  async toggleTodo(e) {
    console.log("Fetch TODOs: toggleTodo called with e =", JSON.stringify(Object.keys(e)));
    const idx = getEventTodoIndex(e);
    console.log("Fetch TODOs: idx =", idx);
    if (idx === null) return;

    const index = selectedTodoIndices.indexOf(idx);
    const isChecked = typeof e.checked === "boolean" ? e.checked : index === -1;

    if (isChecked && index === -1) {
      selectedTodoIndices.push(idx);
    } else if (!isChecked && index > -1) {
      selectedTodoIndices.splice(index, 1);
    }
    console.log("Fetch TODOs: selectedTodoIndices now =", selectedTodoIndices);
  },
  async addSelectedTodos(e) {
    console.log("Fetch TODOs: addSelectedTodos called, selectedTodoIndices =", selectedTodoIndices);
    const todos = currentTodos;
    
    if (selectedTodoIndices.length === 0) {
      logseq.App.showMsg("No TODOs selected.");
      return;
    }
    
    if (!sourceBlockUuid) {
      logseq.App.showMsg("No source block found. Re-run Fetch TODOs.");
      return;
    }

    const selectedIndices = [...selectedTodoIndices].sort((a, b) => a - b);
    const selectedTodos = selectedIndices
      .map((idx) => todos[idx])
      .filter(Boolean);

    if (selectedTodos.length === 0) {
      logseq.App.showMsg("No valid TODOs selected.");
      return;
    }

    const [firstTodo, ...remainingTodos] = selectedTodos;
    const firstContent = `((${firstTodo.uuid}))`;
    console.log("Fetch TODOs: updating source block with uuid =", firstTodo.uuid);
    await logseq.Editor.updateBlock(sourceBlockUuid, firstContent);

    // Insert remaining TODOs as siblings right below the updated current block.
    let insertAfterUuid = sourceBlockUuid;
    for (const todo of remainingTodos) {
      console.log("Fetch TODOs: inserting todo with uuid =", todo.uuid);
      const content = `((${todo.uuid}))`;
      const inserted = await logseq.Editor.insertBlock(insertAfterUuid, content, {
        sibling: true,
        before: false,
        focus: false,
      });
      if (inserted?.uuid) {
        insertAfterUuid = inserted.uuid;
      }
    }
    
    selectedTodoIndices = [];
    logseq.hideMainUI();
  }
});

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function showTodoSelector() {
  console.log("Fetch TODOs: showTodoSelector started");
  selectedTodoIndices = [];
  const currentBlock = await logseq.Editor.getCurrentBlock();
  if (!currentBlock) {
    await logseq.App.showMsg("No current block found.");
    return;
  }
  sourceBlockUuid = currentBlock.uuid || null;

  const pageName = await getReferencedPageName();
  console.log("Fetch TODOs: pageName =", pageName);
  if (!pageName) {
    await logseq.App.showMsg("No page reference found.");
    return;
  }
  
  const todos = await fetchTodosFromPage(pageName);
  console.log("Fetch TODOs: todos =", todos);
  
  if (todos.length === 0) {
    await logseq.App.showMsg("No TODOs in [[ " + pageName + " ]]");
    return;
  }
  
  currentTodos = todos;
  currentPageName = pageName;
  
  logseq.provideStyle(`
    .fts-wrapper {
      width: 280px;
    }
    .fts-container {
      background: #2d2d2d;
      border: 1px solid #444;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      min-width: 400px;
      max-width: 400px;
    }
    .fts-header {
      padding: 12px 16px;
      border-bottom: 1px solid #444;
      font-weight: 600;
      font-size: 14px;
      color: #e0e0e0;
    }
    .fts-list {
      max-height: 250px;
      overflow-y: auto;
    }
    .fts-item {
      padding: 10px 16px;
      border-bottom: 1px solid #3a3a3a;
    }
    .fts-item:hover {
      background: #3a3a3a;
    }
    .fts-item-label {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      cursor: pointer;
    }
    .fts-checkbox {
      width: 14px;
      height: 14px;
      margin: 0;
    }
    .fts-content {
      flex: 1;
      font-size: 13px;
      color: #e0e0e0;
    }
    .fts-footer {
      display: flex;
      justify-content: flex-end;
      padding: 10px 16px;
      border-top: 1px solid #444;
    }
    .fts-add-btn {
      background: #4a90d9;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .fts-add-btn:hover {
      background: #5a9fe8;
    }
  `);
  
  renderTodoSelector();
  
  console.log("Fetch TODOs: UI shown");
}

logseq.ready(main).catch(console.error);
