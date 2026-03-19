'use strict';

var currentUser = null;
var tasks = [];
var employees = [];
var managerUsers = [];
var activeId = null;
var timers = {};
var dragId = null;
var currentTab = 'team';
var tasksViewStatus = 'all';
var tasksViewSearch = '';
var tasksViewEmp = '';
var histFilterEmp = '';
var histFilterDate = '';
var historyData = [];
var editingId = null;
var pendingDoneId = null;
var token = localStorage.getItem('jvb_token') || null;
var modalEmpId = null;
var editingUserId = null;
var resetUserId = null;
var aiFeedbackPeriod = '7d';
var aiChatMessages = [];
var aiChatPending = false;
var aiFeedbackResult = null;
var aiFeedbackLoading = false;
var aiAssignmentResult = null;
var aiAssignmentLoading = false;
var aiInitialResult = null;
var aiInitialLoading = false;
var aiPendingAction = null;
var aiActionPending = false;
var aiAssignmentDraft = { title: '', description: '', assignedBy: '' };
var aiInitialDraft = { title: '', initialText: '', contextNote: '' };
var aiChatDraft = '';
var aiOperationalPeriod = '7d';
var aiOperationalSnapshot = null;
var aiOperationalLoading = false;
var aiProfilesState = { updatedAt: null, employees: [] };
var aiProfilesLoading = false;
var aiDocuments = [];
var aiDocumentsLoading = false;
var aiDocumentDetail = null;
var aiDocumentActiveId = null;
var aiDocumentUploading = false;
var aiDocumentAnalyzing = false;
var aiDocumentApplying = false;
var aiOperationalLoadedAt = 0;
var aiChatComposerExpanded = false;
var aiChatPlaceholderIndex = 0;
var aiChatMessageSeq = 0;

var AI_CHAT_PLACEHOLDERS = [
  'Ex: quem esta sobrecarregado hoje e o que devo redistribuir?',
  'Ex: crie uma tarefa de protocolo para Ana Clara com prazo de hoje.',
  'Ex: quais tarefas do Luan estao em andamento e ha quanto tempo?',
  'Ex: analise o PDF enviado e proponha as tarefas iniciais.',
  'Ex: qual colaborador performa melhor em tarefas administrativas?'
];

var AI_CHAT_COMMAND_SUGGESTIONS = [
  { label: 'Sobrecarga', command: 'Quem esta sobrecarregado hoje e o que devo redistribuir?' },
  { label: 'Redistribuir', command: 'Redistribua a tarefa "terminar distribuicao assistida" para o melhor responsavel disponivel.' },
  { label: 'Criar tarefa', command: 'Crie uma tarefa de acompanhamento processual para Ana Beatriz.' },
  { label: 'Status da equipe', command: 'Resuma as tarefas em andamento de toda a equipe.' },
  { label: 'Analisar PDF', command: 'Analise o PDF mais recente e sugira a distribuicao das tarefas.' }
];

function nextAiMessageId() {
  aiChatMessageSeq += 1;
  return 'ai-msg-' + aiChatMessageSeq;
}

function pushAiChatMessage(role, content, options) {
  var item = {
    id: nextAiMessageId(),
    role: role === 'assistant' ? 'assistant' : 'user',
    content: String(content || '')
  };
  if (options && options.meta) item.meta = options.meta;
  if (item.role === 'assistant') item.revealed = !!(options && options.revealed);
  aiChatMessages.push(item);
  return item;
}

function getAiChatPlaceholder() {
  return AI_CHAT_PLACEHOLDERS[aiChatPlaceholderIndex % AI_CHAT_PLACEHOLDERS.length];
}

function apiHeaders() {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

async function api(method, path, body) {
  var options = { method: method, headers: apiHeaders() };
  if (body) options.body = JSON.stringify(body);

  var res = await fetch('/api' + path, options);
  var text = await res.text();
  var data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || 'Erro na requisicao');
  return data;
}

