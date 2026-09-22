const form = document.querySelector('#chat-form');
const box = document.querySelector('#messages');
const input = document.querySelector('#question');
const send = document.querySelector('#send');
const mode = document.querySelector('#mode');
const documents = document.querySelector('#documents');
const clearConversation = document.querySelector('#clear-conversation');
const regenerate = document.querySelector('#regenerate');
const notice = document.querySelector('#notice');
const projectList = document.querySelector('#project-list');
const projectEmpty = document.querySelector('#project-empty');
const addProject = document.querySelector('#add-project');
const activeProjectName = document.querySelector('#active-project-name');
const activeProjectPath = document.querySelector('#active-project-path');
const modelsButton = document.querySelector('#models');
const modelName = document.querySelector('#model-name');
const modelDialog = document.querySelector('#model-dialog');
const closeModels = document.querySelector('#close-models');
const hardware = document.querySelector('#hardware');
const modelList = document.querySelector('#model-list');
const settingsButton = document.querySelector('#settings');
const settingsDialog = document.querySelector('#settings-dialog');
const closeSettings = document.querySelector('#close-settings');
const settingsList = document.querySelector('#settings-list');
const applySettings = document.querySelector('#apply-settings');
const reindexWrap = document.querySelector('#reindex-wrap');
const reindexSettings = document.querySelector('#reindex-settings');

const maintenanceHeaders = { 'X-Local-RAG': '1', 'Content-Type': 'application/json' };
const managedSettings = new Set([
  'DOCS_DIR', 'RAG_CHAT_MODEL', 'RAG_INDEX_DIR', 'CHUNKS_PATH', 'CHROMA_COLLECTION',
]);
const reindexKeys = new Set([
  'DOCS_EXTENSIONS', 'PDF_TO_TEXT_BIN', 'OLLAMA_URL', 'OLLAMA_EMBED_MODEL',
  'CHROMA_HOST', 'CHROMA_PORT', 'CHROMA_SSL', 'SPLIT_TARGET_CHARS',
  'SPLIT_MAX_CHARS', 'SPLIT_OVERLAP_CHARS',
]);

let projects = [];
let activeProject = null;
let loadedSettings = [];
const pendingChats = new Map();
let noticeTimer;
const settingTooltip = document.createElement('div');
settingTooltip.className = 'setting-tooltip';
settingTooltip.id = 'setting-tooltip';
settingTooltip.setAttribute('role', 'tooltip');
settingTooltip.hidden = true;
settingsDialog.append(settingTooltip);

function showSettingTooltip(trigger, text) {
  settingTooltip.textContent = text;
  settingTooltip.hidden = false;
  const triggerRect = trigger.getBoundingClientRect();
  const viewportPadding = 12;
  const tooltipWidth = Math.min(310, window.innerWidth - viewportPadding * 2);
  settingTooltip.style.width = `${tooltipWidth}px`;
  const tooltipHeight = settingTooltip.getBoundingClientRect().height;
  const left = Math.max(viewportPadding, Math.min(triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2, window.innerWidth - tooltipWidth - viewportPadding));
  const top = triggerRect.top - tooltipHeight - 8 >= viewportPadding
    ? triggerRect.top - tooltipHeight - 8
    : triggerRect.bottom + 8;
  settingTooltip.style.left = `${left}px`;
  settingTooltip.style.top = `${Math.min(top, window.innerHeight - tooltipHeight - viewportPadding)}px`;
}

function hideSettingTooltip() {
  settingTooltip.hidden = true;
}

