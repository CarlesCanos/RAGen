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
  if (!activeProject) throw new Error('Selecciona un proyecto.');
  return `projectId=${encodeURIComponent(activeProject.id)}`;
}

function projectBody(extra = {}) {
  if (!activeProject) throw new Error('Selecciona un proyecto.');
  return JSON.stringify({ projectId: activeProject.id, ...extra });
}

function setControlsEnabled(enabled) {
  for (const control of [documents, clearConversation, regenerate, modelsButton, settingsButton, input, send, mode]) control.disabled = !enabled;
}

function resetChat() {
  box.textContent = '';
  const welcome = document.createElement('div');
  welcome.className = 'welcome';
  welcome.id = 'welcome';
  const title = document.createElement('strong');
  title.textContent = '¿Qué quieres consultar?';
  welcome.append(title, `Pregunta sobre los documentos de ${activeProject?.name ?? 'este proyecto'}.`);
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
    if (activeProject?.id === projectId) notify(error.message || 'No se pudo cargar la conversación.', true);
  }
}

function renderProjects() {
  projectList.textContent = '';
  projectEmpty.hidden = projects.length > 0;
  for (const project of projects) {
    const row = document.createElement('div');
    row.className = `project-row${project.id === activeProject?.id ? ' active' : ''}`;

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
    remove.title = `Eliminar ${project.name}`;
    remove.setAttribute('aria-label', `Eliminar ${project.name}`);
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
    activeProjectName.textContent = 'Sin proyectos';
    activeProjectPath.textContent = 'Añade un proyecto para comenzar';
    setControlsEnabled(false);
  }
}

async function addNewProject() {
  addProject.disabled = true;
  try {
    const selection = await requestJson('/api/folders/select', { method: 'POST', headers: maintenanceHeaders, body: '{}' });
    if (selection.cancelled) return;
    const suggestedName = selection.path.split(/[\\/]/).filter(Boolean).at(-1) || 'Nuevo proyecto';
    const name = prompt('Nombre del proyecto:', suggestedName)?.trim();
    if (!name) return;
    const data = await requestJson('/api/projects', {
      method: 'POST', headers: maintenanceHeaders,
      body: JSON.stringify({ name, docsPath: selection.path }),
    });
    await loadProjects(data.project.id);
    notify(`Proyecto “${data.project.name}” creado. Pulsa Regenerar RAG para crear su índice.`);
  } catch (error) {
    notify(error.message || 'No se pudo crear el proyecto.', true);
  } finally {
    addProject.disabled = false;
  }
}

async function removeProject(project) {
  if (!confirm(`¿Eliminar el proyecto “${project.name}”? Los documentos originales no se borrarán.`)) return;
  try {
    await requestJson(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE', headers: maintenanceHeaders });
    pendingChats.delete(project.id);
    if (activeProject?.id === project.id) activeProject = null;
    await loadProjects();
    notify('Proyecto eliminado. Los documentos originales siguen intactos.');
  } catch (error) {
    notify(error.message || 'No se pudo eliminar el proyecto.', true);
  }
}

function scrollToBottom() { box.scrollTop = box.scrollHeight; }

function message(role, text, sources = [], meta = null) {
  document.querySelector('#welcome')?.remove();
  const row = document.createElement('article');
  row.className = `message ${role}`;
  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'AI';
    row.append(avatar);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  if (sources.length) {
    const list = document.createElement('details');
    list.className = 'sources';
    const summary = document.createElement('summary');
    summary.textContent = sources.length === 1 ? '1 fuente' : `${sources.length} fuentes`;
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
    detail.textContent = `${meta.cacheHit ? 'Caché · ' : ''}${(meta.totalMs / 1000).toFixed(1)} s`;
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
  send.disabled = true;
  mode.disabled = true;
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
    send.disabled = false;
    mode.disabled = false;
    input.focus();
  }
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});
addProject.addEventListener('click', addNewProject);

clearConversation.addEventListener('click', async () => {
  if (!activeProject || !confirm(`¿Borrar la conversación de “${activeProject.name}”?`)) return;
  clearConversation.disabled = true;
  try {
    await requestJson(`/api/projects/${encodeURIComponent(activeProject.id)}/messages`, { method: 'DELETE', headers: maintenanceHeaders });
    pendingChats.delete(activeProject.id);
    resetChat();
    notify('Conversación borrada.');
  } catch (error) {
    notify(error.message || 'No se pudo borrar la conversación.', true);
  } finally { clearConversation.disabled = false; }
});

documents.addEventListener('click', async () => {
  documents.disabled = true;
  try {
    await requestJson('/api/documents/open', { method: 'POST', headers: maintenanceHeaders, body: projectBody() });
  } catch (error) {
    notify(error.message || 'No se pudo abrir la carpeta.', true);
  } finally { documents.disabled = false; }
});

