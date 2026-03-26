function main() {
  logseq.App.showMsg("Fetch TODOs plugin loaded!");
  
  logseq.App.registerCommandPalette({
    key: "fetch-todos-cmd",
    label: "Fetch TODOs from page",
  }, async () => {
    await showTodoSelector();
  });
  
  logseq.Editor.registerSlashCommand(
    "Fetch TODOs",
    async () => {
      await showTodoSelector();
    }
  );
}

async function getReferencedPageName() {
  try {
    const block = await logseq.Editor.getCurrentBlock();
    if (!block) return null;
    
    let content = block.content || "";
    let pageRefMatch = content.match(/\[\[([^\]]+)\]\]/);
    
    if (!pageRefMatch && block.parent) {
      const parentBlock = await logseq.Editor.getBlock(block.parent.id);
      if (parentBlock) {
        content = parentBlock.content || "";
        pageRefMatch = content.match(/\[\[([^\]]+)\]\]/);
      }
    }
    
    if (pageRefMatch) {
      return pageRefMatch[1];
    }
    return null;
  } catch (e) {
    logseq.App.showMsg("Error: " + e.message);
    return null;
  }
}

async function fetchTodosFromPage(pageName) {
  try {
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
          uuid: block.uuid,
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

logseq.provideModel({
  async selectTodo(e) {
    const { index } = e.dataset;
    const pageName = e.dataset.pageName;
    const todos = await fetchTodosFromPage(pageName);
    const todo = todos[parseInt(index)];
    
    const block = await logseq.Editor.getCurrentBlock();
    await logseq.Editor.updateBlock(block.uuid, `((${todo.uuid}))`);
    logseq.hideMainUI();
  }
});

async function showTodoSelector() {
  const pageName = await getReferencedPageName();
  if (!pageName) {
    await logseq.App.showMsg("No page reference found.");
    return;
  }
  
  const todos = await fetchTodosFromPage(pageName);
  
  if (todos.length === 0) {
    await logseq.App.showMsg("No TODOs in [[ " + pageName + " ]]");
    return;
  }
  
  logseq.provideStyle(`
    .fts-wrapper {
      width: 280px;
    }
    .fts-container {
      background: #2d2d2d;
      border: 1px solid #444;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      min-width: 200px;
      max-width: 280px;
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
      display: flex;
      align-items: center;
      padding: 10px 16px;
      cursor: pointer;
      border-bottom: 1px solid #3a3a3a;
    }
    .fts-item:hover {
      background: #3a3a3a;
    }
    .fts-checkbox {
      margin-right: 10px;
      font-size: 14px;
      color: #e0e0e0;
    }
    .fts-content {
      flex: 1;
      font-size: 13px;
      color: #e0e0e0;
    }
  `);
  
  logseq.provideUI({
    key: "fetch-todos-selector",
    template: `
      <div class="fts-container">
        <div class="fts-header">Select TODO from [[${pageName}]]</div>
        <div class="fts-list">
          ${todos.map((todo, i) => `
            <div class="fts-item" data-on-click="selectTodo" data-index="${i}" data-page-name="${escapeHtml(pageName)}">
              <span class="fts-checkbox">☐</span>
              <span class="fts-content">${escapeHtml(todo.content)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `,
    attrs: { class: "fts-wrapper", style: "width: 280px;" }
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

logseq.ready(main).catch(console.error);