function notify(text, error = false, persist = false) {
  clearTimeout(noticeTimer);
  notice.textContent = text;
  notice.classList.toggle('error', error);
  notice.hidden = false;
  if (!persist) noticeTimer = setTimeout(() => { notice.hidden = true; }, 4500);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error HTTP ${response.status}`);
  return data;
}

function projectQuery() {
  if (!activeProject) throw new Error('Select a project.');
  return `projectId=${encodeURIComponent(activeProject.id)}`;
}

function projectBody(extra = {}) {
  if (!activeProject) throw new Error('Select a project.');
  return JSON.stringify({ projectId: activeProject.id, ...extra });
}

function setControlsEnabled(enabled) {
  for (const control of [documents, clearConversation, regenerate, modelsButton, settingsButton]) control.disabled = !enabled;
  const chatEnabled = enabled && pendingChats.size === 0;
  for (const control of [input, send, mode]) control.disabled = !chatEnabled;
}

function resetChat() {
  box.textContent = '';
  const welcome = document.createElement('div');
  welcome.className = 'welcome';
  welcome.id = 'welcome';
  const title = document.createElement('strong');
  title.textContent = 'What would you like to know?';
  welcome.append(title, `Ask about the documents in ${activeProject?.name ?? 'this project'}.`);
  box.append(welcome);
}

function appendTyping() {
  const row = message('assistant', '');
  row.classList.add('pending-response');
  row.querySelector('.bubble').innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  return row;
}

function renderPending(projectId, serverPending = []) {
  const questions = serverPending.map(item => item.question);
  const localQuestion = pendingChats.get(projectId);
  if (localQuestion && !questions.includes(localQuestion)) questions.push(localQuestion);
  for (const question of questions) {
    message('user', question);
    appendTyping();
  }
}

async function loadConversation(projectId) {
  try {
    const data = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/messages`, { cache: 'no-store' });
    if (activeProject?.id !== projectId) return;
    resetChat();
    for (const saved of data.messages) message(saved.role, saved.text, saved.sources || [], saved.meta || null);
    renderPending(projectId, data.pending || []);
  } catch (error) {
    if (activeProject?.id === projectId) notify(error.message || 'Could not load the conversation.', true);
  }
}