regenerate.addEventListener('click', async () => {
  if (!activeProject || !confirm(`Se actualizará el índice de “${activeProject.name}”. ¿Continuar?`)) return;
  const oldText = regenerate.textContent;
  for (const control of [regenerate, documents, send, mode]) control.disabled = true;
  regenerate.textContent = 'Regenerando…';
  notify('Regenerando el índice del proyecto activo…', false, true);
  try {
    const data = await requestJson('/api/rag/regenerate', { method: 'POST', headers: maintenanceHeaders, body: projectBody() });
    pendingChats.delete(activeProject.id);
    resetChat();
    notify(data.summary?.chunks ? `RAG actualizado: ${data.summary.chunks} fragmentos disponibles.` : 'RAG actualizado correctamente.');
  } catch (error) {
    notify(error.message || 'No se pudo regenerar el RAG.', true);
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
  if (data.job.state === 'error') { button.disabled = false; notify(data.job.error || 'Falló la instalación.', true); return; }
  notify(`${name} instalado correctamente.`);
  await loadModels();
}

async function loadModels() {
  modelList.textContent = 'Consultando Ollama…';
  try {
    const data = await requestJson(`/api/models?${projectQuery()}`);
    const hw = data.hardware;
    hardware.textContent = hw.gpu
      ? `${hw.gpu} · ${(hw.vramBytes / 1073741824).toFixed(1)} GB VRAM · ${(hw.ramBytes / 1073741824).toFixed(1)} GB RAM`
      : `GPU/VRAM no detectada · ${(hw.ramBytes / 1073741824).toFixed(1)} GB RAM · valoración conservadora`;
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
      detail.textContent = `${size(item.sizeBytes)}${item.quantization ? ` · ${item.quantization}` : ''} · ${item.installed ? 'Instalado' : 'No instalado'}`;
      const action = document.createElement('button');
      action.className = 'model-action';
      action.type = 'button';
      action.textContent = item.selected ? 'Activo' : item.installed ? 'Usar' : 'Instalar';
      action.disabled = item.selected;
      action.addEventListener('click', async () => {
        if (item.rating === 'red' && !confirm(`${item.reason} ¿Continuar?`)) return;
        action.disabled = true;
        try {
          if (item.installed) {
            const selected = await requestJson('/api/models/select', { method: 'POST', headers: maintenanceHeaders, body: projectBody({ model: item.name }) });
            activeProject.model = selected.model;
            modelName.textContent = selected.model;
            notify(`Modelo de ${activeProject.name}: ${selected.model}`);
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
        } catch (error) { action.disabled = false; notify(error.message || 'No se pudo cambiar el modelo.', true); }
      });
      card.append(title, detail, action);
      modelList.append(card);
    }
  } catch (error) { modelList.textContent = `Error: ${error.message || 'No se pudieron cargar los modelos.'}`; }
}

function showReindex() {
  const changed = [...settingsList.querySelectorAll('[data-key]')].some(control =>
    reindexKeys.has(control.dataset.key) && control.value !== loadedSettings.find(item => item.key === control.dataset.key)?.value);
  reindexWrap.hidden = !changed;
}

function makeSetting(setting) {
  const row = document.createElement('div');
  row.className = 'setting';
  const label = document.createElement('label');
  label.htmlFor = `setting-${setting.key}`;
  label.textContent = setting.key;
  const help = document.createElement('small');
  help.textContent = managedSettings.has(setting.key)
    ? 'Este valor se administra automáticamente para el proyecto.'
    : setting.description || `Valor predeterminado: ${setting.defaultValue}`;
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
  row.append(label, control, help);
  return row;
}

async function loadSettings() {
  settingsList.textContent = 'Cargando ajustes…';
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
  } catch (error) { settingsList.textContent = `Error: ${error.message || 'No se pudieron cargar los ajustes.'}`; }
}

settingsButton.addEventListener('click', () => { settingsDialog.showModal(); void loadSettings(); });
closeSettings.addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', event => { if (event.target === settingsDialog) settingsDialog.close(); });
applySettings.addEventListener('click', async () => {
  const values = {};
  for (const control of settingsList.querySelectorAll('[data-key]')) if (!control.disabled) values[control.dataset.key] = control.value;
  const oldText = applySettings.textContent;
  applySettings.disabled = true;
  applySettings.textContent = 'Aplicando…';
  try {
    const data = await requestJson('/api/settings', {
      method: 'POST', headers: maintenanceHeaders,
      body: projectBody({ settings: values, regenerate: !reindexWrap.hidden && reindexSettings.checked }),
    });
    if (data.reindexRequired && (!reindexSettings.checked || reindexWrap.hidden)) notify('Ajustes aplicados. Regenera el RAG antes de consultar.', false, true);
    else if (data.summary?.chunks) { pendingChats.delete(activeProject.id); resetChat(); notify(`Ajustes aplicados y RAG regenerado: ${data.summary.chunks} fragmentos.`); }
    else notify('Ajustes aplicados al proyecto.');
    await loadSettings();
  } catch (error) { notify(error.message || 'No se pudieron aplicar los ajustes.', true); }
  finally { applySettings.textContent = oldText; applySettings.disabled = false; }
});

modelsButton.addEventListener('click', () => { modelDialog.showModal(); void loadModels(); });
closeModels.addEventListener('click', () => modelDialog.close());
modelDialog.addEventListener('click', event => { if (event.target === modelDialog) modelDialog.close(); });

setControlsEnabled(false);
loadProjects().catch(error => notify(error.message || 'No se pudieron cargar los proyectos.', true));