async function doLogin() {
  var user = document.getElementById('loginUser').value.trim();
  var pass = document.getElementById('loginPass').value;
  var err = document.getElementById('loginErr');
  var btn = document.getElementById('loginBtn');
  err.textContent = '';
  if (!user || !pass) {
    err.textContent = 'Preencha usuario e senha';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Entrando...';
  try {
    var data = await api('POST', '/auth/login', { username: user, password: pass });
    token = data.token;
    localStorage.setItem('jvb_token', token);
    currentUser = data.user;
    await bootApp();
  } catch (error) {
    err.textContent = error.message;
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

async function doLogout() {
  try {
    await api('POST', '/auth/logout');
  } catch (error) {}
  token = null;
  currentUser = null;
  localStorage.removeItem('jvb_token');
  location.reload();
}

async function bootApp() {
  showLoading(true);
  try {
    await refreshSessionUser();
    await refreshWorkspace(false);

    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appShell').classList.add('visible');

    updateSidebarUser();

    if (currentUser.role === 'employee') {
      activeId = currentUser.id;
      document.getElementById('tab-mgr').style.display = 'none';
    } else if (!activeId || !findEmp(activeId)) {
      activeId = employees[0] ? employees[0].id : null;
    }

    renderTeam();
    updateDate();
    startAutoClose();
  } catch (error) {
    showToast('Erro ao carregar: ' + error.message);
  } finally {
    showLoading(false);
  }
}

(async function tryBootFromToken() {
  if (!token) return;
  try {
    currentUser = await api('GET', '/auth/me');
    await bootApp();
  } catch (error) {
    token = null;
    localStorage.removeItem('jvb_token');
  }
})();

async function refreshSessionUser() {
  if (!token) return null;
  currentUser = await api('GET', '/auth/me');
  return currentUser;
}

async function refreshWorkspace(withManagerUsers) {
  employees = await api('GET', '/team');
  tasks = await api('GET', '/tasks');

  resetTimers();
  tasks.forEach(function (task) {
    if (task.status === 'doing' && task.timerStart) startTimer(task.id);
  });

  if (withManagerUsers && currentUser && currentUser.role === 'manager') {
    managerUsers = await api('GET', '/manager/users');
  }

  syncAssignedByOptions();
  syncEmployeeOptions();

  if (activeId && !findEmp(activeId)) {
    activeId = employees[0] ? employees[0].id : null;
  }
}

async function loadManagerUsers() {
  if (!currentUser || currentUser.role !== 'manager') return [];
  managerUsers = await api('GET', '/manager/users');
  syncAssignedByOptions();
  return managerUsers;
}

function updateSidebarUser() {
  if (!currentUser) return;
  document.getElementById('sidebarUserName').textContent = currentUser.name;
  document.getElementById('sidebarUserRole').textContent = currentUser.role === 'manager' ? 'Gestor' : 'Funcionario';
  document.getElementById('sidebarUserAv').textContent = ini(currentUser.name);
  document.getElementById('sidebarUserAv').style.background = currentUser.color || '#2d7be5';
}

function syncAssignedByOptions() {
  var uniqueNames = [];
  var source = managerUsers.length ? managerUsers.filter(function (user) { return user.isActive; }) : employees.slice();

  source.forEach(function (user) {
    if (user && user.name && uniqueNames.indexOf(user.name) === -1) uniqueNames.push(user.name);
  });
  if (currentUser && currentUser.name && uniqueNames.indexOf(currentUser.name) === -1) {
    uniqueNames.unshift(currentUser.name);
  }

  fillSelectOptions('iAssignedBy', uniqueNames);
  fillSelectOptions('eAssignedVal', uniqueNames);
}

function syncEmployeeOptions() {
  fillEmployeeSelect('iEmp', employees, modalEmpId || activeId || (currentUser ? currentUser.id : null));
  fillEmployeeSelect('eEmpVal', employees, null);
}

function fillSelectOptions(id, names) {
  var select = document.getElementById(id);
  if (!select) return;
  var currentValue = select.value;
  var options = ['<option value="">Selecione...</option>', '<option value="Propria pessoa">Propria pessoa</option>'];
  names.forEach(function (name) {
    options.push('<option value="' + esc(name) + '">' + esc(name) + '</option>');
  });
  select.innerHTML = options.join('');
  if (currentValue) select.value = currentValue;
}

function fillEmployeeSelect(id, people, selectedId) {
  var select = document.getElementById(id);
  if (!select) return;
  var currentValue = select.value;
  var options = ['<option value="">Selecione...</option>'];
  people.forEach(function (person) {
    options.push('<option value="' + person.id + '">' + esc(person.name) + '</option>');
  });
  select.innerHTML = options.join('');
  var nextValue = selectedId != null ? String(selectedId) : currentValue;
  if (nextValue) select.value = nextValue;
}

function ini(name) {
  return (name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(function (part) { return part[0] ? part[0].toUpperCase() : ''; })
    .join('');
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value) {
  return esc(value).replace(/'/g, '&#39;');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function rep(ch, times) {
  var out = '';
  for (var i = 0; i < times; i += 1) out += ch;
  return out;
}

function fmtDateTime(value) {
  if (!value) return '—';
  var date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function cycleAiChatPlaceholder() {
  aiChatPlaceholderIndex = (aiChatPlaceholderIndex + 1) % AI_CHAT_PLACEHOLDERS.length;
  if (currentTab === 'mgr' && !aiChatDraft && !isManagerInteractionActive()) renderMgr();
}

function toggleAiChatComposer(forceExpanded) {
  var nextValue;
  if (typeof forceExpanded === 'boolean') {
    nextValue = forceExpanded;
  } else {
    nextValue = !aiChatComposerExpanded;
  }
  if (aiChatComposerExpanded === nextValue) return;
  aiChatComposerExpanded = nextValue;
  if (currentTab === 'mgr') renderMgr();
}

function useAiCommandSuggestion(command) {
  aiChatDraft = command || '';
  aiChatComposerExpanded = true;
  renderMgr();
  setTimeout(function () {
    var input = document.getElementById('aiChatInput');
    if (input) {
      input.focus();
      if (typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }, 0);
}

function triggerAiChatPdfPicker() {
  var input = document.getElementById('aiChatPdfInput') || document.getElementById('aiPdfInput');
  if (input) input.click();
}

function autoResizeAiChatInput() {
  var input = document.getElementById('aiChatInput');
  if (!input) return;
  input.style.height = '0px';
  input.style.height = Math.min(Math.max(input.scrollHeight, 52), 180) + 'px';
}

function hydrateManagerPanel() {
  autoResizeAiChatInput();
  animatePendingAiMessages();
  var list = document.querySelector('.ai-messages');
  if (list) list.scrollTop = list.scrollHeight;
}

function animatePendingAiMessages() {
  var pending = document.querySelectorAll('.ai-stream[data-stream-state="pending"]');
  pending.forEach(function (node) {
    var messageId = node.getAttribute('data-message-id');
    var content = node.getAttribute('data-stream-text') || '';
    if (!messageId || !content) {
      node.textContent = content;
      node.setAttribute('data-stream-state', 'done');
      return;
    }
    streamTextIntoNode(node, content, function () {
      var match = aiChatMessages.filter(function (item) { return item.id === messageId; })[0];
      if (match) match.revealed = true;
      node.setAttribute('data-stream-state', 'done');
    });
  });
}

function streamTextIntoNode(node, content, onDone) {
  if (!node) return;
  var text = String(content || '');
  if (!text || text.length > 900) {
    node.textContent = text;
    if (onDone) onDone();
    return;
  }

  node.textContent = '';
  var index = 0;
  var chunk = text.length > 320 ? 6 : 3;

  function tick() {
    index = Math.min(index + chunk, text.length);
    node.textContent = text.slice(0, index);
    if (index < text.length) {
      window.requestAnimationFrame(tick);
      return;
    }
    if (onDone) onDone();
  }

  window.requestAnimationFrame(tick);
}

function findTask(id) {
  for (var i = 0; i < tasks.length; i += 1) if (tasks[i].id === id) return tasks[i];
  return null;
}

function findEmp(id) {
  for (var i = 0; i < employees.length; i += 1) if (employees[i].id === id) return employees[i];
  return null;
}

function findManagerUser(id) {
  for (var i = 0; i < managerUsers.length; i += 1) if (managerUsers[i].id === id) return managerUsers[i];
  return null;
}

function countTasksByStatus(status) {
  if (status === 'all') return tasks.length;
  return tasks.filter(function (task) { return task.status === status; }).length;
}

function getOpenTasksByEmployee(empId) {
  return tasks.filter(function (task) {
    return task.empId === empId && task.status !== 'done';
  });
}

function getPreferredTaskEmpId() {
  if (tasksViewEmp && findEmp(Number(tasksViewEmp))) return Number(tasksViewEmp);
  if (activeId && findEmp(activeId)) return activeId;
  if (currentUser && currentUser.role === 'employee' && findEmp(currentUser.id)) return currentUser.id;
  return employees[0] ? employees[0].id : null;
}

function getTaskElapsedMs(task) {
  return (task.elapsed || 0) + (task.timerStart ? Date.now() - task.timerStart : 0);
}

function taskMatchesFilters(task) {
  var search = String(tasksViewSearch || '').trim().toLowerCase();
  var byStatus = tasksViewStatus === 'all' || task.status === tasksViewStatus;
  var byEmp = !tasksViewEmp || String(task.empId) === String(tasksViewEmp);
  var haystack = [
    task.title,
    task.desc,
    task.empName,
    task.assignedBy,
    task.createdByName,
    task.updatedByName
  ].join(' ').toLowerCase();
  var bySearch = !search || haystack.indexOf(search) !== -1;
  return byStatus && byEmp && bySearch;
}

function rerenderOperationalViews() {
  renderTeam();
  if (currentTab === 'all') renderAll();
  if (currentTab === 'tasks') renderTasksView();
  if (currentTab === 'mgr') renderMgr();
}

function getEmpColors(empId) {
  var emp = findEmp(empId);
  if (emp) return { colBg: emp.colBg || emp.col_bg, boardBg: emp.boardBg || emp.board_bg, pastel: emp.pastel };
  if (currentUser && currentUser.id === empId) {
    return { colBg: currentUser.colBg, boardBg: currentUser.boardBg, pastel: currentUser.pastel };
  }
  return { colBg: '#f4f8fe', boardBg: '#eef4fd', pastel: '#e8f0fc' };
}

function fmtMs(ms) {
  var seconds = Math.floor((ms || 0) / 1000);
  var hours = Math.floor(seconds / 3600);
  var minutes = Math.floor((seconds % 3600) / 60);
  var secs = seconds % 60;
  return pad(hours) + ':' + pad(minutes) + ':' + pad(secs);
}

function showLoading(value) {
  document.getElementById('loadingOverlay').classList.toggle('show', value);
}

function showToast(message) {
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(function () {
    toast.classList.remove('show');
  }, 2600);
}

function updateDate() {
  var el = document.getElementById('dateBadge');
  if (el) {
    el.textContent = new Date().toLocaleDateString('pt-BR', {
      weekday: 'short',
      day: '2-digit',
      month: 'short'
    });
  }
}

function overlayClose(id, event) {
  if (!event || event.target === document.getElementById(id)) {
    document.getElementById(id).classList.remove('open');
  }
}

function startTimer(id) {
  if (timers[id]) return;
  timers[id] = setInterval(function () {}, 1000);
}

function stopTimerLocal(id) {
  clearInterval(timers[id]);
  delete timers[id];
}

function resetTimers() {
  Object.keys(timers).forEach(function (id) {
    clearInterval(timers[id]);
    delete timers[id];
  });
}

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('view-all').style.display = tab === 'all' ? 'block' : 'none';
  document.getElementById('view-tasks').style.display = tab === 'tasks' ? 'block' : 'none';
  document.getElementById('view-team').style.display = tab === 'team' ? 'block' : 'none';
  document.getElementById('view-mgr').style.display = tab === 'mgr' ? 'block' : 'none';
  document.getElementById('tab-all').classList.toggle('active', tab === 'all');
  document.getElementById('tab-tasks').classList.toggle('active', tab === 'tasks');
  document.getElementById('tab-team').classList.toggle('active', tab === 'team');
  document.getElementById('tab-mgr').classList.toggle('active', tab === 'mgr');
  renderSidebar();
  if (tab === 'all') renderAll();
  if (tab === 'tasks') renderTasksView();
  if (tab === 'mgr') renderMgr();
}

function selectEmp(empId) {
  activeId = empId;
  renderTeam();
}

function openAdd(col) {
  var empId = currentTab === 'tasks' ? getPreferredTaskEmpId() : activeId;
  var emp = findEmp(empId);
  var empName = emp ? emp.name : '';
  if (!empName) {
    showToast('Selecione um funcionario');
    return;
  }

  modalEmpId = empId;
  document.getElementById('iTitle').value = '';
  document.getElementById('iDesc').value = '';
  document.getElementById('iAssignedBy').value = '';
  syncEmployeeOptions();
  document.getElementById('iEmp').value = String(empId);
  document.getElementById('iStatus').value = col || 'todo';
  document.getElementById('addModal').classList.add('open');
  setTimeout(function () {
    document.getElementById('iTitle').focus();
  }, 60);
}

async function addTask() {
  var title = document.getElementById('iTitle').value.trim();
  var desc = document.getElementById('iDesc').value.trim();
  var assignedBy = document.getElementById('iAssignedBy').value;
  var status = document.getElementById('iStatus').value;
  var userId = Number(document.getElementById('iEmp').value);

  if (!title) return showToast('Digite o titulo');
  if (!desc) return showToast('Digite a descricao');
  if (!assignedBy) return showToast('Selecione quem designou');
  if (!userId) return showToast('Selecione o responsavel');

  try {
    var task = await api('POST', '/tasks', {
      title: title,
      description: desc,
      assignedBy: assignedBy,
      status: status,
      userId: userId
    });
    tasks.unshift(task);
    if (task.status === 'doing') startTimer(task.id);
    activeId = task.empId;
    rerenderOperationalViews();
    overlayClose('addModal');
    showToast('Tarefa criada');
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteTask(id) {
  try {
    await api('DELETE', '/tasks/' + id);
    stopTimerLocal(id);
    tasks = tasks.filter(function (task) { return task.id !== id; });
    rerenderOperationalViews();
    showToast('Tarefa removida');
  } catch (error) {
    showToast(error.message);
  }
}

function changeStatus(id, nextStatus) {
  var task = findTask(id);
  if (!task || task.status === nextStatus) return;
  if (nextStatus === 'done') {
    pendingDoneId = id;
    openDoneModal();
    return;
  }
  doChangeStatus(id, nextStatus, {});
}

async function doChangeStatus(id, nextStatus, flags) {
  try {
    var updated = await api('PATCH', '/tasks/' + id + '/status', Object.assign({ newStatus: nextStatus }, flags));
    var index = tasks.findIndex(function (task) { return task.id === id; });
    if (index !== -1) tasks[index] = updated;
    if (nextStatus === 'doing') startTimer(id);
    else stopTimerLocal(id);
    rerenderOperationalViews();
  } catch (error) {
    showToast(error.message);
  }
}

function openDoneModal() {
  ['revisao', 'protocolo', 'agendei', 'dispensa', 'protreal', 'naoaplic'].forEach(function (key) {
    document.getElementById('chk-' + key).checked = false;
    document.getElementById('opt-' + key).classList.remove('selected');
  });
  document.getElementById('doneStep1').className = 'confirm-step active';
  document.getElementById('doneStep2').className = 'confirm-step';
  document.getElementById('sdot1').className = 'step-dot active';
  document.getElementById('sdot2').className = 'step-dot';
  document.getElementById('doneModal').classList.add('open');
}

function cancelDone() {
  pendingDoneId = null;
  document.getElementById('doneModal').classList.remove('open');
}

function goToStep2() {
  document.getElementById('doneStep1').className = 'confirm-step';
  document.getElementById('doneStep2').className = 'confirm-step active';
  document.getElementById('sdot1').className = 'step-dot done';
  document.getElementById('sdot2').className = 'step-dot active';
}

function backToStep1() {
  document.getElementById('doneStep1').className = 'confirm-step active';
  document.getElementById('doneStep2').className = 'confirm-step';
  document.getElementById('sdot1').className = 'step-dot active';
  document.getElementById('sdot2').className = 'step-dot';
}

function toggleOpt(optionId, checkboxId) {
  document.getElementById(optionId).classList.toggle('selected', document.getElementById(checkboxId).checked);
}

function confirmDone() {
  var flags = {
    needsRevisao: document.getElementById('chk-revisao').checked,
    needsProtocolo: document.getElementById('chk-protocolo').checked,
    flagAgendei: document.getElementById('chk-agendei').checked,
    flagDispensa: document.getElementById('chk-dispensa').checked,
    flagProtreal: document.getElementById('chk-protreal').checked,
    flagNaoAplic: document.getElementById('chk-naoaplic').checked
  };
  document.getElementById('doneModal').classList.remove('open');
  doChangeStatus(pendingDoneId, 'done', flags);
  pendingDoneId = null;
  showToast('Tarefa concluida');
}

function openEdit(id) {
  var task = findTask(id);
  if (!task) return;
  editingId = id;
  document.getElementById('eTitleVal').value = task.title || '';
  document.getElementById('eDescVal').value = task.desc || '';
  document.getElementById('eNotesVal').value = task.notes || '';
  document.getElementById('eAssignedVal').value = task.assignedBy || '';
  syncEmployeeOptions();
  document.getElementById('eEmpVal').value = String(task.empId);
  document.getElementById('eAuditInfo').textContent =
    'Criada por ' + (task.createdByName || '—') +
    ' · última edição ' + (task.updatedByName || '—') +
    (task.lastEditedAt ? ' em ' + fmtDateTime(task.lastEditedAt) : '');
  document.getElementById('editModal').classList.add('open');
  setTimeout(function () {
    document.getElementById('eTitleVal').focus();
  }, 60);
}

async function saveEdit() {
  var title = document.getElementById('eTitleVal').value.trim();
  if (!title) {
    showToast('Digite o titulo');
    return;
  }

  try {
    var updated = await api('PUT', '/tasks/' + editingId, {
      title: title,
      description: document.getElementById('eDescVal').value.trim(),
      notes: document.getElementById('eNotesVal').value.trim(),
      assignedBy: document.getElementById('eAssignedVal').value,
      userId: Number(document.getElementById('eEmpVal').value)
    });
    var index = tasks.findIndex(function (task) { return task.id === editingId; });
    if (index !== -1) tasks[index] = updated;
    activeId = updated.empId;
    rerenderOperationalViews();
    overlayClose('editModal');
    showToast('Tarefa atualizada');
  } catch (error) {
    showToast(error.message);
  }
}

function renderTeam() {
  renderSidebar();
  renderBoard();
  updateDate();
}

function renderSidebar() {
  var list = document.getElementById('empList');
  if (!list) return;
  list.innerHTML = '';

  employees.forEach(function (emp) {
    var empTasks = tasks.filter(function (task) { return task.empId === emp.id; });
    var doing = empTasks.filter(function (task) { return task.status === 'doing'; }).length;
    var isActive = currentTab === 'team' && emp.id === activeId;
    var row = document.createElement('div');
    row.className = 'emp-row' + (isActive ? ' active' : '');
    if (isActive && emp.pastel) {
      row.style.background = emp.pastel;
      row.style.borderColor = 'rgba(0,0,0,.08)';
    }
    row.onclick = function () { selectEmp(emp.id); };
    row.innerHTML =
      '<div class="emp-av" style="background:' + (emp.color || '#888') + '">' + ini(emp.name) + '</div>' +
      '<div class="emp-info">' +
      '<div class="emp-nm">' + esc(emp.name) + '</div>' +
      '<div class="emp-ct">' + empTasks.length + ' tarefa' + (empTasks.length !== 1 ? 's' : '') + ' · ' + doing + ' ativa' + (doing !== 1 ? 's' : '') + '</div>' +
      '</div>';
    list.appendChild(row);
  });

  var total = tasks.length;
  var doingCount = tasks.filter(function (task) { return task.status === 'doing'; }).length;
  var doneCount = tasks.filter(function (task) { return task.status === 'done'; }).length;
  var sf = document.getElementById('globalStats');
  if (sf) {
    sf.innerHTML =
      '<div class="gstat"><span>Tarefas</span><strong>' + total + '</strong></div>' +
      '<div class="gstat"><span>Em andamento</span><strong style="color:#60a5fa">' + doingCount + '</strong></div>' +
      '<div class="gstat"><span>Concluidas</span><strong style="color:#4ade80">' + doneCount + '</strong></div>';
  }
}

function renderBoard() {
  var wrap = document.getElementById('view-team');
  if (!wrap) return;

  var empId = activeId;
  var emp = findEmp(empId);

  if (!emp) {
    wrap.innerHTML = '<div class="no-emp-screen"><div class="no-emp-icon">👥</div><div class="no-emp-title">Nenhum funcionario ativo. Use o painel do gestor para cadastrar a equipe.</div></div>';
    wrap.style.background = '';
    wrap.style.border = '';
    return;
  }

  var colors = getEmpColors(empId);
  wrap.style.background = colors.boardBg || '#f4f5f7';
  wrap.style.borderRadius = '10px';
  wrap.style.border = '2px solid ' + (colors.boardBg || '#f4f5f7');

  var empTasks = tasks.filter(function (task) { return task.empId === empId; });
  var doing = empTasks.filter(function (task) { return task.status === 'doing'; }).length;
  var done = empTasks.filter(function (task) { return task.status === 'done'; }).length;

  wrap.innerHTML =
    '<div style="padding:16px 18px">' +
    '<div class="board-top">' +
    '<div class="board-who">' +
    '<div class="board-av" style="background:' + (emp.color || '#888') + ';box-shadow:0 0 14px ' + (emp.color || '#888') + '44">' + ini(emp.name) + '</div>' +
    '<div>' +
    '<div class="board-name">' + esc(emp.name) + '</div>' +
    '<div class="board-sub">' + empTasks.length + ' tarefa' + (empTasks.length !== 1 ? 's' : '') + ' · ' + doing + ' em andamento · ' + done + ' concluida' + (done !== 1 ? 's' : '') + '</div>' +
    '</div>' +
    '</div>' +
    '<button class="btn btn-primary btn-sm" onclick="openAdd(\'todo\')">+ Nova Tarefa</button>' +
    '</div>' +
    '<div class="board">' +
    mkCol('todo', 'A Fazer', 'dot-todo', '', empTasks, colors.colBg) +
    mkCol('doing', 'Em Andamento', 'dot-doing', 'count-doing', empTasks, colors.colBg) +
    mkCol('done', 'Concluido', 'dot-done', 'count-done', empTasks, colors.colBg) +
    '</div>' +
    '</div>';

  ['todo', 'doing', 'done'].forEach(function (status) {
    var col = document.getElementById('cl_' + status);
    if (!col) return;
    col.addEventListener('dragover', function (event) {
      event.preventDefault();
      col.classList.add('drag-over');
      var ph = document.getElementById('ph_' + status);
      if (ph) ph.style.display = 'block';
    });
    col.addEventListener('dragleave', function (event) {
      if (!col.contains(event.relatedTarget)) {
        col.classList.remove('drag-over');
        var ph = document.getElementById('ph_' + status);
        if (ph) ph.style.display = 'none';
      }
    });
    col.addEventListener('drop', function (event) {
      event.preventDefault();
      col.classList.remove('drag-over');
      var ph = document.getElementById('ph_' + status);
      if (ph) ph.style.display = 'none';
      if (dragId) changeStatus(dragId, status);
    });
  });
}

function mkCol(status, label, dotCls, countCls, empTasks, colBg) {
  var filtered = empTasks.filter(function (task) { return task.status === status; });
  var bgStyle = colBg ? ' style="background:' + colBg + '"' : '';
  var cards = filtered.length ? filtered.map(mkCard).join('') : '<div class="col-empty">Nenhuma tarefa</div>';
  return '<div class="col" id="cl_' + status + '"' + bgStyle + '>' +
    '<div class="col-head">' +
    '<div class="col-left"><div class="col-dot ' + dotCls + '"></div><span class="col-title">' + label + '</span><span class="col-count ' + countCls + '">' + filtered.length + '</span></div>' +
    '<button class="col-add-btn" onclick="openAdd(\'' + status + '\')">+</button>' +
    '</div>' +
    '<div class="col-body"><div class="drop-ph" id="ph_' + status + '"></div>' + cards + '</div>' +
    '</div>';
}

function mkCard(task) {
  var cls = 'card' + (task.status === 'doing' ? ' timer-active' : '');
  var flags = buildFlagTags(task);
  var audit =
    '<div class="card-assigned">👤 ' + esc(task.assignedBy || 'Sem designação') + '</div>' +
    '<div class="card-assigned">🧾 Criada por ' + esc(task.createdByName || '—') + '</div>' +
    '<div class="card-assigned">✍ Última edição ' + esc(task.updatedByName || '—') + (task.lastEditedAt ? ' · ' + esc(fmtDateTime(task.lastEditedAt)) : '') + '</div>';
  return '<div class="' + cls + '" draggable="true" data-id="' + task.id + '" data-status="' + task.status + '" ondragstart="dStart(event,\'' + task.id + '\')" ondragend="dEnd(event)">' +
    '<div class="card-title">' + esc(task.title) + '</div>' +
    (task.desc ? '<div class="card-desc">' + esc(task.desc.length > 80 ? task.desc.slice(0, 80) + '...' : task.desc) + '</div>' : '') +
    audit +
    (flags ? '<div class="card-flags">' + flags + '</div>' : '') +
    '<button class="card-edit" onclick="openEdit(\'' + task.id + '\')">✎</button>' +
    '<button class="card-del" onclick="deleteTask(\'' + task.id + '\')">✕</button>' +
    '</div>';
}

function buildFlagTags(task) {
  var tags = '';
  if (task.needsRevisao) tags += '<span class="flag-tag" style="background:#fff8e1;color:#b8860b;border:1px solid #f5c300">Revisao</span>';
  if (task.needsProtocolo) tags += '<span class="flag-tag" style="background:#e8f8ef;color:#27ae60;border:1px solid #a8d5b5">Protocolo</span>';
  if (task.flagAgendei) tags += '<span class="flag-tag" style="background:#e8f0fc;color:#2d7be5;border:1px solid #b0c8f0">Agendado</span>';
  if (task.flagDispensa) tags += '<span class="flag-tag" style="background:#f3eafc;color:#8e44ad;border:1px solid #d5b8e8">Dispensa</span>';
  if (task.flagProtreal) tags += '<span class="flag-tag" style="background:#e8f8ef;color:#27ae60;border:1px solid #a8d5b5">Prot.Real.</span>';
  if (task.flagNaoAplic) tags += '<span class="flag-tag" style="background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0">N/A</span>';
  return tags;
}

function dStart(event, id) {
  dragId = id;
  event.currentTarget.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
}

function dEnd(event) {
  dragId = null;
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drop-ph').forEach(function (placeholder) { placeholder.style.display = 'none'; });
  document.querySelectorAll('.all-drop-ph').forEach(function (placeholder) { placeholder.style.display = 'none'; });
  document.querySelectorAll('.col').forEach(function (col) { col.classList.remove('drag-over'); });
  document.querySelectorAll('.all-emp-col').forEach(function (col) { col.classList.remove('drag-over'); });
}

async function renderAll() {
  var panel = document.getElementById('view-all');
  if (!panel) return;
  var now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  var cols = employees.map(function (emp) {
    var color = emp.color || '#888';
    var colBg = emp.colBg || '#f4f8fe';
    var openTasks = getOpenTasksByEmployee(emp.id);
    var doingTasks = openTasks.filter(function (task) { return task.status === 'doing'; });
    var badge = doingTasks.length > 0
      ? '<span class="doing-badge">' + doingTasks.length + ' em andamento</span>'
      : '<span class="idle-badge">Aguardando</span>';
    var cards = openTasks.length
      ? openTasks.map(function (task) {
        return '<div class="all-task-card ' + task.status + '" draggable="true" data-task-id="' + task.id + '" ondragstart="dStart(event,\'' + task.id + '\')" ondragend="dEnd(event)">' +
          '<div class="all-task-head">' +
          '<div class="all-task-title">' + esc(task.title) + '</div>' +
          '<div class="all-task-mini-actions">' +
          '<button class="card-edit" style="opacity:1;position:static" onclick="openEdit(\'' + task.id + '\')">✎</button>' +
          '<button class="card-del" style="opacity:1;position:static" onclick="deleteTask(\'' + task.id + '\')">✕</button>' +
          '</div>' +
          '</div>' +
          (task.desc ? '<div class="all-task-sub">' + esc(task.desc.length > 88 ? task.desc.slice(0, 88) + '...' : task.desc) + '</div>' : '') +
          '<div class="all-task-meta">' +
          '<span>Designado por ' + esc(task.assignedBy || '—') + '</span>' +
          '<span>' + esc(task.status === 'doing' ? 'Em andamento' : 'A fazer') + '</span>' +
          '</div>' +
          (buildFlagTags(task) ? '<div class="all-task-flags">' + buildFlagTags(task) + '</div>' : '') +
          '</div>';
      }).join('')
      : '<div class="all-empty">Sem tarefas abertas</div>';

    return '<div class="all-emp-col" data-emp-drop="' + emp.id + '" style="border-top:3px solid ' + color + '">' +
      '<div class="all-emp-head" style="background:' + colBg + '">' +
      '<div class="all-emp-av" style="background:' + color + '">' + ini(emp.name) + '</div>' +
      '<div><div class="all-emp-name">' + esc(emp.name) + '</div><div class="all-emp-status">' + badge + '</div></div>' +
      '</div>' +
      '<div class="all-task-list"><div class="all-drop-ph">Solte aqui para reatribuir</div>' + cards + '</div>' +
      '</div>';
  }).join('');

  panel.innerHTML =
    '<div style="padding:16px 18px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)">' +
    '<div style="font-size:15px;font-weight:600">Visao Geral da Equipe</div>' +
    '<span style="font-size:11px;color:var(--text-light)">Atualizado as ' + now + '</span>' +
    '</div>' +
    '<div class="all-grid">' + cols + '</div>' +
    '</div>';

  bindAllViewDropzones();
}

function bindAllViewDropzones() {
  document.querySelectorAll('[data-emp-drop]').forEach(function (dropzone) {
    var empId = Number(dropzone.getAttribute('data-emp-drop'));
    dropzone.addEventListener('dragover', function (event) {
      event.preventDefault();
      dropzone.classList.add('drag-over');
      var ph = dropzone.querySelector('.all-drop-ph');
      if (ph) ph.style.display = 'flex';
    });
    dropzone.addEventListener('dragleave', function (event) {
      if (!dropzone.contains(event.relatedTarget)) {
        dropzone.classList.remove('drag-over');
        var ph = dropzone.querySelector('.all-drop-ph');
        if (ph) ph.style.display = 'none';
      }
    });
    dropzone.addEventListener('drop', function (event) {
      event.preventDefault();
      dropzone.classList.remove('drag-over');
      var ph = dropzone.querySelector('.all-drop-ph');
      if (ph) ph.style.display = 'none';
      if (!dragId) return;
      reassignTaskToEmployee(dragId, empId);
    });
  });
}

async function reassignTaskToEmployee(taskId, empId) {
  var task = findTask(taskId);
  if (!task || Number(task.empId) === Number(empId)) return;

  try {
    var updated = await api('PUT', '/tasks/' + taskId, {
      title: task.title,
      description: task.desc || '',
      notes: task.notes || '',
      assignedBy: task.assignedBy || '',
      userId: empId
    });
    var index = tasks.findIndex(function (item) { return item.id === taskId; });
    if (index !== -1) tasks[index] = updated;
    activeId = updated.empId;
    rerenderOperationalViews();
    showToast('Tarefa redistribuida para ' + updated.empName);
  } catch (error) {
    showToast(error.message);
  }
}

function renderTasksView() {
  var panel = document.getElementById('view-tasks');
  if (!panel) return;

  var filtered = tasks.filter(taskMatchesFilters);
  var empOptions = ['<option value="">Todos os responsaveis</option>'].concat(
    employees.map(function (emp) {
      return '<option value="' + emp.id + '"' + (String(tasksViewEmp) === String(emp.id) ? ' selected' : '') + '>' + esc(emp.name) + '</option>';
    })
  ).join('');

  var cards = filtered.length
    ? filtered.map(function (task) {
      var flags = buildFlagTags(task);
      return '<div class="task-hub-card status-' + task.status + '">' +
        '<div class="task-hub-head">' +
        '<div>' +
        '<div class="task-hub-title">' + esc(task.title) + '</div>' +
        '<div class="task-hub-sub">Responsavel: ' + esc(task.empName || '—') + ' · Designado por ' + esc(task.assignedBy || '—') + '</div>' +
        '</div>' +
        '<span class="task-hub-status">' + esc(task.status === 'todo' ? 'A fazer' : task.status === 'doing' ? 'Em progresso' : 'Concluida') + '</span>' +
        '</div>' +
        (task.desc ? '<div class="task-hub-desc">' + esc(task.desc) + '</div>' : '') +
        '<div class="task-hub-meta">' +
        '<span>Tempo: ' + fmtMs(getTaskElapsedMs(task)) + '</span>' +
        '<span>Criada por ' + esc(task.createdByName || '—') + '</span>' +
        '<span>Ultima edicao ' + esc(task.updatedByName || '—') + (task.lastEditedAt ? ' · ' + esc(fmtDateTime(task.lastEditedAt)) : '') + '</span>' +
        '</div>' +
        (flags ? '<div class="task-hub-flags">' + flags + '</div>' : '') +
        '<div class="task-hub-actions">' +
        '<button class="btn btn-ghost btn-sm" onclick="openEdit(\'' + task.id + '\')">Editar</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="changeStatus(\'' + task.id + '\',\'todo\')">A fazer</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="changeStatus(\'' + task.id + '\',\'doing\')">Em progresso</button>' +
        '<button class="btn btn-amber btn-sm" onclick="changeStatus(\'' + task.id + '\',\'done\')">Concluir</button>' +
        '<button class="btn btn-danger btn-sm" onclick="deleteTask(\'' + task.id + '\')">Excluir</button>' +
        '</div>' +
        '</div>';
    }).join('')
    : '<div class="task-hub-empty">Nenhuma tarefa encontrada com os filtros atuais.</div>';

  panel.innerHTML =
    '<div class="task-hub">' +
    '<div class="task-hub-topbar">' +
    '<div><div class="task-hub-heading">Central de Tarefas</div><div class="task-hub-copy">Visualize, filtre e opere qualquer tarefa do sistema em uma unica tela.</div></div>' +
    '<button class="btn btn-primary btn-sm" onclick="openAdd(\'todo\')">+ Nova Tarefa</button>' +
    '</div>' +
    '<div class="task-hub-stats">' +
    buildTaskStat('Todas', 'all') +
    buildTaskStat('A fazer', 'todo') +
    buildTaskStat('Em progresso', 'doing') +
    buildTaskStat('Concluidas', 'done') +
    '</div>' +
    '<div class="task-hub-filters">' +
    '<input class="task-hub-search" value="' + esc(tasksViewSearch) + '" oninput="tasksViewSearch=this.value;renderTasksView()" placeholder="Buscar por titulo, descricao, responsavel ou designante" />' +
    '<select class="task-hub-select" onchange="tasksViewEmp=this.value;renderTasksView()">' + empOptions + '</select>' +
    '<select class="task-hub-select" onchange="tasksViewStatus=this.value;renderTasksView()">' +
    '<option value="all"' + (tasksViewStatus === 'all' ? ' selected' : '') + '>Todos os status</option>' +
    '<option value="todo"' + (tasksViewStatus === 'todo' ? ' selected' : '') + '>A fazer</option>' +
    '<option value="doing"' + (tasksViewStatus === 'doing' ? ' selected' : '') + '>Em progresso</option>' +
    '<option value="done"' + (tasksViewStatus === 'done' ? ' selected' : '') + '>Concluidas</option>' +
    '</select>' +
    '</div>' +
    '<div class="task-hub-grid">' + cards + '</div>' +
    '</div>';
}

function buildTaskStat(label, status) {
  var active = tasksViewStatus === status;
  return '<button class="task-hub-stat' + (active ? ' active' : '') + '" onclick="tasksViewStatus=\'' + status + '\';renderTasksView()">' +
    '<span>' + esc(label) + '</span>' +
    '<strong>' + countTasksByStatus(status) + '</strong>' +
    '</button>';
}

function renderMgr() {
  var panel = document.getElementById('mgrPanel');
  if (!panel) return;
  if (currentUser && currentUser.role !== 'manager') {
    panel.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-light)">Acesso restrito ao gestor.</div>';
    return;
  }
  buildDashboardV2().then(function (html) {
    panel.innerHTML = html;
    hydrateManagerPanel();
  }).catch(function (error) {
    panel.innerHTML = '<div style="padding:40px;text-align:center;color:var(--red)">Erro ao carregar painel: ' + esc(error.message) + '</div>';
  });
}

function tagBadge(label, bg, color, border) {
  return '<span style="font-size:9px;font-weight:600;padding:1px 4px;border-radius:5px;background:' + bg + ';color:' + color + ';border:1px solid ' + border + ';margin-left:2px">' + label + '</span>';
}

function buildUsersSection() {
  var total = managerUsers.length;
  var active = managerUsers.filter(function (user) { return user.isActive; }).length;
  var rows = managerUsers.map(function (user) {
    var roleCls = user.role === 'manager' ? 'role-pill manager' : 'role-pill employee';
    var roleLabel = user.role === 'manager' ? 'Gestor' : 'Funcionario';
    var statusCls = user.isActive ? 'status-pill active' : 'status-pill inactive';
    var statusLabel = user.isActive ? 'Ativo' : 'Inativo';
    return '<div class="user-row">' +
      '<div class="user-identity"><div class="et-av" style="background:' + (user.color || '#888') + '">' + ini(user.name) + '</div><div><div class="user-name">' + esc(user.name) + '</div><div class="user-meta">@' + esc(user.username) + '</div></div></div>' +
      '<div><span class="' + roleCls + '">' + roleLabel + '</span></div>' +
      '<div><span class="' + statusCls + '">' + statusLabel + '</span></div>' +
      '<div class="user-actions">' +
      '<button class="btn btn-ghost btn-sm" onclick="openUserModal(' + user.id + ')">Editar</button>' +
      '<button class="btn btn-purple btn-sm" onclick="openResetUserPassword(' + user.id + ')">Senha</button>' +
      '<button class="btn ' + (user.isActive ? 'btn-danger' : 'btn-primary') + ' btn-sm" onclick="toggleUserStatus(' + user.id + ',' + (!user.isActive) + ')">' + (user.isActive ? 'Desativar' : 'Ativar') + '</button>' +
      '</div>' +
      '</div>';
  }).join('');

  return '<div class="user-admin">' +
    '<div class="user-admin-head"><div><strong>' + active + '</strong> ativos de <strong>' + total + '</strong> usuarios</div><button class="btn btn-primary btn-sm" onclick="openUserModal()">Cadastrar Usuario</button></div>' +
    '<div class="user-table">' +
    '<div class="user-head"><span>Usuario</span><span>Perfil</span><span>Status</span><span>Acoes</span></div>' +
    (rows || '<div class="user-empty">Nenhum usuario cadastrado.</div>') +
    '</div>' +
    '</div>';
}

function buildAiSection() {
  var chatHtml = aiChatMessages.length
    ? aiChatMessages.map(function (item) {
      var bg = item.role === 'assistant' ? '#f8fafc' : '#eef4fd';
      var align = item.role === 'assistant' ? 'flex-start' : 'flex-end';
      return '<div style="display:flex;justify-content:' + align + ';margin-bottom:8px">' +
        '<div style="max-width:85%;background:' + bg + ';border:1px solid var(--border);border-radius:12px;padding:10px 12px;font-size:12px;line-height:1.55;white-space:pre-wrap">' + esc(item.content) + '</div>' +
        '</div>';
    }).join('')
    : '<div style="font-size:12px;color:var(--text-light)">Pergunte sobre desempenho, gargalos, redistribuição ou próximos passos do time.</div>';

  var feedbackHtml = '<div style="font-size:12px;color:var(--text-light)">Gere uma leitura assistida da produção por período.</div>';
  if (aiFeedbackLoading) {
    feedbackHtml = '<div style="font-size:12px;color:var(--text-light)">Gerando feedback...</div>';
  } else if (aiFeedbackResult) {
    feedbackHtml =
      '<div style="display:grid;gap:10px">' +
      '<div><strong>Resumo:</strong> ' + esc(aiFeedbackResult.summary || '') + '</div>' +
      buildMiniList('Destaques', aiFeedbackResult.teamHighlights) +
      buildMiniList('Gargalos', aiFeedbackResult.bottlenecks) +
      buildMiniList('Recomendações', aiFeedbackResult.recommendations) +
      '<div style="display:grid;gap:8px">' + (aiFeedbackResult.employees || []).map(function (item) {
        return '<div style="border:1px solid var(--border);border-radius:10px;padding:10px;background:#fff">' +
          '<div style="font-weight:600">' + esc(item.name) + ' <span style="font-weight:500;color:var(--text-light)">· ' + esc(item.scoreLabel || '') + '</span></div>' +
          '<div style="font-size:12px;margin-top:4px">' + esc(item.feedback || '') + '</div>' +
          '<div style="font-size:11px;color:var(--text-light);margin-top:6px">Risco: ' + esc(item.risk || '') + '</div>' +
          '<div style="font-size:11px;color:var(--text-light);margin-top:2px">Próximo passo: ' + esc(item.nextStep || '') + '</div>' +
          '</div>';
      }).join('') + '</div>' +
      '</div>';
  }

  var assignmentHtml = '<div style="font-size:12px;color:var(--text-light)">Preencha o rascunho da tarefa para ranquear os melhores responsáveis.</div>';
  if (aiAssignmentLoading) {
    assignmentHtml = '<div style="font-size:12px;color:var(--text-light)">Calculando sugestão...</div>';
  } else if (aiAssignmentResult) {
    assignmentHtml =
      '<div style="display:grid;gap:10px">' +
      '<div><strong>Síntese:</strong> ' + esc(aiAssignmentResult.summary || '') + '</div>' +
      (aiAssignmentResult.candidates || []).map(function (candidate, index) {
        return '<div style="border:1px solid var(--border);border-radius:10px;padding:10px;background:#fff">' +
          '<div style="display:flex;justify-content:space-between;gap:10px"><strong>' + (index + 1) + '. ' + esc(candidate.name) + '</strong><span style="font-size:11px;color:var(--text-light)">score ' + esc(candidate.score) + '</span></div>' +
          '<div style="font-size:12px;margin-top:4px">' + esc(candidate.reason || '') + '</div>' +
          '<div style="margin-top:8px"><button class="btn btn-primary btn-sm" onclick="applyAssignmentCandidate(' + candidate.userId + ')">Usar no cadastro</button></div>' +
          '</div>';
      }).join('') +
      '</div>';
  }

  var triageHtml = '<div style="font-size:12px;color:var(--text-light)">Cole o texto da inicial para gerar checklist, prioridade e tarefas sugeridas.</div>';
  if (aiInitialLoading) {
    triageHtml = '<div style="font-size:12px;color:var(--text-light)">Analisando inicial...</div>';
  } else if (aiInitialResult) {
    triageHtml =
      '<div style="display:grid;gap:10px">' +
      '<div><strong>Prioridade:</strong> ' + esc(formatPriority(aiInitialResult.priority)) + '</div>' +
      '<div>' + esc(aiInitialResult.summary || '') + '</div>' +
      buildMiniList('Riscos', aiInitialResult.risks) +
      buildMiniList('Checklist', aiInitialResult.checklist) +
      buildMiniList('Próximos passos', aiInitialResult.nextSteps) +
      '<div style="display:grid;gap:8px">' + (aiInitialResult.suggestedTasks || []).map(function (task, index) {
        return '<div style="border:1px solid var(--border);border-radius:10px;padding:10px;background:#fff">' +
          '<div style="font-weight:600">' + esc(task.title) + '</div>' +
          '<div style="font-size:12px;margin-top:4px">' + esc(task.description || '') + '</div>' +
          '<div style="font-size:11px;color:var(--text-light);margin-top:6px">Responsável sugerido: ' + esc(task.assignedToName || '') + '</div>' +
          '<div style="font-size:11px;color:var(--text-light);margin-top:2px">' + esc(task.reason || '') + '</div>' +
          '<div style="margin-top:8px"><button class="btn btn-primary btn-sm" onclick="useTriageSuggestion(' + index + ')">Abrir no cadastro</button></div>' +
          '</div>';
      }).join('') + '</div>' +
      (aiInitialResult.runId ? '<div><button class="btn btn-amber btn-sm" onclick="createInitialTasksFromAi()">Criar tarefas sugeridas</button></div>' : '') +
      '</div>';
  }

  return '<div style="display:grid;gap:18px;margin-bottom:24px">' +
    '<div style="border:1px solid var(--border);border-radius:16px;padding:16px;background:linear-gradient(135deg,#f9fbff 0%,#f4f8ff 100%)">' +
    '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px"><div><div style="font-size:18px;font-weight:700">Assistente IA do Gestor</div><div style="font-size:12px;color:var(--text-light)">Feedback de produção, sugestão de responsáveis e triagem assistida de iniciais. Tudo com confirmação manual.</div></div><div style="font-size:11px;color:var(--text-light)">Exige GEMINI_API_KEY no backend</div></div>' +
    '<div style="display:grid;grid-template-columns:1.2fr 1fr;gap:14px">' +
    '<div style="border:1px solid var(--border);border-radius:14px;background:#fff;padding:12px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><strong>Chat administrativo</strong>' + (aiChatPending ? '<span style="font-size:11px;color:var(--text-light)">Respondendo...</span>' : '') + '</div>' +
    '<div style="min-height:220px;max-height:280px;overflow:auto;margin-bottom:10px">' + chatHtml + '</div>' +
    '<textarea id="aiChatInput" oninput="aiChatDraft=this.value" placeholder="Ex: quem está sobrecarregado hoje e o que devo redistribuir?" style="width:100%;min-height:78px;border:1px solid var(--border);border-radius:10px;padding:10px;font:inherit">' + esc(aiChatDraft) + '</textarea>' +
    '<div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn btn-primary btn-sm" onclick="runAiChat()">Enviar</button></div>' +
    '</div>' +
    '<div style="display:grid;gap:12px">' +
    '<div style="border:1px solid var(--border);border-radius:14px;background:#fff;padding:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px"><strong>Feedback de performance</strong><div style="display:flex;gap:8px;align-items:center"><select id="aiFeedbackPeriod" onchange="aiFeedbackPeriod=this.value" style="border:1px solid var(--border);border-radius:8px;padding:6px 8px"><option value="today"' + (aiFeedbackPeriod === 'today' ? ' selected' : '') + '>Hoje</option><option value="7d"' + (aiFeedbackPeriod === '7d' ? ' selected' : '') + '>7 dias</option><option value="30d"' + (aiFeedbackPeriod === '30d' ? ' selected' : '') + '>30 dias</option><option value="history"' + (aiFeedbackPeriod === 'history' ? ' selected' : '') + '>Histórico</option></select><button class="btn btn-primary btn-sm" onclick="runAiFeedback()">Gerar</button></div></div>' + feedbackHtml + '</div>' +
    '<div style="border:1px solid var(--border);border-radius:14px;background:#fff;padding:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px"><strong>Distribuição assistida</strong><button class="btn btn-primary btn-sm" onclick="runAiAssignment()">Sugerir</button></div><input id="aiAssignTitle" value="' + esc(aiAssignmentDraft.title) + '" oninput="aiAssignmentDraft.title=this.value" placeholder="Título da tarefa" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px;font:inherit" /><textarea id="aiAssignDesc" oninput="aiAssignmentDraft.description=this.value" placeholder="Descrição / contexto da tarefa" style="width:100%;min-height:74px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px;font:inherit">' + esc(aiAssignmentDraft.description) + '</textarea><input id="aiAssignBy" value="' + esc(aiAssignmentDraft.assignedBy) + '" oninput="aiAssignmentDraft.assignedBy=this.value" placeholder="Designado por" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:inherit" />' + '<div style="margin-top:10px">' + assignmentHtml + '</div></div>' +
    '<div style="border:1px solid var(--border);border-radius:14px;background:#fff;padding:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px"><strong>Triagem de iniciais</strong><button class="btn btn-primary btn-sm" onclick="runAiInitialTriage()">Analisar</button></div><input id="aiInitialTitle" value="' + esc(aiInitialDraft.title) + '" oninput="aiInitialDraft.title=this.value" placeholder="Título / assunto do caso" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px;font:inherit" /><textarea id="aiInitialText" oninput="aiInitialDraft.initialText=this.value" placeholder="Cole aqui o texto da inicial" style="width:100%;min-height:120px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px;font:inherit">' + esc(aiInitialDraft.initialText) + '</textarea><textarea id="aiInitialContext" oninput="aiInitialDraft.contextNote=this.value" placeholder="Contexto extra opcional (cliente, urgência, prazo, observações)" style="width:100%;min-height:58px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:inherit">' + esc(aiInitialDraft.contextNote) + '</textarea><div style="margin-top:10px">' + triageHtml + '</div></div>' +
    '</div>' +
    '</div>' +
    '</div>';
}

function buildAiSectionV2() {
  var chatHtml = aiChatMessages.length
    ? aiChatMessages.map(function (item) {
      var role = item.role === 'assistant' ? 'assistant' : 'user';
      var meta = item.meta ? '<div class="ai-bubble-meta">' + esc(item.meta) + '</div>' : '';
      var body = item.role === 'assistant' && item.id && !item.revealed
        ? '<div class="ai-bubble-copy ai-stream" data-message-id="' + escAttr(item.id) + '" data-stream-state="pending" data-stream-text="' + escAttr(item.content) + '"></div>'
        : '<div class="ai-bubble-copy">' + esc(item.content) + '</div>';
      return '<div class="ai-bubble-row ' + role + '">' +
        '<div class="ai-bubble ' + role + '">' + meta + body + '</div>' +
        '</div>';
    }).join('')
    : '<div class="ai-empty-state">' +
      '<div class="ai-empty-kicker">Assistente operacional do escritorio</div>' +
      '<div class="ai-empty-title">Peça redistribuição, leitura de carga, criação de tarefas e apoio na análise de PDFs.</div>' +
      '<div class="ai-empty-copy">O assistente prepara ações reais, mas nenhuma mudança é executada sem sua confirmação. Use os atalhos abaixo para começar mais rápido.</div>' +
      '</div>';

  var feedbackHtml = buildAiFeedbackPanel();
  var assignmentHtml = buildAiAssignmentPanel();
  var triageHtml = buildAiTriagePanel();
  var commandsHtml = AI_CHAT_COMMAND_SUGGESTIONS.map(function (item) {
    return '<button class="ai-command-chip" onclick="useAiCommandSuggestion(\'' + escAttr(item.command) + '\')"><span>' + esc(item.label) + '</span></button>';
  }).join('');
  var placeholder = getAiChatPlaceholder();

  return '<section class="ai-shell">' +
    '<div class="ai-chat-card">' +
      '<div class="ai-card-head">' +
        '<div>' +
          '<div class="ai-kicker">Assistente IA do Gestor</div>' +
          '<h2 class="ai-title">Operação assistida com leitura clara, comandos úteis e execução confirmável.</h2>' +
          '<p class="ai-copy">Use o chat para entender a carga da equipe, propor redistribuição, criar tarefas, ajustar status e puxar a análise de PDFs pendentes sem sair da primeira dobra do painel.</p>' +
        '</div>' +
        '<div class="ai-head-status">' +
          '<span class="ai-status-pill ' + (aiChatPending || aiActionPending ? 'busy' : 'ready') + '">' + (aiChatPending ? 'Respondendo' : aiActionPending ? 'Executando' : 'Pronto') + '</span>' +
          '<span class="ai-status-note">Toda alteração em tarefa continua exigindo confirmação manual</span>' +
        '</div>' +
      '</div>' +
      '<div class="ai-messages">' + chatHtml + '</div>' +
      (aiPendingAction ? buildAiPendingActionCard() : '') +
      '<div class="ai-command-row">' + commandsHtml + '</div>' +
      '<div class="ai-composer-shell' + ((aiChatComposerExpanded || aiChatDraft) ? ' expanded' : '') + '" onclick="toggleAiChatComposer(true)">' +
        '<input id="aiChatPdfInput" type="file" accept="application/pdf" style="display:none" onchange="handleAiPdfSelected(event)" />' +
        '<div class="ai-composer-top">' +
          '<button class="ai-composer-icon" type="button" onclick="event.stopPropagation();triggerAiChatPdfPicker()" title="Anexar PDF"><span>PDF</span></button>' +
          '<div class="ai-composer-field">' +
            '<textarea id="aiChatInput" class="ai-chat-input" onfocus="toggleAiChatComposer(true)" oninput="aiChatDraft=this.value;autoResizeAiChatInput()" onkeydown="handleAiChatKeydown(event)" placeholder="">' + esc(aiChatDraft) + '</textarea>' +
            (!aiChatDraft ? '<div class="ai-chat-placeholder">' + esc(placeholder) + '</div>' : '') +
          '</div>' +
          '<button class="ai-composer-icon disabled" type="button" disabled title="Microfone indisponivel nesta versao"><span>Voz</span></button>' +
          '<button class="ai-send-btn" type="button" onclick="event.stopPropagation();runAiChat()">' + (aiChatPending ? 'Aguarde...' : 'Enviar') + '</button>' +
        '</div>' +
        '<div class="ai-composer-footer modern">' +
          '<div class="ai-helper-text">Descreva a ação ou use um comando sugerido. Você também pode anexar um PDF para alimentar a triagem e a distribuição assistida.</div>' +
          '<div class="ai-composer-tools"><span class="ai-inline-pill">Carga da equipe</span><span class="ai-inline-pill">Redistribuição</span><span class="ai-inline-pill">PDF de pendencias</span></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="ai-tool-grid">' +
      '<div class="ai-tool-card">' +
        '<div class="ai-tool-head"><div><strong>Feedback de performance</strong><div class="ai-tool-subhead">Leitura assistida da produção por período, com foco em risco, próximo passo e gargalo.</div></div><div class="ai-inline-actions"><select id="aiFeedbackPeriod" onchange="aiFeedbackPeriod=this.value" class="ai-select"><option value="today"' + (aiFeedbackPeriod === 'today' ? ' selected' : '') + '>Hoje</option><option value="7d"' + (aiFeedbackPeriod === '7d' ? ' selected' : '') + '>7 dias</option><option value="30d"' + (aiFeedbackPeriod === '30d' ? ' selected' : '') + '>30 dias</option><option value="history"' + (aiFeedbackPeriod === 'history' ? ' selected' : '') + '>Histórico</option></select><button class="btn btn-primary btn-sm" onclick="runAiFeedback()">Gerar</button></div></div>' +
        '<div class="ai-tool-body">' + feedbackHtml + '</div>' +
      '</div>' +
      '<div class="ai-tool-card">' +
        '<div class="ai-tool-head"><div><strong>Distribuição assistida</strong><div class="ai-tool-subhead">Use o rascunho da tarefa para ranquear os melhores responsáveis com justificativa objetiva.</div></div><button class="btn btn-primary btn-sm" onclick="runAiAssignment()">Sugerir</button></div>' +
        '<div class="ai-form-grid">' +
          '<input id="aiAssignTitle" class="ai-input" value="' + esc(aiAssignmentDraft.title) + '" oninput="aiAssignmentDraft.title=this.value" placeholder="Título da tarefa" />' +
          '<textarea id="aiAssignDesc" class="ai-textarea compact" oninput="aiAssignmentDraft.description=this.value" placeholder="Descrição / contexto da tarefa">' + esc(aiAssignmentDraft.description) + '</textarea>' +
          '<input id="aiAssignBy" class="ai-input" value="' + esc(aiAssignmentDraft.assignedBy) + '" oninput="aiAssignmentDraft.assignedBy=this.value" placeholder="Designado por" />' +
        '</div>' +
        '<div class="ai-tool-body">' + assignmentHtml + '</div>' +
      '</div>' +
      '<div class="ai-tool-card">' +
        '<div class="ai-tool-head"><div><strong>Triagem de iniciais</strong><div class="ai-tool-subhead">Transforme texto bruto em checklist, prioridade e tarefas iniciais sugeridas para o time.</div></div><button class="btn btn-primary btn-sm" onclick="runAiInitialTriage()">Analisar</button></div>' +
        '<div class="ai-form-grid">' +
          '<input id="aiInitialTitle" class="ai-input" value="' + esc(aiInitialDraft.title) + '" oninput="aiInitialDraft.title=this.value" placeholder="Título / assunto do caso" />' +
          '<textarea id="aiInitialText" class="ai-textarea tall" oninput="aiInitialDraft.initialText=this.value" placeholder="Cole aqui o texto da inicial">' + esc(aiInitialDraft.initialText) + '</textarea>' +
          '<textarea id="aiInitialContext" class="ai-textarea compact" oninput="aiInitialDraft.contextNote=this.value" placeholder="Contexto extra opcional (cliente, urgência, prazo, observações)">' + esc(aiInitialDraft.contextNote) + '</textarea>' +
        '</div>' +
        '<div class="ai-tool-body">' + triageHtml + '</div>' +
      '</div>' +
    '</div>' +
  '</section>';
}

function buildAiPendingActionCard() {
  var preview = aiPendingAction && aiPendingAction.actionPreview ? aiPendingAction.actionPreview : {};
  var meta = [];
  if (preview.currentTaskTitle) meta.push('<span><strong>Tarefa:</strong> ' + esc(preview.currentTaskTitle) + '</span>');
  if (preview.currentAssignee) meta.push('<span><strong>Atual:</strong> ' + esc(preview.currentAssignee) + '</span>');
  if (preview.nextAssignee) meta.push('<span><strong>Novo responsável:</strong> ' + esc(preview.nextAssignee) + '</span>');
  if (preview.nextStatus) meta.push('<span><strong>Status:</strong> ' + esc(formatTaskStatusLabel(preview.nextStatus)) + '</span>');

  return '<div class="ai-pending-card">' +
    '<div class="ai-pending-head">' +
      '<div><div class="ai-pending-kicker">Confirmação obrigatória</div><div class="ai-pending-title">' + esc(preview.label || 'Ação preparada pelo assistente') + '</div></div>' +
      '<span class="ai-status-pill warn">' + (aiActionPending ? 'Executando' : 'Pendente') + '</span>' +
    '</div>' +
    '<div class="ai-pending-summary">' + esc(preview.summary || aiPendingAction.reason || '') + '</div>' +
    (meta.length ? '<div class="ai-pending-meta">' + meta.join('') + '</div>' : '') +
    (aiPendingAction.reason ? '<div class="ai-pending-reason">' + esc(aiPendingAction.reason) + '</div>' : '') +
    '<div class="ai-confirm-actions">' +
      '<button class="btn btn-primary btn-sm" onclick="confirmAiPendingAction()">' + (aiActionPending ? 'Executando...' : 'Confirmar ação') + '</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="cancelAiPendingAction()">Cancelar</button>' +
    '</div>' +
  '</div>';
}

function buildAiFeedbackPanel() {
  if (aiFeedbackLoading) return '<div class="ai-result-empty">Gerando feedback...</div>';
  if (!aiFeedbackResult) return '<div class="ai-result-empty">Gere uma leitura assistida da produção por período.</div>';

  return '<div class="ai-result-stack">' +
    '<div class="ai-result-lead"><strong>Resumo:</strong> ' + esc(aiFeedbackResult.summary || '') + '</div>' +
    buildMiniList('Destaques', aiFeedbackResult.teamHighlights) +
    buildMiniList('Gargalos', aiFeedbackResult.bottlenecks) +
    buildMiniList('Recomendações', aiFeedbackResult.recommendations) +
    '<div class="ai-result-grid">' + (aiFeedbackResult.employees || []).map(function (item) {
      return '<div class="ai-mini-card">' +
        '<div class="ai-mini-title">' + esc(item.name) + ' <span>' + esc(item.scoreLabel || '') + '</span></div>' +
        '<div class="ai-mini-copy">' + esc(item.feedback || '') + '</div>' +
        '<div class="ai-mini-meta">Risco: ' + esc(item.risk || '') + '</div>' +
        '<div class="ai-mini-meta">Próximo passo: ' + esc(item.nextStep || '') + '</div>' +
      '</div>';
    }).join('') + '</div>' +
  '</div>';
}

function buildAiAssignmentPanel() {
  if (aiAssignmentLoading) return '<div class="ai-result-empty">Calculando sugestão...</div>';
  if (!aiAssignmentResult) return '<div class="ai-result-empty">Preencha o rascunho da tarefa para ranquear os melhores responsáveis.</div>';

  return '<div class="ai-result-stack">' +
    '<div class="ai-result-lead"><strong>Síntese:</strong> ' + esc(aiAssignmentResult.summary || '') + '</div>' +
    (aiAssignmentResult.candidates || []).map(function (candidate, index) {
      return '<div class="ai-mini-card">' +
        '<div class="ai-mini-title">' + (index + 1) + '. ' + esc(candidate.name) + ' <span>score ' + esc(candidate.score) + '</span></div>' +
        '<div class="ai-mini-copy">' + esc(candidate.reason || '') + '</div>' +
        '<div class="ai-inline-actions"><button class="btn btn-primary btn-sm" onclick="applyAssignmentCandidate(' + candidate.userId + ')">Usar no cadastro</button></div>' +
      '</div>';
    }).join('') +
  '</div>';
}

function buildAiTriagePanel() {
  if (aiInitialLoading) return '<div class="ai-result-empty">Analisando inicial...</div>';
  if (!aiInitialResult) return '<div class="ai-result-empty">Cole o texto da inicial para gerar checklist, prioridade e tarefas sugeridas.</div>';

  return '<div class="ai-result-stack">' +
    '<div class="ai-result-lead"><strong>Prioridade:</strong> ' + esc(formatPriority(aiInitialResult.priority)) + '</div>' +
    '<div class="ai-mini-copy">' + esc(aiInitialResult.summary || '') + '</div>' +
    buildMiniList('Riscos', aiInitialResult.risks) +
    buildMiniList('Checklist', aiInitialResult.checklist) +
    buildMiniList('Próximos passos', aiInitialResult.nextSteps) +
    '<div class="ai-result-grid">' + (aiInitialResult.suggestedTasks || []).map(function (task, index) {
      return '<div class="ai-mini-card">' +
        '<div class="ai-mini-title">' + esc(task.title) + '</div>' +
        '<div class="ai-mini-copy">' + esc(task.description || '') + '</div>' +
        '<div class="ai-mini-meta">Responsável sugerido: ' + esc(task.assignedToName || '') + '</div>' +
        '<div class="ai-mini-meta">' + esc(task.reason || '') + '</div>' +
        '<div class="ai-inline-actions"><button class="btn btn-primary btn-sm" onclick="useTriageSuggestion(' + index + ')">Abrir no cadastro</button></div>' +
      '</div>';
    }).join('') + '</div>' +
    (aiInitialResult.runId ? '<div class="ai-inline-actions"><button class="btn btn-amber btn-sm" onclick="createInitialTasksFromAi()">Criar tarefas sugeridas</button></div>' : '') +
  '</div>';
}

function formatTaskStatusLabel(value) {
  return {
    todo: 'A Fazer',
    doing: 'Em andamento',
    done: 'Concluída'
  }[value] || value || '';
}

function buildMiniList(title, items) {
  var list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return '';
  return '<div class="ai-list-block"><strong>' + esc(title) + ':</strong><ul class="ai-bullet-list">' + list.map(function (item) {
    return '<li>' + esc(item) + '</li>';
  }).join('') + '</ul></div>';
}

function formatPriority(value) {
  var labels = { baixa: 'Baixa', media: 'Média', alta: 'Alta', critica: 'Crítica' };
  return labels[value] || value || 'Média';
}

async function runAiFeedback() {
  aiFeedbackLoading = true;
  renderMgr();
  try {
    aiFeedbackResult = await api('POST', '/manager/ai/feedback', { period: aiFeedbackPeriod, mode: 'refresh' });
  } catch (error) {
    showToast(error.message);
  } finally {
    aiFeedbackLoading = false;
    renderMgr();
  }
}

async function runAiAssignment() {
  aiAssignmentLoading = true;
  renderMgr();
  try {
    aiAssignmentResult = await api('POST', '/manager/ai/task-assignment', aiAssignmentDraft);
  } catch (error) {
    showToast(error.message);
  } finally {
    aiAssignmentLoading = false;
    renderMgr();
  }
}

async function runAiInitialTriage() {
  aiInitialLoading = true;
  renderMgr();
  try {
    aiInitialResult = await api('POST', '/manager/ai/initial-triage', aiInitialDraft);
  } catch (error) {
    showToast(error.message);
  } finally {
    aiInitialLoading = false;
    renderMgr();
  }
}

function handleAiChatKeydown(event) {
  if (!event) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    runAiChat();
  }
}

async function runAiChat() {
  var message = (document.getElementById('aiChatInput') ? document.getElementById('aiChatInput').value : aiChatDraft).trim();
  if (!message || aiChatPending) return;
  pushAiChatMessage('user', message);
  aiChatDraft = '';
  aiPendingAction = null;
  aiChatPending = true;
  aiChatComposerExpanded = true;
  renderMgr();
  try {
    var reply = await api('POST', '/manager/ai/chat', {
      message: message,
      history: aiChatMessages.slice(-8)
    });
    aiPendingAction = reply.pendingAction
      ? {
        type: reply.pendingAction.type,
        taskId: reply.pendingAction.taskId,
        payload: reply.pendingAction.payload || {},
        reason: reply.pendingAction.reason || '',
        actionPreview: reply.actionPreview || null
      }
      : null;
    pushAiChatMessage('assistant', reply.reply || 'Sem resposta da IA.', {
      revealed: false,
      meta: reply.mode === 'action' ? 'acao preparada' : 'analise operacional'
    });
    if (reply.suggestions && reply.suggestions.length) {
      pushAiChatMessage('assistant', 'Sugestões:\n- ' + reply.suggestions.join('\n- '), {
        revealed: false,
        meta: 'sugestões'
      });
    }
    if (reply.alerts && reply.alerts.length) {
      pushAiChatMessage('assistant', 'Alertas:\n- ' + reply.alerts.join('\n- '), {
        revealed: false,
        meta: 'alertas'
      });
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    aiChatPending = false;
    renderMgr();
  }
}

async function confirmAiPendingAction() {
  if (!aiPendingAction || aiActionPending) return;
  aiActionPending = true;
  renderMgr();
  try {
    var result = await api('POST', '/manager/ai/execute', {
      type: aiPendingAction.type,
      taskId: aiPendingAction.taskId,
      payload: aiPendingAction.payload
    });
    pushAiChatMessage('assistant', result.message || 'Ação executada com sucesso.', {
      revealed: false,
      meta: 'ação confirmada'
    });
    aiPendingAction = null;
    await refreshWorkspace(true);
    rerenderOperationalViews();
    showToast('Ação confirmada');
  } catch (error) {
    showToast(error.message);
  } finally {
    aiActionPending = false;
    renderMgr();
  }
}

function cancelAiPendingAction() {
  if (!aiPendingAction) return;
  pushAiChatMessage('assistant', 'Ação cancelada. Nenhuma tarefa foi alterada.', {
    revealed: false,
    meta: 'ação cancelada'
  });
  aiPendingAction = null;
  renderMgr();
}

function applyAssignmentCandidate(userId) {
  var chosen = employees.filter(function (emp) { return emp.id === userId; })[0];
  if (!chosen) return showToast('Responsável não encontrado');
  activeId = chosen.id;
  switchTab('team');
  openAdd('todo');
  document.getElementById('iEmp').value = String(chosen.id);
  document.getElementById('iTitle').value = aiAssignmentDraft.title || '';
  document.getElementById('iDesc').value = aiAssignmentDraft.description || '';
  if (aiAssignmentDraft.assignedBy) document.getElementById('iAssignedBy').value = aiAssignmentDraft.assignedBy;
}

function useTriageSuggestion(index) {
  if (!aiInitialResult || !aiInitialResult.suggestedTasks || !aiInitialResult.suggestedTasks[index]) return;
  var task = aiInitialResult.suggestedTasks[index];
  activeId = task.assignedToUserId;
  switchTab('team');
  openAdd('todo');
  document.getElementById('iEmp').value = String(task.assignedToUserId);
  document.getElementById('iTitle').value = task.title || '';
  document.getElementById('iDesc').value = task.description || '';
  document.getElementById('iAssignedBy').value = currentUser ? currentUser.name : '';
}

async function createInitialTasksFromAi() {
  if (!aiInitialResult || !aiInitialResult.runId) return;
  try {
    await api('POST', '/manager/ai/initial-triage/' + aiInitialResult.runId + '/create-tasks');
    await refreshWorkspace(true);
    rerenderOperationalViews();
    showToast('Tarefas sugeridas criadas');
  } catch (error) {
    showToast(error.message);
  }
}

async function ensureOperationalAiData(forceRefresh) {
  if (!currentUser || currentUser.role !== 'manager') return;
  if (aiOperationalLoading && !forceRefresh) return;
  var stale = Date.now() - aiOperationalLoadedAt > 60000;
  if (!forceRefresh && aiOperationalLoadedAt && !stale) return;

  try {
    aiOperationalLoading = true;
    aiProfilesLoading = true;
    aiDocumentsLoading = true;
    if (currentTab === 'mgr') renderMgr();

    var snapshot;
    try {
      snapshot = await api('GET', '/manager/ai/reports/latest?period=' + encodeURIComponent(aiOperationalPeriod));
    } catch (error) {
      snapshot = await api('POST', '/manager/ai/reports/refresh', {
        period: aiOperationalPeriod,
        source: forceRefresh ? 'manual_force' : 'manual_boot'
      });
    }

    aiOperationalSnapshot = snapshot;
    aiProfilesState = await api('GET', '/manager/ai/performance-profiles');
    aiDocuments = await api('GET', '/manager/ai/pending-documents');

    if (aiDocumentActiveId) {
      try {
        aiDocumentDetail = await api('GET', '/manager/ai/pending-documents/' + aiDocumentActiveId);
      } catch (error) {
        aiDocumentDetail = null;
        aiDocumentActiveId = null;
      }
    } else if (aiDocuments.length) {
      aiDocumentActiveId = aiDocuments[0].id;
      aiDocumentDetail = await api('GET', '/manager/ai/pending-documents/' + aiDocumentActiveId);
    }

    aiOperationalLoadedAt = Date.now();
  } catch (error) {
    showToast(error.message);
  } finally {
    aiOperationalLoading = false;
    aiProfilesLoading = false;
    aiDocumentsLoading = false;
    if (currentTab === 'mgr') renderMgr();
  }
}

async function refreshOperationalSnapshot() {
  if (aiOperationalLoading) return;
  aiOperationalLoading = true;
  renderMgr();
  try {
    aiOperationalSnapshot = await api('POST', '/manager/ai/reports/refresh', {
      period: aiOperationalPeriod,
      source: 'manual_refresh'
    });
    aiProfilesState = await api('GET', '/manager/ai/performance-profiles');
    aiOperationalLoadedAt = Date.now();
    showToast('Inteligencia operacional atualizada');
  } catch (error) {
    showToast(error.message);
  } finally {
    aiOperationalLoading = false;
    renderMgr();
  }
}

async function changeOperationalPeriod(value) {
  aiOperationalPeriod = value || '7d';
  aiOperationalLoadedAt = 0;
  await ensureOperationalAiData(true);
}

async function openPendingDocument(id) {
  aiDocumentActiveId = id;
  aiDocumentsLoading = true;
  renderMgr();
  try {
    aiDocumentDetail = await api('GET', '/manager/ai/pending-documents/' + id);
  } catch (error) {
    showToast(error.message);
  } finally {
    aiDocumentsLoading = false;
    renderMgr();
  }
}

async function handleAiPdfSelected(event) {
  var file = event && event.target && event.target.files && event.target.files[0];
  if (!file) return;
  if (!/pdf$/i.test(file.name)) {
    showToast('Selecione um PDF valido');
    return;
  }

  aiDocumentUploading = true;
  renderMgr();
  try {
    var contentBase64 = await readFileAsDataUrl(file);
    var document = await api('POST', '/manager/ai/pending-documents', {
      filename: file.name,
      mimeType: file.type || 'application/pdf',
      contentBase64: contentBase64
    });
    aiDocumentActiveId = document.id;
    aiDocuments = await api('GET', '/manager/ai/pending-documents');
    aiDocumentDetail = await api('GET', '/manager/ai/pending-documents/' + document.id);
    aiOperationalLoadedAt = Date.now();
    pushAiChatMessage('assistant', 'PDF "' + file.name + '" importado com sucesso. Ele ja esta disponivel no painel de documentos e pode ser analisado agora.', {
      revealed: false,
      meta: 'pdf importado'
    });
    showToast('PDF enviado e registrado');
  } catch (error) {
    showToast(error.message);
  } finally {
    aiDocumentUploading = false;
    if (event && event.target) event.target.value = '';
    renderMgr();
  }
}

async function analyzeActivePendingDocument() {
  if (!aiDocumentActiveId || aiDocumentAnalyzing) return;
  aiDocumentAnalyzing = true;
  renderMgr();
  try {
    aiDocumentDetail = await api('POST', '/manager/ai/pending-documents/' + aiDocumentActiveId + '/analyze');
    aiDocuments = await api('GET', '/manager/ai/pending-documents');
    aiOperationalLoadedAt = Date.now();
    showToast('PDF analisado com sucesso');
  } catch (error) {
    showToast(error.message);
  } finally {
    aiDocumentAnalyzing = false;
    renderMgr();
  }
}

async function applyActivePendingAssignments() {
  if (!aiDocumentActiveId || aiDocumentApplying) return;
  aiDocumentApplying = true;
  renderMgr();
  try {
    await api('POST', '/manager/ai/pending-documents/' + aiDocumentActiveId + '/apply-assignments');
    await refreshWorkspace(true);
    aiDocuments = await api('GET', '/manager/ai/pending-documents');
    aiDocumentDetail = await api('GET', '/manager/ai/pending-documents/' + aiDocumentActiveId);
    aiOperationalLoadedAt = 0;
    showToast('Tarefas do PDF aplicadas');
  } catch (error) {
    showToast(error.message);
  } finally {
    aiDocumentApplying = false;
    renderMgr();
  }
}

function readFileAsDataUrl(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(new Error('Falha ao ler o arquivo')); };
    reader.readAsDataURL(file);
  });
}

function buildOperationalIntelSection() {
  var snapshot = aiOperationalSnapshot;
  var summaryHtml = aiOperationalLoading
    ? '<div class="ai-result-empty">Atualizando snapshot operacional...</div>'
    : snapshot
      ? '<div class="ai-op-summary">' +
        '<div class="ai-op-hero">' +
          '<div>' +
            '<div class="ai-kicker">Inteligencia operacional</div>' +
            '<div class="ai-op-lead">' + esc(snapshot.executiveSummary || '') + '</div>' +
          '</div>' +
          '<div class="ai-op-meta">' +
            '<span><strong>Periodo:</strong> ' + esc(formatOperationalPeriod(snapshot.period)) + '</span>' +
            '<span><strong>Atualizado:</strong> ' + esc(fmtDateTime(snapshot.generatedAt)) + '</span>' +
            '<span><strong>Origem:</strong> ' + esc(snapshot.source || 'manual') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="ai-op-insights">' +
          buildOperationalInsightCard('Alertas ativos', snapshot.alerts, 'Nenhum alerta forte no periodo atual.') +
          buildOperationalInsightCard('Recomendacoes', snapshot.recommendations, 'Nenhuma recomendacao adicional no snapshot atual.') +
          buildOperationalInsightCard('Notas de carga', snapshot.loadNotes, 'Sem observacoes extras de carga no momento.') +
        '</div>' +
        '<div class="ai-op-split">' +
          '<div class="ai-op-pane"><div class="ai-op-pane-head">Especialistas por categoria</div>' + buildSpecialistsGrid(snapshot.topSpecialists || []) + '</div>' +
          '<div class="ai-op-pane"><div class="ai-op-pane-head">Redistribuicoes sugeridas</div>' + buildRedistributionGrid(snapshot.redistributionCandidates || []) + '</div>' +
        '</div>' +
        '</div>'
      : '<div class="ai-result-empty">Nenhum snapshot operacional persistido ainda.</div>';

  return '<section class="ai-op-shell">' +
    '<div class="ai-op-card">' +
      '<div class="ai-tool-head">' +
        '<div><strong>Inteligencia operacional</strong><div class="ai-tool-subhead">Snapshot executivo da operacao para consulta rapida e redistribuicao orientada por dados.</div></div>' +
        '<div class="ai-inline-actions">' +
          '<select class="ai-select" onchange="changeOperationalPeriod(this.value)">' +
            '<option value="today"' + (aiOperationalPeriod === 'today' ? ' selected' : '') + '>Hoje</option>' +
            '<option value="7d"' + (aiOperationalPeriod === '7d' ? ' selected' : '') + '>7 dias</option>' +
            '<option value="30d"' + (aiOperationalPeriod === '30d' ? ' selected' : '') + '>30 dias</option>' +
            '<option value="history"' + (aiOperationalPeriod === 'history' ? ' selected' : '') + '>Historico</option>' +
          '</select>' +
          '<button class="btn btn-primary btn-sm" onclick="refreshOperationalSnapshot()">' + (aiOperationalLoading ? 'Atualizando...' : 'Recalcular agora') + '</button>' +
        '</div>' +
      '</div>' +
      summaryHtml +
    '</div>' +
    '<div class="ai-op-grid">' +
      '<div class="ai-tool-card">' +
        '<div class="ai-tool-head"><strong>Perfis por especialidade</strong>' +
        '<span class="ai-status-note">' + (aiProfilesState.updatedAt ? 'Atualizado em ' + esc(fmtDateTime(aiProfilesState.updatedAt)) : 'Sem snapshot') + '</span></div>' +
        '<div class="ai-tool-body">' + buildProfilesPanel() + '</div>' +
      '</div>' +
      '<div class="ai-tool-card">' +
        '<div class="ai-tool-head"><strong>PDF de pendencias</strong>' +
        '<label class="btn btn-ghost btn-sm" for="aiPdfInput">' + (aiDocumentUploading ? 'Enviando...' : 'Enviar PDF') + '</label>' +
        '<input id="aiPdfInput" type="file" accept="application/pdf" style="display:none" onchange="handleAiPdfSelected(event)" />' +
        '</div>' +
        '<div class="ai-tool-body">' + buildPendingDocumentsPanel() + '</div>' +
      '</div>' +
    '</div>' +
  '</section>';
}

function buildProfilesPanel() {
  if (aiProfilesLoading) return '<div class="ai-result-empty">Carregando perfis...</div>';
  if (!aiProfilesState || !aiProfilesState.employees || !aiProfilesState.employees.length) {
    return '<div class="ai-result-empty">Perfis ainda nao calculados. Gere um snapshot para popular essa camada.</div>';
  }

  return '<div class="ai-profile-grid">' + aiProfilesState.employees.map(function (employee) {
    var topProfiles = (employee.profiles || []).slice(0, 3);
    return '<div class="ai-profile-card">' +
      '<div class="ai-mini-title">' + esc(employee.name) + '<span>' + topProfiles.length + ' destaque(s)</span></div>' +
      topProfiles.map(function (profile) {
        return '<div class="ai-profile-row">' +
          '<strong>' + esc(profile.categoryLabel) + '</strong>' +
          '<span>score ' + esc(profile.score) + ' · conf. ' + esc(profile.confidence) + '</span>' +
          '<small>' + esc(profile.doneCount) + ' concluidas · ' + esc(profile.openCount) + ' abertas</small>' +
          '</div>';
      }).join('') +
    '</div>';
  }).join('') + '</div>';
}

function buildPendingDocumentsPanel() {
  var listHtml = aiDocumentsLoading
    ? '<div class="ai-result-empty">Carregando documentos...</div>'
    : aiDocuments.length
      ? '<div class="ai-doc-list">' + aiDocuments.map(function (doc) {
        var active = aiDocumentActiveId === doc.id ? ' active' : '';
        return '<button class="ai-doc-item' + active + '" onclick="openPendingDocument(\'' + doc.id + '\')">' +
          '<strong>' + esc(doc.filename) + '</strong>' +
          '<span>' + esc(doc.status) + ' · ' + esc(fmtDateTime(doc.createdAt)) + '</span>' +
        '</button>';
      }).join('') + '</div>'
      : '<div class="ai-result-empty">Nenhum PDF importado ainda.</div>';

  var detail = aiDocumentDetail;
  var detailHtml = '<div class="ai-result-empty">Selecione um documento para ver a analise e aplicar as tarefas sugeridas.</div>';
  if (detail) {
    detailHtml =
      '<div class="ai-result-stack">' +
        '<div class="ai-doc-detail-card">' +
          '<div class="ai-mini-title">' + esc(detail.filename) + '<span>' + esc(detail.storageStatus || 'sem storage') + '</span></div>' +
          '<div class="ai-mini-meta">Criado em ' + esc(fmtDateTime(detail.createdAt)) + '</div>' +
          '<div class="ai-mini-copy">' + esc(detail.extractedPreview || '') + '</div>' +
          '<div class="ai-inline-actions">' +
            '<button class="btn btn-primary btn-sm" onclick="analyzeActivePendingDocument()">' + (aiDocumentAnalyzing ? 'Analisando...' : 'Analisar') + '</button>' +
            '<button class="btn btn-amber btn-sm" onclick="applyActivePendingAssignments()">' + (aiDocumentApplying ? 'Aplicando...' : 'Aplicar designacoes') + '</button>' +
          '</div>' +
        '</div>' +
        (detail.analysis ? '<div class="ai-doc-detail-card"><div class="ai-mini-title">Resumo do documento</div><div class="ai-mini-copy">' + esc(detail.analysis.summary || '') + '</div>' + buildMiniList('Checklist', detail.analysis.checklist) + buildMiniList('Alertas', detail.analysis.alerts) + '</div>' : '') +
        ((detail.suggestions || []).length ? '<div class="ai-result-grid">' + detail.suggestions.map(function (item) {
          return '<div class="ai-doc-suggestion-card">' +
            '<div class="ai-mini-title">' + esc(item.title) + '<span>' + esc(item.assignedToName || '') + '</span></div>' +
            '<div class="ai-mini-copy">' + esc(item.description || '') + '</div>' +
            '<div class="ai-mini-meta">' + esc(item.reason || '') + '</div>' +
          '</div>';
        }).join('') + '</div>' : '') +
      '</div>';
  }

  return '<div class="ai-doc-shell">' +
    '<div>' + listHtml + '</div>' +
    '<div>' + detailHtml + '</div>' +
  '</div>';
}

function buildOperationalInsightCard(title, items, emptyText) {
  var list = Array.isArray(items) ? items.filter(Boolean) : [];
  return '<div class="ai-op-insight-card">' +
    '<div class="ai-op-pane-head">' + esc(title) + '</div>' +
    (list.length
      ? '<div class="ai-op-bullet-list">' + list.map(function (item) {
        return '<div class="ai-op-bullet-item">' + esc(item) + '</div>';
      }).join('') + '</div>'
      : '<div class="ai-result-empty">' + esc(emptyText) + '</div>') +
    '</div>';
}

function buildSpecialistsGrid(items) {
  if (!items.length) return '<div class="ai-result-empty">Ainda nao ha especialistas ranqueados neste periodo.</div>';
  return '<div class="ai-result-grid">' + items.slice(0, 4).map(function (item) {
    return '<div class="ai-mini-card">' +
      '<div class="ai-mini-title">' + esc(item.categoryLabel) + '</div>' +
      (item.leaders || []).map(function (leader) {
        return '<div class="ai-profile-row"><strong>' + esc(leader.name) + '</strong><span>score ' + esc(leader.score) + ' · conf. ' + esc(leader.confidence) + '</span></div>';
      }).join('') +
    '</div>';
  }).join('') + '</div>';
}

function buildRedistributionGrid(items) {
  if (!items.length) return '<div class="ai-result-empty">Nenhuma redistribuicao sugerida no snapshot atual.</div>';
  return '<div class="ai-result-grid">' + items.slice(0, 4).map(function (item) {
    return '<div class="ai-mini-card">' +
      '<div class="ai-mini-title">' + esc(item.title) + '<span>' + esc(item.currentAssignee || '') + '</span></div>' +
      '<div class="ai-mini-meta">Sugestao: ' + esc(item.suggestedAssignee || '') + '</div>' +
      '<div class="ai-mini-copy">' + esc(item.reason || '') + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function formatOperationalPeriod(value) {
  return {
    today: 'Hoje',
    '7d': '7 dias',
    '30d': '30 dias',
    history: 'Historico'
  }[value] || value || '';
}

async function buildDashboard() {
  await loadManagerUsers();

  var total = tasks.length;
  var doing = tasks.filter(function (task) { return task.status === 'doing'; }).length;
  var done = tasks.filter(function (task) { return task.status === 'done'; }).length;
  var todo = tasks.filter(function (task) { return task.status === 'todo'; }).length;
  var totalMs = tasks.reduce(function (sum, task) {
    return sum + (task.elapsed || 0) + (task.timerStart ? Date.now() - task.timerStart : 0);
  }, 0);

  var byEmp = {};
  tasks.forEach(function (task) {
    if (!byEmp[task.empId]) byEmp[task.empId] = { empId: task.empId, name: task.empName, color: task.color, tasks: [] };
    byEmp[task.empId].tasks.push(task);
  });

  var topEmp = '—';
  var topDone = 0;
  Object.keys(byEmp).forEach(function (key) {
    var doneCount = byEmp[key].tasks.filter(function (task) { return task.status === 'done'; }).length;
    if (doneCount > topDone) {
      topDone = doneCount;
      topEmp = byEmp[key].name.split(' ')[0];
    }
  });

  var kpis = '<div class="kpi-row">' +
    '<div class="kpi-card kc-blue"><div class="kpi-label">Em Andamento</div><div class="kpi-value">' + doing + '</div><div class="kpi-sub">' + todo + ' aguardando</div></div>' +
    '<div class="kpi-card kc-green"><div class="kpi-label">Concluidas</div><div class="kpi-value">' + done + '</div><div class="kpi-sub">de ' + total + ' total</div></div>' +
    '<div class="kpi-card kc-amber"><div class="kpi-label">Tempo Total</div><div class="kpi-value" style="font-size:20px">' + fmtMs(totalMs) + '</div><div class="kpi-sub">acumulado</div></div>' +
    '<div class="kpi-card kc-purple"><div class="kpi-label">Mais Produtivo</div><div class="kpi-value" style="font-size:18px">' + esc(topEmp) + '</div><div class="kpi-sub">' + topDone + ' concluida' + (topDone !== 1 ? 's' : '') + '</div></div>' +
    '</div>';

  var employeeRows = employees.map(function (emp) {
    var empTasks = byEmp[emp.id] ? byEmp[emp.id].tasks : [];
    var doneCount = empTasks.filter(function (task) { return task.status === 'done'; }).length;
    var doingCount = empTasks.filter(function (task) { return task.status === 'doing'; }).length;
    var pct = empTasks.length ? Math.round(doneCount / empTasks.length * 100) : 0;
    return '<div class="et-row">' +
      '<div class="et-emp"><div class="et-av" style="background:' + emp.color + '">' + ini(emp.name) + '</div><span class="et-nm">' + esc(emp.name) + '</span></div>' +
      '<div class="et-val">' + empTasks.length + '</div>' +
      '<div class="et-val et-doing">' + doingCount + '</div>' +
      '<div class="et-val et-done">' + doneCount + '</div>' +
      '<div style="display:flex;align-items:center;gap:7px"><div class="prog-bar"><div class="prog-fill" style="width:' + pct + '%"></div></div><span class="et-val">' + pct + '%</span></div>' +
      '</div>';
  }).join('');

  var repCards = employees.map(function (emp) {
    var empTasks = byEmp[emp.id] ? byEmp[emp.id].tasks : [];
    var ms = empTasks.reduce(function (sum, task) {
      return sum + (task.elapsed || 0) + (task.timerStart ? Date.now() - task.timerStart : 0);
    }, 0);
    var doneCount = empTasks.filter(function (task) { return task.status === 'done'; }).length;
    var rows = empTasks.map(function (task) {
      var taskMs = (task.elapsed || 0) + (task.timerStart ? Date.now() - task.timerStart : 0);
      var cls = { todo: 'stag-todo', doing: 'stag-doing', done: 'stag-done' }[task.status];
      var label = { todo: 'A Fazer', doing: 'Andamento', done: 'Concluido' }[task.status];
      var flags = '';
      if (task.status === 'done') {
        if (task.needsRevisao) flags += tagBadge('Revisao', '#fff8e1', '#b8860b', '#f5c300');
        if (task.needsProtocolo) flags += tagBadge('Protocolo', '#e8f8ef', '#27ae60', '#a8d5b5');
        if (task.flagAgendei) flags += tagBadge('Agendado', '#e8f0fc', '#2d7be5', '#b0c8f0');
        if (task.flagDispensa) flags += tagBadge('Dispensa', '#f3eafc', '#8e44ad', '#d5b8e8');
        if (task.flagProtreal) flags += tagBadge('Prot.Real', '#e8f8ef', '#27ae60', '#a8d5b5');
        if (task.flagNaoAplic) flags += tagBadge('N/A', '#f1f5f9', '#64748b', '#e2e8f0');
        if (!flags) flags = '<span style="font-size:9px;color:#9aa5b4;margin-left:2px;font-style:italic">nenhuma marcacao</span>';
      }
      return '<div class="rep-row"><span class="stag ' + cls + '">' + label + '</span><span class="rep-tname">' + esc(task.title) + '</span><span class="rep-time">' + fmtMs(taskMs) + '</span>' + (flags ? '<div style="width:100%;padding-left:56px;margin-top:2px;display:flex;flex-wrap:wrap;gap:2px">' + flags + '</div>' : '') + '</div>';
    }).join('');
    return '<div class="rep-card"><div class="rep-head"><div class="rep-av" style="background:' + emp.color + '">' + ini(emp.name) + '</div><div><div class="rep-nm">' + esc(emp.name) + '</div><div class="rep-mt">' + empTasks.length + ' tarefa' + (empTasks.length !== 1 ? 's' : '') + ' · ' + doneCount + ' concluida' + (doneCount !== 1 ? 's' : '') + ' · ' + fmtMs(ms) + '</div></div></div><div class="rep-tasks">' + (rows || '<div style="padding:8px;font-size:11px;color:var(--text-light)">Sem tarefas</div>') + '</div></div>';
  }).join('');

  var historyHtml = await buildHistoryPanel();
  var usersHtml = buildUsersSection();
  var aiHtml = buildAiSection();
  var dateStr = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  var pwSection = '<div class="pw-section"><div class="pw-row">' +
    '<div class="pw-field"><label>Nova senha</label><input id="pwNew" type="password" placeholder="Minimo 6 caracteres" /></div>' +
    '<div class="pw-field"><label>Confirmar</label><input id="pwConf" type="password" placeholder="Repita a senha" /></div>' +
    '<button class="btn btn-purple btn-sm" onclick="changePw()">Salvar</button>' +
    '</div></div>';

  return '<div class="mgr-dashboard">' +
    '<div class="mgr-topbar">' +
    '<div class="mgr-title-wrap"><div class="mgr-icon">👑</div><div><div class="mgr-heading">Painel do <em>Gestor</em></div><div class="mgr-subheading">' + dateStr + '</div></div></div>' +
    '<div class="mgr-acts">' +
    '<button class="btn btn-primary btn-sm" onclick="openUserModal()">+ Novo usuario</button>' +
    '<button class="btn btn-amber btn-sm" onclick="closeDay()">Fechar o Dia</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="exportReport()">Exportar</button>' +
    '<button class="btn btn-danger btn-sm" onclick="lockMgr()">Encerrar Sessao</button>' +
    '</div>' +
    '</div>' +
    '<div class="session-bar">Sessao ativa — acesso completo ao painel de gestao.</div>' +
    kpis +
    '<div class="section-title">Equipe e Acessos</div>' +
    usersHtml +
    '<div class="section-title">Assistente IA do Gestor</div>' +
    aiHtml +
    '<div class="section-title">Visao Geral da Equipe</div>' +
    '<div class="emp-table"><div class="et-head"><span>Funcionario</span><span>Total</span><span>Ativo</span><span>Concluido</span><span>Progresso</span></div>' + (employeeRows || '<div style="padding:16px;text-align:center;color:var(--text-light);font-size:12px">Nenhuma tarefa.</div>') + '</div>' +
    '<div class="section-title">Relatorio por Funcionario</div>' +
    '<div class="rep-grid" style="margin-bottom:24px">' + (repCards || '<div style="font-size:12px;color:var(--text-light);padding:16px">Nenhuma tarefa ainda.</div>') + '</div>' +
    '<div class="section-title">Historico de Dias</div>' +
    historyHtml +
    '<div class="section-title">Seguranca</div>' +
    pwSection +
    '</div>';
}

async function buildDashboardV2() {
  await loadManagerUsers();
  await ensureOperationalAiData(false);

  var total = tasks.length;
  var doing = tasks.filter(function (task) { return task.status === 'doing'; }).length;
  var done = tasks.filter(function (task) { return task.status === 'done'; }).length;
  var todo = tasks.filter(function (task) { return task.status === 'todo'; }).length;
  var totalMs = tasks.reduce(function (sum, task) {
    return sum + (task.elapsed || 0) + (task.timerStart ? Date.now() - task.timerStart : 0);
  }, 0);

  var byEmp = {};
  tasks.forEach(function (task) {
    if (!byEmp[task.empId]) byEmp[task.empId] = { empId: task.empId, name: task.empName, color: task.color, tasks: [] };
    byEmp[task.empId].tasks.push(task);
  });

  var topEmp = '—';
  var topDone = 0;
  Object.keys(byEmp).forEach(function (key) {
    var doneCount = byEmp[key].tasks.filter(function (task) { return task.status === 'done'; }).length;
    if (doneCount > topDone) {
      topDone = doneCount;
      topEmp = byEmp[key].name.split(' ')[0];
    }
  });

  var aiHtml = buildAiSectionV2();
  var operationalHtml = buildOperationalIntelSection();
  var usersHtml = buildUsersSection();
  var historyHtml = await buildHistoryPanel();
  var dateStr = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  var kpis = '<div class="kpi-row">' +
    '<div class="kpi-card kc-blue"><div class="kpi-label">Em andamento</div><div class="kpi-value">' + doing + '</div><div class="kpi-sub">' + todo + ' aguardando</div></div>' +
    '<div class="kpi-card kc-green"><div class="kpi-label">Concluídas</div><div class="kpi-value">' + done + '</div><div class="kpi-sub">de ' + total + ' no total</div></div>' +
    '<div class="kpi-card kc-amber"><div class="kpi-label">Tempo total</div><div class="kpi-value" style="font-size:20px">' + fmtMs(totalMs) + '</div><div class="kpi-sub">acumulado no board atual</div></div>' +
    '<div class="kpi-card kc-purple"><div class="kpi-label">Mais produtivo</div><div class="kpi-value" style="font-size:18px">' + esc(topEmp) + '</div><div class="kpi-sub">' + topDone + ' concluída' + (topDone !== 1 ? 's' : '') + '</div></div>' +
    '</div>';

  var employeeRows = employees.map(function (emp) {
    var empTasks = byEmp[emp.id] ? byEmp[emp.id].tasks : [];
    var doneCount = empTasks.filter(function (task) { return task.status === 'done'; }).length;
    var doingCount = empTasks.filter(function (task) { return task.status === 'doing'; }).length;
    var pct = empTasks.length ? Math.round(doneCount / empTasks.length * 100) : 0;
    return '<div class="et-row">' +
      '<div class="et-emp"><div class="et-av" style="background:' + emp.color + '">' + ini(emp.name) + '</div><span class="et-nm">' + esc(emp.name) + '</span></div>' +
      '<div class="et-val">' + empTasks.length + '</div>' +
      '<div class="et-val et-doing">' + doingCount + '</div>' +
      '<div class="et-val et-done">' + doneCount + '</div>' +
      '<div style="display:flex;align-items:center;gap:7px"><div class="prog-bar"><div class="prog-fill" style="width:' + pct + '%"></div></div><span class="et-val">' + pct + '%</span></div>' +
      '</div>';
  }).join('');

  var repCards = employees.map(function (emp) {
    var empTasks = byEmp[emp.id] ? byEmp[emp.id].tasks : [];
    var ms = empTasks.reduce(function (sum, task) {
      return sum + (task.elapsed || 0) + (task.timerStart ? Date.now() - task.timerStart : 0);
    }, 0);
    var doneCount = empTasks.filter(function (task) { return task.status === 'done'; }).length;
    var rows = empTasks.map(function (task) {
      var taskMs = (task.elapsed || 0) + (task.timerStart ? Date.now() - task.timerStart : 0);
      var cls = { todo: 'stag-todo', doing: 'stag-doing', done: 'stag-done' }[task.status];
      var label = { todo: 'A Fazer', doing: 'Andamento', done: 'Concluído' }[task.status];
      var flags = '';
      if (task.status === 'done') {
        if (task.needsRevisao) flags += tagBadge('Revisão', '#fff8e1', '#b8860b', '#f5c300');
        if (task.needsProtocolo) flags += tagBadge('Protocolo', '#e8f8ef', '#27ae60', '#a8d5b5');
        if (task.flagAgendei) flags += tagBadge('Agendado', '#e8f0fc', '#2d7be5', '#b0c8f0');
        if (task.flagDispensa) flags += tagBadge('Dispensa', '#f3eafc', '#8e44ad', '#d5b8e8');
        if (task.flagProtreal) flags += tagBadge('Prot.Real', '#e8f8ef', '#27ae60', '#a8d5b5');
        if (task.flagNaoAplic) flags += tagBadge('N/A', '#f1f5f9', '#64748b', '#e2e8f0');
        if (!flags) flags = '<span style="font-size:9px;color:#9aa5b4;margin-left:2px;font-style:italic">nenhuma marcação</span>';
      }
      return '<div class="rep-row"><span class="stag ' + cls + '">' + label + '</span><span class="rep-tname">' + esc(task.title) + '</span><span class="rep-time">' + fmtMs(taskMs) + '</span>' + (flags ? '<div style="width:100%;padding-left:56px;margin-top:2px;display:flex;flex-wrap:wrap;gap:2px">' + flags + '</div>' : '') + '</div>';
    }).join('');
    return '<div class="rep-card"><div class="rep-head"><div class="rep-av" style="background:' + emp.color + '">' + ini(emp.name) + '</div><div><div class="rep-nm">' + esc(emp.name) + '</div><div class="rep-mt">' + empTasks.length + ' tarefa' + (empTasks.length !== 1 ? 's' : '') + ' · ' + doneCount + ' concluída' + (doneCount !== 1 ? 's' : '') + ' · ' + fmtMs(ms) + '</div></div></div><div class="rep-tasks">' + (rows || '<div style="padding:8px;font-size:11px;color:var(--text-light)">Sem tarefas</div>') + '</div></div>';
  }).join('');

  var pwSection = '<div class="pw-section"><div class="pw-row">' +
    '<div class="pw-field"><label>Nova senha</label><input id="pwNew" type="password" placeholder="Mínimo 6 caracteres" /></div>' +
    '<div class="pw-field"><label>Confirmar</label><input id="pwConf" type="password" placeholder="Repita a senha" /></div>' +
    '<button class="btn btn-purple btn-sm" onclick="changePw()">Salvar</button>' +
    '</div></div>';

  return '<div class="mgr-dashboard">' +
    '<div class="mgr-hero">' +
      '<div class="mgr-hero-copy">' +
        '<div class="mgr-chip">Operação do gestor</div>' +
        '<div class="mgr-heading">Painel executivo com assistência operacional e visão completa da equipe.</div>' +
        '<div class="mgr-subheading">' + dateStr + '</div>' +
      '</div>' +
      '<div class="mgr-acts">' +
        '<button class="btn btn-primary btn-sm" onclick="openUserModal()">+ Novo usuário</button>' +
        '<button class="btn btn-amber btn-sm" onclick="closeDay()">Fechar o dia</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="exportReport()">Exportar relatório</button>' +
      '</div>' +
    '</div>' +
    '<div class="session-bar">Sessão autenticada pelo login principal. O painel do gestor abre direto, sem segunda senha artificial.</div>' +
    aiHtml +
    operationalHtml +
    kpis +
    '<div class="section-title">Equipe e acessos</div>' +
    usersHtml +
    '<div class="section-title">Visão geral da equipe</div>' +
    '<div class="emp-table"><div class="et-head"><span>Funcionário</span><span>Total</span><span>Ativo</span><span>Concluído</span><span>Progresso</span></div>' + (employeeRows || '<div style="padding:16px;text-align:center;color:var(--text-light);font-size:12px">Nenhuma tarefa.</div>') + '</div>' +
    '<div class="section-title">Relatório por funcionário</div>' +
    '<div class="rep-grid" style="margin-bottom:24px">' + (repCards || '<div style="font-size:12px;color:var(--text-light);padding:16px">Nenhuma tarefa ainda.</div>') + '</div>' +
    '<div class="section-title">Histórico de dias</div>' +
    historyHtml +
    '<div class="section-title">Segurança</div>' +
    pwSection +
    '</div>';
}

async function changePw() {
  var nw = document.getElementById('pwNew') ? document.getElementById('pwNew').value : '';
  var cf = document.getElementById('pwConf') ? document.getElementById('pwConf').value : '';
  if (nw.length < 6) return showToast('Minimo 6 caracteres');
  if (nw !== cf) return showToast('Senhas nao coincidem');

  try {
    await api('POST', '/auth/change-password', {
      currentPassword: prompt('Digite sua senha atual:') || '',
      newPassword: nw
    });
    document.getElementById('pwNew').value = '';
    document.getElementById('pwConf').value = '';
    showToast('Senha alterada com sucesso');
  } catch (error) {
    showToast(error.message);
  }
}

async function buildHistoryPanel() {
  try {
    var params = '';
    if (histFilterDate) params += '?date=' + histFilterDate;
    if (histFilterEmp) params += (params ? '&' : '?') + 'empId=' + histFilterEmp;
    historyData = await api('GET', '/history' + params);
  } catch (error) {
    return '<div class="empty-hist">Erro ao carregar historico.</div>';
  }

  var empOptions = employees.map(function (emp) {
    return '<option value="' + emp.id + '"' + (String(histFilterEmp) === String(emp.id) ? ' selected' : '') + '>' + esc(emp.name) + '</option>';
  }).join('');

  var filters = '<div class="hist-filters">' +
    '<div class="hist-filter-group"><span>Funcionario:</span><select onchange="histFilterEmp=this.value;renderMgr()"><option value="">Todos</option>' + empOptions + '</select></div>' +
    '<div class="hist-filter-group"><span>Data:</span><input type="date" value="' + histFilterDate + '" onchange="histFilterDate=this.value;renderMgr()" /></div>' +
    ((histFilterDate || histFilterEmp) ? '<button class="btn btn-ghost btn-sm" onclick="histFilterEmp=\'\';histFilterDate=\'\';renderMgr()">Limpar</button>' : '') +
    '<span style="margin-left:auto;font-size:11px;color:var(--text-light)">' + historyData.length + ' dia(s)</span>' +
    '</div>';

  if (!historyData.length) {
    return filters + '<div class="empty-hist">Nenhum historico encontrado.<br><span style="font-size:11px">Use "Fechar o Dia" ao final do expediente.</span></div>';
  }

  var days = historyData.map(function (snap) {
    var totalTasks = 0;
    var totalDone = 0;
    var totalMs = 0;
    var empBlocks = (snap.employees || []).map(function (ed) {
      var emp = employees.filter(function (item) { return item.id == ed.empId; })[0];
      var color = emp ? emp.color : '#888';
      var ms = (ed.tasks || []).reduce(function (sum, task) { return sum + (task.elapsed || 0); }, 0);
      var doneCount = (ed.tasks || []).filter(function (task) { return task.status === 'done'; }).length;
      totalTasks += (ed.tasks || []).length;
      totalDone += doneCount;
      totalMs += ms;
      var rows = (ed.tasks || []).map(function (task) {
        var cls = { todo: 'stag-todo', doing: 'stag-doing', done: 'stag-done' }[task.status] || 'stag-todo';
        var label = { todo: 'A Fazer', doing: 'Em Andamento', done: 'Concluido' }[task.status] || task.status;
        var flags = [];
        if (task.needsRevisao) flags.push(tagBadge('Revisao', '#fff8e1', '#b8860b', '#f5c300'));
        if (task.needsProtocolo) flags.push(tagBadge('Protocolo', '#e8f8ef', '#27ae60', '#a8d5b5'));
        if (task.flagAgendei) flags.push(tagBadge('Agendado', '#e8f0fc', '#2d7be5', '#b0c8f0'));
        if (task.flagDispensa) flags.push(tagBadge('Dispensa', '#f3eafc', '#8e44ad', '#d5b8e8'));
        if (task.flagProtreal) flags.push(tagBadge('Prot.Real', '#e8f8ef', '#27ae60', '#a8d5b5'));
        if (task.flagNaoAplic) flags.push(tagBadge('N/A', '#f1f5f9', '#64748b', '#e2e8f0'));
        if (task.status === 'done' && !flags.length) flags.push('<span style="font-size:9px;color:#9aa5b4;font-style:italic">nenhuma marcacao</span>');
        return '<div class="hist-task-row"><span class="stag ' + cls + '">' + label + '</span><span class="hist-task-title">' + esc(task.title) + (task.assignedBy ? ' <span style="color:var(--text-light);font-size:10px">👤 ' + esc(task.assignedBy) + '</span>' : '') + '</span><span class="hist-task-time">' + fmtMs(task.elapsed || 0) + (task.completedAt ? ' · ' + task.completedAt : '') + '</span>' + (flags.length ? '<div style="width:100%;display:flex;flex-wrap:wrap;gap:3px;margin-top:3px">' + flags.join('') + '</div>' : '') + '</div>';
      }).join('');
      return '<div class="hist-emp-block"><div class="hist-emp-name"><div style="width:22px;height:22px;border-radius:50%;background:' + color + ';display:grid;place-items:center;font-size:9px;font-weight:700;color:#fff">' + ini(ed.empName) + '</div>' + esc(ed.empName) + '<span style="margin-left:auto;font-size:11px;color:var(--text-muted)">' + (ed.tasks || []).length + ' tarefa' + ((ed.tasks || []).length !== 1 ? 's' : '') + ' · ' + fmtMs(ms) + '</span></div>' + rows + '</div>';
    }).join('');
    var parts = snap.date.split('-');
    var dateObj = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    var dateLabel = dateObj.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    return '<div class="hist-day"><div class="hist-day-head"><div><div class="hist-day-title">' + dateLabel + '</div><div class="hist-day-meta">' + totalTasks + ' tarefa' + (totalTasks !== 1 ? 's' : '') + ' · ' + totalDone + ' concluida' + (totalDone !== 1 ? 's' : '') + ' · ' + fmtMs(totalMs) + (snap.closedAt ? ' · Fechado as ' + snap.closedAt : '') + '</div></div></div><div class="hist-day-body">' + empBlocks + '</div></div>';
  }).join('');

  return filters + days;
}

async function closeDay() {
  if (!confirm('Fechar o dia? Isso salvara o snapshot no historico e arquivara as tarefas concluidas.')) return;
  try {
    await api('POST', '/history/close-day');
    await refreshWorkspace(true);
    rerenderOperationalViews();
    showToast('Dia encerrado e salvo no historico!');
  } catch (error) {
    showToast(error.message);
  }
}

function exportReport() {
  var now = new Date();
  var txt = 'JVB KANBAN - RELATORIO DE PRODUTIVIDADE\n' + rep('=', 46) + '\n';
  txt += now.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + '\n' + rep('=', 46) + '\n\n';
  var byEmp = {};
  tasks.forEach(function (task) {
    if (!byEmp[task.empId]) byEmp[task.empId] = { name: task.empName, tasks: [] };
    byEmp[task.empId].tasks.push(task);
  });
  if (!Object.keys(byEmp).length) {
    txt += 'Nenhuma tarefa.\n';
  } else {
    employees.forEach(function (emp) {
      var data = byEmp[emp.id];
      if (!data) return;
      var totalMs = data.tasks.reduce(function (sum, task) {
        return sum + (task.elapsed || 0) + (task.timerStart ? Date.now() - task.timerStart : 0);
      }, 0);
      txt += emp.name.toUpperCase() + '\n' + rep('-', 36) + '\n';
      txt += '  Tarefas    : ' + data.tasks.length + '\n  Concluidas : ' + data.tasks.filter(function (task) { return task.status === 'done'; }).length + '\n  Tempo total: ' + fmtMs(totalMs) + '\n\n';
      data.tasks.forEach(function (task) {
        var ms = (task.elapsed || 0) + (task.timerStart ? Date.now() - task.timerStart : 0);
        var statusLabel = { todo: 'A Fazer', doing: 'Em Andamento', done: 'Concluido' }[task.status];
        txt += '  * ' + task.title + '\n    Status: ' + statusLabel + '\n    Tempo : ' + fmtMs(ms) + '\n';
        if (task.desc) txt += '    Desc  : ' + task.desc + '\n';
        if (task.assignedBy) txt += '    Req.  : ' + task.assignedBy + '\n';
        if (task.status === 'done') {
          var flags = [];
          if (task.needsRevisao) flags.push('Revisao');
          if (task.needsProtocolo) flags.push('Protocolo');
          if (task.flagAgendei) flags.push('Agendou');
          if (task.flagDispensa) flags.push('Dispensa');
          if (task.flagProtreal) flags.push('Prot.Realizado');
          if (task.flagNaoAplic) flags.push('N/A');
          txt += '    Marcacoes: ' + (flags.length ? flags.join(', ') : 'Nenhuma') + '\n';
        }
        if (task.completedAt) txt += '    Fim   : ' + task.completedAt + '\n';
        txt += '\n';
      });
    });
  }
  txt += rep('=', 46) + '\nGerado: ' + now.toLocaleString('pt-BR') + '\n';
  document.getElementById('codeBox').textContent = txt;
  document.getElementById('expModal').classList.add('open');
}

function copyExport() {
  navigator.clipboard.writeText(document.getElementById('codeBox').textContent).then(function () {
    showToast('Copiado!');
  });
}

function openUserModal(userId) {
  editingUserId = userId || null;
  var modal = document.getElementById('userModal');
  var title = document.getElementById('userModalTitle');
  var passwordField = document.getElementById('uPasswordField');
  var submit = document.getElementById('userSubmitLabel');

  if (editingUserId) {
    var user = findManagerUser(editingUserId);
    if (!user) return;
    title.textContent = 'Editar Usuario';
    submit.textContent = 'Salvar Alteracoes';
    passwordField.style.display = 'none';
    document.getElementById('uName').value = user.name || '';
    document.getElementById('uUsername').value = user.username || '';
    document.getElementById('uRole').value = user.role || 'employee';
    document.getElementById('uPassword').value = '';
  } else {
    title.textContent = 'Novo Usuario';
    submit.textContent = 'Criar Usuario';
    passwordField.style.display = 'block';
    document.getElementById('uName').value = '';
    document.getElementById('uUsername').value = '';
    document.getElementById('uRole').value = 'employee';
    document.getElementById('uPassword').value = '';
  }

  modal.classList.add('open');
  setTimeout(function () { document.getElementById('uName').focus(); }, 60);
}

async function saveUser() {
  var payload = {
    name: document.getElementById('uName').value.trim(),
    username: document.getElementById('uUsername').value.trim().toLowerCase(),
    role: document.getElementById('uRole').value
  };
  if (!payload.name || !payload.username || !payload.role) {
    return showToast('Preencha nome, usuario e perfil');
  }

  try {
    if (editingUserId) {
      await api('PUT', '/manager/users/' + editingUserId, payload);
    } else {
      payload.password = document.getElementById('uPassword').value;
      if (!payload.password || payload.password.length < 6) {
        return showToast('Defina uma senha inicial com no minimo 6 caracteres');
      }
      await api('POST', '/manager/users', payload);
    }

    await refreshSessionUser();
    await refreshWorkspace(true);
    updateSidebarUser();
    renderTeam();
    renderMgr();
    overlayClose('userModal');
    showToast(editingUserId ? 'Usuario atualizado' : 'Usuario criado');
  } catch (error) {
    showToast(error.message);
  }
}

function openResetUserPassword(userId) {
  resetUserId = userId;
  var user = findManagerUser(userId);
  if (!user) return;
  document.getElementById('resetUserLabel').textContent = user.name + ' (@' + user.username + ')';
  document.getElementById('rpwNew').value = '';
  document.getElementById('rpwConf').value = '';
  document.getElementById('userPwModal').classList.add('open');
  setTimeout(function () { document.getElementById('rpwNew').focus(); }, 60);
}

async function saveResetUserPassword() {
  var newPassword = document.getElementById('rpwNew').value;
  var confirmPassword = document.getElementById('rpwConf').value;
  if (newPassword.length < 6) return showToast('Minimo 6 caracteres');
  if (newPassword !== confirmPassword) return showToast('Senhas nao coincidem');

  try {
    await api('PUT', '/manager/users/' + resetUserId + '/password', { newPassword: newPassword });
    overlayClose('userPwModal');
    showToast('Senha redefinida com sucesso');
  } catch (error) {
    showToast(error.message);
  }
}

async function toggleUserStatus(userId, isActive) {
  var user = findManagerUser(userId);
  if (!user) return;
  var action = isActive ? 'ativar' : 'desativar';
  if (!confirm('Deseja ' + action + ' o usuario ' + user.name + '?')) return;

  try {
    await api('PATCH', '/manager/users/' + userId + '/status', { isActive: isActive });
    await refreshSessionUser();
    await refreshWorkspace(true);
    updateSidebarUser();
    renderTeam();
    renderMgr();
    showToast('Usuario ' + (isActive ? 'ativado' : 'desativado'));
  } catch (error) {
    showToast(error.message);
  }
}

var _lastAutoClose = '';
function startAutoClose() {
  _lastAutoClose = localStorage.getItem('jvb_last_autoclose') || '';
  checkAutoClose();
  setInterval(checkAutoClose, 60000);
}

function checkAutoClose() {
  var now = new Date();
  var offset = -3 * 60;
  var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  var brt = new Date(utcMs + offset * 60000);
  var todayKey = brt.getFullYear() + '-' + pad(brt.getMonth() + 1) + '-' + pad(brt.getDate());
  if (brt.getHours() >= 21 && _lastAutoClose !== todayKey && currentUser && currentUser.role === 'manager') {
    _lastAutoClose = todayKey;
    localStorage.setItem('jvb_last_autoclose', todayKey);
    api('POST', '/history/close-day').then(function () {
      return refreshWorkspace(true);
    }).then(function () {
      rerenderOperationalViews();
      showToast('Dia encerrado automaticamente (21h)');
    }).catch(function () {});
  }
}

function isManagerInteractionActive() {
  var active = document.activeElement;
  if (!active) return false;
  if (document.querySelector('.overlay.open')) return true;
  var tag = active.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  var mgrPanel = document.getElementById('mgrPanel');
  return !!(mgrPanel && mgrPanel.contains(active));
}

document.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && document.getElementById('loginUser') === document.activeElement) doLogin();
  if (event.key === 'Enter' && document.getElementById('loginPass') === document.activeElement) doLogin();
  if (event.key === 'Enter' && document.getElementById('addModal').classList.contains('open')) addTask();
  if (event.key === 'Escape') {
    document.querySelectorAll('.overlay.open').forEach(function (overlay) {
      overlay.classList.remove('open');
    });
  }
});

setInterval(function () { if (currentTab === 'all') renderAll(); }, 15000);
setInterval(function () { if (currentTab === 'tasks') renderTasksView(); }, 15000);
setInterval(function () {
  if (currentTab === 'mgr' && !aiChatPending && !aiActionPending && !isManagerInteractionActive()) renderMgr();
}, 10000);
setInterval(cycleAiChatPlaceholder, 3200);
setInterval(updateDate, 60000);