function projectHue(projectId) {
  let hash = 2166136261;
  for (const character of projectId) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

function renderProjects() {
  projectList.textContent = '';
  projectEmpty.hidden = projects.length > 0;
  for (const project of projects) {
    const row = document.createElement('div');
    row.className = `project-row${project.id === activeProject?.id ? ' active' : ''}`;
    row.style.setProperty('--project-hue', projectHue(project.id));

    const select = document.createElement('button');
    select.className = 'project-select';
    select.type = 'button';
    select.title = project.docsPath;
    const initial = document.createElement('span');
    initial.className = 'project-initial';
    initial.textContent = project.name.slice(0, 1).toUpperCase();
    const copy = document.createElement('span');
    copy.className = 'project-copy';
    const name = document.createElement('strong');
    name.textContent = project.name;
    const path = document.createElement('small');
    path.textContent = project.docsPath;
    copy.append(name, path);
    select.append(initial, copy);
    select.addEventListener('click', () => selectProject(project.id));

    const remove = document.createElement('button');
    remove.className = 'project-remove';
    remove.type = 'button';
    remove.title = `Remove ${project.name}`;
    remove.setAttribute('aria-label', `Remove ${project.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => removeProject(project));
    row.append(select, remove);
    projectList.append(row);
  }
}

function selectProject(id) {
  const selected = projects.find(project => project.id === id);
  if (!selected || selected.id === activeProject?.id) return;
  activeProject = selected;
  localStorage.setItem('local-rag-project', selected.id);
  activeProjectName.textContent = selected.name;
  activeProjectPath.textContent = selected.docsPath;
  modelName.textContent = selected.model;
  setControlsEnabled(true);
  renderProjects();
  resetChat();
  renderPending(selected.id);
  void loadConversation(selected.id);
  input.focus();
}

async function loadProjects(preferredId) {
  const data = await requestJson('/api/projects');
  projects = data.projects;
  const selectedId = preferredId || activeProject?.id || localStorage.getItem('local-rag-project');
  activeProject = null;
  renderProjects();
  const selected = projects.find(project => project.id === selectedId) || projects[0];
  if (selected) selectProject(selected.id);
  else {
    activeProjectName.textContent = 'No projects';
    activeProjectPath.textContent = 'Add a project to get started';
    setControlsEnabled(false);
  }
}

async function addNewProject() {
  addProject.disabled = true;
  try {
    const selection = await requestJson('/api/folders/select', { method: 'POST', headers: maintenanceHeaders, body: '{}' });
    if (selection.cancelled) return;
    const suggestedName = selection.path.split(/[\\/]/).filter(Boolean).at(-1) || 'New project';
    const name = prompt('Project name:', suggestedName)?.trim();
    if (!name) return;
    const data = await requestJson('/api/projects', {
      method: 'POST', headers: maintenanceHeaders,
      body: JSON.stringify({ name, docsPath: selection.path }),
    });
    await loadProjects(data.project.id);
    notify(`Project “${data.project.name}” created. Select Regenerate RAG to build its index.`);
  } catch (error) {
    notify(error.message || 'Could not create the project.', true);
  } finally {
    addProject.disabled = false;
  }
}

async function removeProject(project) {
  if (!confirm(`Remove project “${project.name}”? Its original documents will not be deleted.`)) return;
  try {
    await requestJson(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE', headers: maintenanceHeaders });
    pendingChats.delete(project.id);
    if (activeProject?.id === project.id) activeProject = null;
    await loadProjects();
    notify('Project removed. Its original documents are unchanged.');
  } catch (error) {
    notify(error.message || 'Could not remove the project.', true);
  }
}

function scrollToBottom() { box.scrollTop = box.scrollHeight; }

function message(role, text, sources = [], meta = null) {
  document.querySelector('#welcome')?.remove();
  const row = document.createElement('article');
  row.className = `message ${role}`;
  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar assistant-name';
    avatar.textContent = `${activeProject?.name ?? 'RAGen'} Agent`;
    row.append(avatar);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  if (sources.length) {
    const list = document.createElement('details');
    list.className = 'sources';
    const summary = document.createElement('summary');
    summary.textContent = sources.length === 1 ? '1 source' : `${sources.length} sources`;
    list.append(summary);
    for (const item of sources) {
      const line = document.createElement('span');
      line.className = 'source';
      line.textContent = `• ${item.source}${item.heading ? ` — ${item.heading}` : ''}`;
      line.title = item.id;
      list.append(line);
    }
    bubble.append(list);
  }
  if (meta) {
    const detail = document.createElement('div');
    detail.className = 'meta';
    detail.textContent = `${meta.cacheHit ? 'Cache · ' : ''}${(meta.totalMs / 1000).toFixed(1)} s`;
    bubble.append(detail);
  }
  row.append(bubble);
  box.append(row);
  scrollToBottom();
  return row;
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const question = input.value.trim();
  if (!question || send.disabled || !activeProject) return;
  const requestProjectId = activeProject.id;
  pendingChats.set(requestProjectId, question);
  message('user', question);
  input.value = '';
  resizeInput();
  setControlsEnabled(true);
  const pending = appendTyping();
  try {
    const data = await requestJson('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: requestProjectId, question, mode: mode.value }),
    });
    pending.remove();
    pendingChats.delete(requestProjectId);
    if (activeProject?.id === requestProjectId) await loadConversation(requestProjectId);
  } catch (error) {
    pending.remove();
    pendingChats.delete(requestProjectId);
    if (activeProject?.id === requestProjectId) message('assistant', `Error: ${error.message}`);
  } finally {
    setControlsEnabled(Boolean(activeProject));
    if (!input.disabled) input.focus();
  }
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});
addProject.addEventListener('click', addNewProject);

clearConversation.addEventListener('click', async () => {
  if (!activeProject || !confirm(`Clear the conversation for “${activeProject.name}”?`)) return;
  clearConversation.disabled = true;
  try {
    await requestJson(`/api/projects/${encodeURIComponent(activeProject.id)}/messages`, { method: 'DELETE', headers: maintenanceHeaders });
    pendingChats.delete(activeProject.id);
    resetChat();
    notify('Conversation cleared.');
  } catch (error) {
    notify(error.message || 'Could not clear the conversation.', true);
  } finally { clearConversation.disabled = false; }
});

documents.addEventListener('click', async () => {
  documents.disabled = true;
  try {
    await requestJson('/api/documents/open', { method: 'POST', headers: maintenanceHeaders, body: projectBody() });
  } catch (error) {
    notify(error.message || 'Could not open the folder.', true);
  } finally { documents.disabled = false; }
});

regenerate.addEventListener('click', async () => {
  if (!activeProject || !confirm(`The index for “${activeProject.name}” will be rebuilt. Continue?`)) return;
  const oldText = regenerate.textContent;
  for (const control of [regenerate, documents, send, mode]) control.disabled = true;
  regenerate.textContent = 'Regenerating…';
  notify('Regenerating the active project index…', false, true);
  try {
    const data = await requestJson('/api/rag/regenerate', { method: 'POST', headers: maintenanceHeaders, body: projectBody() });
    pendingChats.delete(activeProject.id);
    resetChat();
    notify(data.summary?.chunks ? `RAG updated: ${data.summary.chunks} chunks available.` : 'RAG updated successfully.');
  } catch (error) {
    notify(error.message || 'Could not regenerate the RAG.', true);
  } finally {
    regenerate.textContent = oldText;
    for (const control of [regenerate, documents, send, mode]) control.disabled = false;
    input.focus();
  }
});

const size = value => `${(value / 1e9).toFixed(1)} GB`;

async function pollInstall(name, button, bar) {
  await new Promise(resolve => setTimeout(resolve, 700));
  const data = await requestJson(`/api/models/install/status?model=${encodeURIComponent(name)}`);
  button.textContent = `${data.job.status} ${data.job.percent}%`;
  bar.style.width = `${data.job.percent}%`;
  if (data.job.state === 'downloading') return pollInstall(name, button, bar);
  if (data.job.state === 'error') { button.disabled = false; notify(data.job.error || 'Installation failed.', true); return; }
  notify(`${name} installed successfully.`);
  await loadModels();
}

async function loadModels() {
  modelList.textContent = 'Checking Ollama…';
  try {
    const data = await requestJson(`/api/models?${projectQuery()}`);
    const hw = data.hardware;
    hardware.textContent = hw.gpu
      ? `${hw.gpu} · ${(hw.vramBytes / 1073741824).toFixed(1)} GB VRAM · ${(hw.ramBytes / 1073741824).toFixed(1)} GB RAM`
      : `GPU/VRAM not detected · ${(hw.ramBytes / 1073741824).toFixed(1)} GB RAM · conservative estimate`;
    modelName.textContent = data.current;
    modelList.textContent = '';
    for (const item of data.models) {
      const card = document.createElement('div');
      card.className = 'model-card';
      const title = document.createElement('div');
      title.className = 'model-title';
      title.textContent = item.label;
      const rating = document.createElement('span');
      rating.className = `rating ${item.rating}`;
      rating.textContent = item.ratingLabel;
      rating.title = item.reason;
      title.append(' ', rating);
      const detail = document.createElement('div');
      detail.className = 'model-detail';
      detail.textContent = `${size(item.sizeBytes)}${item.quantization ? ` · ${item.quantization}` : ''} · ${item.installed ? 'Installed' : 'Not installed'}`;
      const action = document.createElement('button');
      action.className = 'model-action';
      action.type = 'button';
      action.textContent = item.selected ? 'Active' : item.installed ? 'Use' : 'Install';
      action.disabled = item.selected;
      action.addEventListener('click', async () => {
        if (item.rating === 'red' && !confirm(`${item.reason} Continue?`)) return;
        action.disabled = true;
        try {
          if (item.installed) {
            const selected = await requestJson('/api/models/select', { method: 'POST', headers: maintenanceHeaders, body: projectBody({ model: item.name }) });
            activeProject.model = selected.model;
            modelName.textContent = selected.model;
            notify(`Model for ${activeProject.name}: ${selected.model}`);
            renderProjects();
            await loadModels();
          } else {
            await requestJson('/api/models/install', { method: 'POST', headers: maintenanceHeaders, body: JSON.stringify({ model: item.name }) });
            const progress = document.createElement('div');
            progress.className = 'progress';
            const bar = document.createElement('span');
            bar.style.width = '0%';
            progress.append(bar);
            card.append(progress);
            await pollInstall(item.name, action, bar);
          }
        } catch (error) { action.disabled = false; notify(error.message || 'Could not change the model.', true); }
      });
      card.append(title, detail, action);
      modelList.append(card);
    }
  } catch (error) { modelList.textContent = `Error: ${error.message || 'Could not load models.'}`; }
}

function showReindex() {
  const changed = [...settingsList.querySelectorAll('[data-key]')].some(control =>
    reindexKeys.has(control.dataset.key) && control.value !== loadedSettings.find(item => item.key === control.dataset.key)?.value);
  reindexWrap.hidden = !changed;
}

const settingGuidance = {
  DOCS_DIR: 'Managed by the selected project. Change the project folder instead. The selected folder determines which documents are indexed.',
  DOCS_EXTENSIONS: 'Comma-separated file extensions to include. Add an extension to index that file type, or remove one to ignore it. Rebuild the index after changing it.',
  PDF_TO_TEXT_BIN: 'Fallback command for PDFs that PDF.js cannot read. Leave this as pdftotext unless that command is unavailable or you installed a compatible replacement.',
  CHUNKS_PATH: 'Managed by the selected project. This is the generated chunk file used during indexing, not a document source.',
  OLLAMA_URL: 'Address of your local Ollama server. Normally leave http://127.0.0.1:11434. A wrong address prevents all model and embedding requests; changing it requires rebuilding.',
  OLLAMA_EMBED_MODEL: 'Model that converts documents and questions into search vectors. A different model can improve or worsen retrieval, but existing vectors become incompatible, so rebuilding is required.',
  RAG_CHAT_MODEL: 'Managed by the selected project. Use the Models panel to switch it, which also shows whether the model fits your hardware.',
  OLLAMA_TEMPERATURE: 'Controls creativity. Lower values, especially 0, make answers more consistent and grounded. Higher values make wording more varied but increase the chance of unsupported answers.',
  CHROMA_COLLECTION: 'Managed by the selected project. It keeps this project’s vectors separate from every other project.',
  CHROMA_HOST: 'Address of the local Chroma database. Normally leave localhost. A wrong value prevents document search; changing it requires rebuilding the index.',
  CHROMA_PORT: 'Port used by the local Chroma database. Normally leave 8000. Change it only if Chroma was deliberately started on another port, then rebuild the index.',
  CHROMA_SSL: 'Set false for the normal local Chroma server. Set true only when Chroma is explicitly configured with HTTPS; the wrong value prevents connecting.',
  RAG_INDEX_DIR: 'Managed by the selected project. This folder contains the project’s optimized index and should not be shared between projects.',
  RAG_TOKENIZER_DIR: 'Keep auto for the bundled compatible tokenizer. Change it only if you prepared a matching tokenizer locally; an incompatible tokenizer can make context limits inaccurate.',
  RAG_CONTEXT: 'Maximum prompt context, in tokens. Lower values use less memory and are faster but may omit useful evidence. Higher values include more evidence but need more RAM or VRAM.',
  RAG_TIMEOUT_MS: 'Maximum wait time for one Ollama request, in milliseconds. Lower values fail sooner on slow hardware. Higher values tolerate slower models but make failures take longer to report.',
  RAG_KEEP_ALIVE: 'How long Ollama keeps a model loaded after an answer. Shorter values free memory sooner but make the next answer start slower. Longer values speed up follow-ups while using memory.',
  RAG_CANDIDATES: 'How many matching chunks retrieval examines before choosing evidence. Lower values are faster but can miss relevant passages. Higher values search more broadly but take longer.',
  RAG_RRF_K: 'Controls how strongly the top results are favored when combining keyword and semantic search. Lower values favor the very top hits more. Higher values spread weight more evenly across results.',
  RAG_CONTEXT_CHUNKS: 'How many best-matching chunks are given to the model. Fewer chunks keep answers focused but may miss context. More chunks add evidence but use more context and can introduce noise.',
  RAG_NEIGHBORS: 'How many chunks before and after each match are included. Lower values give precise excerpts. Higher values preserve surrounding context but increase prompt size and repetition.',
  RAG_DIRECT_TOKENS: 'Maximum answer length for Fast mode. Lower values produce shorter, faster answers. Higher values allow more detail but increase response time.',
  RAG_DEEP_TOKENS: 'Maximum answer length for Deep mode. Lower values keep deep answers concise. Higher values allow more detail but increase response time and model work.',
  RAG_DECISION_TOKENS: 'Budget for choosing the retrieval strategy. Lower values make this internal step faster but less thorough. Higher values allow more analysis before answering but add latency.',
  RAG_VALIDATION_TOKENS: 'Budget for checking a draft answer against retrieved evidence. Lower values are faster but perform less checking. Higher values may catch more unsupported claims but take longer.',
  ASK_PREFERRED_LANGUAGE: 'Language requested for generated answers. Use a language name such as English or Spanish. This changes the answer language, not the language of your documents.',
  SPLIT_TARGET_CHARS: 'Preferred chunk length. Lower values create smaller, more precise matches but split context more often. Higher values keep more text together but make matches broader. Rebuild required.',
  SPLIT_MAX_CHARS: 'Absolute maximum chunk length. Lowering it forces long sections to split sooner, which gives more precise retrieval but can separate related ideas. Raising it keeps longer sections together, which preserves context but makes retrieval less precise. Keep it at least as high as the target size. Rebuild required.',
  SPLIT_OVERLAP_CHARS: 'Text repeated between consecutive chunks. Lower values make a smaller, faster index but can cut context at boundaries. Higher values preserve continuity across boundaries but create more chunks and duplicate text. Rebuild required.',
  RAG_DEBUG: 'Use 0 for memory, timing and error logs. Set 1 to also save full questions, document prompts and raw model responses in rag/.runtime/logs/. These files contain document content.',
};

function makeSetting(setting) {
  const row = document.createElement('div');
  row.className = 'setting';
  const heading = document.createElement('div');
  heading.className = 'setting-heading';
  const label = document.createElement('label');
  label.htmlFor = `setting-${setting.key}`;
  label.textContent = setting.key;
  const tooltip = document.createElement('button');
  tooltip.className = 'setting-tooltip-trigger';
  tooltip.type = 'button';
  tooltip.textContent = '?';
  tooltip.setAttribute('aria-label', `Help for ${setting.key}`);
  tooltip.setAttribute('aria-describedby', 'setting-tooltip');
  const tooltipText = settingGuidance[setting.key] || setting.description || `Expected value: ${setting.defaultValue}.`;
  tooltip.addEventListener('pointerenter', () => showSettingTooltip(tooltip, tooltipText));
  tooltip.addEventListener('pointerleave', hideSettingTooltip);
  tooltip.addEventListener('focus', () => showSettingTooltip(tooltip, tooltipText));
  tooltip.addEventListener('blur', hideSettingTooltip);
  heading.append(label, tooltip);
  const help = document.createElement('small');
  help.textContent = managedSettings.has(setting.key)
    ? 'This value is managed automatically for the project.'
    : setting.description || `Default value: ${setting.defaultValue}`;
  let control;
  if (setting.type === 'select' || setting.type === 'boolean') {
    control = document.createElement('select');
    const options = setting.type === 'boolean' ? ['true', 'false'] : setting.options;
    for (const value of options) { const option = document.createElement('option'); option.value = value; option.textContent = value; control.append(option); }
  } else {
    control = document.createElement('input');
    control.type = setting.type === 'number' ? 'number' : 'text';
    if (setting.type === 'number') control.step = 'any';
  }
  control.id = `setting-${setting.key}`;
  control.dataset.key = setting.key;
  control.value = setting.value;
  control.disabled = managedSettings.has(setting.key);
  control.addEventListener('input', showReindex);
  control.addEventListener('change', showReindex);
  row.append(heading, control, help);
  return row;
}

async function loadSettings() {
  settingsList.textContent = 'Loading settings…';
  reindexWrap.hidden = true;
  try {
    const data = await requestJson(`/api/settings?${projectQuery()}`);
    loadedSettings = data.settings;
    settingsList.textContent = '';
    const groups = new Map();
    for (const setting of data.settings) {
      if (!groups.has(setting.section)) {
        const section = document.createElement('section');
        section.className = 'settings-section';
        const title = document.createElement('h3');
        title.textContent = setting.section;
        section.append(title);
        groups.set(setting.section, section);
        settingsList.append(section);
      }
      groups.get(setting.section).append(makeSetting(setting));
    }
  } catch (error) { settingsList.textContent = `Error: ${error.message || 'Could not load settings.'}`; }
}

settingsButton.addEventListener('click', () => { settingsDialog.showModal(); void loadSettings(); });
closeSettings.addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', event => { if (event.target === settingsDialog) settingsDialog.close(); });
settingsDialog.addEventListener('close', hideSettingTooltip);
applySettings.addEventListener('click', async () => {
  const values = {};
  for (const control of settingsList.querySelectorAll('[data-key]')) if (!control.disabled) values[control.dataset.key] = control.value;
  const oldText = applySettings.textContent;
  applySettings.disabled = true;
  applySettings.textContent = 'Applying…';
  try {
    const data = await requestJson('/api/settings', {
      method: 'POST', headers: maintenanceHeaders,
      body: projectBody({ settings: values, regenerate: !reindexWrap.hidden && reindexSettings.checked }),
    });
    if (data.reindexRequired && (!reindexSettings.checked || reindexWrap.hidden)) notify('Settings applied. Regenerate the RAG before asking questions.', false, true);
    else if (data.summary?.chunks) { pendingChats.delete(activeProject.id); resetChat(); notify(`Settings applied and RAG regenerated: ${data.summary.chunks} chunks.`); }
    else notify('Settings applied to the project.');
    await loadSettings();
  } catch (error) { notify(error.message || 'Could not apply settings.', true); }
  finally { applySettings.textContent = oldText; applySettings.disabled = false; }
});

modelsButton.addEventListener('click', () => { modelDialog.showModal(); void loadModels(); });
closeModels.addEventListener('click', () => modelDialog.close());
modelDialog.addEventListener('click', event => { if (event.target === modelDialog) modelDialog.close(); });

setControlsEnabled(false);
loadProjects().catch(error => notify(error.message || 'Could not load projects.', true));
