'use strict';

var currentUser = null;
var tasks = [];
var employees = [];
var managerUsers = [];
var activeId = null;
var timers = {};
var dragId = null;
var currentTab = 'team';
var mgrUnlocked = false;
var histFilterEmp = '';
var histFilterDate = '';
var historyData = [];
var editingId = null;
var pendingDoneId = null;
var token = localStorage.getItem('jvb_token') || null;
var modalEmpId = null;
var editingUserId = null;
var resetUserId = null;

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

  if (currentUser && currentUser.role === 'manager' && activeId && !findEmp(activeId)) {
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

function pad(value) {
  return String(value).padStart(2, '0');
}

function rep(ch, times) {
  var out = '';
  for (var i = 0; i < times; i += 1) out += ch;
  return out;
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
  document.getElementById('view-team').style.display = tab === 'team' ? 'block' : 'none';
  document.getElementById('view-mgr').style.display = tab === 'mgr' ? 'block' : 'none';
  document.getElementById('tab-all').classList.toggle('active', tab === 'all');
  document.getElementById('tab-team').classList.toggle('active', tab === 'team');
  document.getElementById('tab-mgr').classList.toggle('active', tab === 'mgr');
  renderSidebar();
  if (tab === 'all') renderAll();
  if (tab === 'mgr') renderMgr();
}

function selectEmp(empId) {
  if (currentUser && currentUser.role === 'employee' && empId !== currentUser.id) return;
  activeId = empId;
  renderTeam();
}

function openAdd(col) {
  var empId = activeId;
  var emp = findEmp(empId);
  var empName = emp ? emp.name : '';
  if (currentUser && currentUser.role === 'employee') {
    empId = currentUser.id;
    empName = currentUser.name;
  }
  if (!empName) {
    showToast('Selecione um funcionario');
    return;
  }

  modalEmpId = empId;
  document.getElementById('iTitle').value = '';
  document.getElementById('iDesc').value = '';
  document.getElementById('iAssignedBy').value = '';
  document.getElementById('iEmp').value = empName;
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

  if (!title) return showToast('Digite o titulo');
  if (!desc) return showToast('Digite a descricao');
  if (!assignedBy) return showToast('Selecione quem designou');

  try {
    var task = await api('POST', '/tasks', {
      title: title,
      description: desc,
      assignedBy: assignedBy,
      status: status,
      userId: modalEmpId
    });
    tasks.unshift(task);
    if (task.status === 'doing') startTimer(task.id);
    renderTeam();
    if (currentTab === 'all') renderAll();
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
    renderTeam();
    if (currentTab === 'all') renderAll();
    if (currentTab === 'mgr' && mgrUnlocked) renderMgr();
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
    renderTeam();
    if (currentTab === 'all') renderAll();
    if (currentTab === 'mgr' && mgrUnlocked) renderMgr();
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
      assignedBy: document.getElementById('eAssignedVal').value
    });
    var index = tasks.findIndex(function (task) { return task.id === editingId; });
    if (index !== -1) tasks[index] = updated;
    renderTeam();
    if (currentTab === 'all') renderAll();
    if (currentTab === 'mgr' && mgrUnlocked) renderMgr();
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

  var visibleEmployees = currentUser && currentUser.role === 'employee'
    ? employees.filter(function (emp) { return emp.id === currentUser.id; })
    : employees;

  visibleEmployees.forEach(function (emp) {
    var empTasks = tasks.filter(function (task) { return task.empId === emp.id; });
    var doing = empTasks.filter(function (task) { return task.status === 'doing'; }).length;
    var isActive = emp.id === activeId;
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

  if (currentUser && currentUser.role === 'employee') {
    emp = currentUser;
    empId = currentUser.id;
  }

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
  return '<div class="' + cls + '" draggable="true" data-id="' + task.id + '" data-status="' + task.status + '" ondragstart="dStart(event,\'' + task.id + '\')" ondragend="dEnd(event)">' +
    '<div class="card-title">' + esc(task.title) + '</div>' +
    (task.desc ? '<div class="card-desc">' + esc(task.desc.length > 80 ? task.desc.slice(0, 80) + '...' : task.desc) + '</div>' : '') +
    (task.assignedBy ? '<div class="card-assigned">👤 ' + esc(task.assignedBy) + '</div>' : '') +
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
  document.querySelectorAll('.col').forEach(function (col) { col.classList.remove('drag-over'); });
}

async function renderAll() {
  var panel = document.getElementById('view-all');
  if (!panel) return;
  var now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  try {
    employees = await api('GET', '/team');
  } catch (error) {}

  var cols = employees.map(function (emp) {
    var color = emp.color || '#888';
    var colBg = emp.colBg || '#f4f8fe';
    var doingTasks = (emp.tasks || []).filter(function (task) { return task.status === 'doing'; });
    var todoTasks = (emp.tasks || []).filter(function (task) { return task.status === 'todo'; });
    var badge = doingTasks.length > 0
      ? '<span class="doing-badge">Em andamento</span>'
      : '<span class="idle-badge">Aguardando</span>';
    var cards = '';
    doingTasks.forEach(function (task) {
      cards += '<div class="all-task-card doing"><div class="all-task-title">' + esc(task.title) + '</div>' +
        (task.desc ? '<div class="all-task-sub">' + esc(task.desc.length > 60 ? task.desc.slice(0, 60) + '...' : task.desc) + '</div>' : '') +
        (task.assignedBy ? '<div class="all-task-sub">👤 ' + esc(task.assignedBy) + '</div>' : '') +
        '</div>';
    });
    todoTasks.forEach(function (task) {
      cards += '<div class="all-task-card todo"><div class="all-task-title">' + esc(task.title) + '</div>' +
        (task.assignedBy ? '<div class="all-task-sub">👤 ' + esc(task.assignedBy) + '</div>' : '') +
        '</div>';
    });
    if (!cards) cards = '<div class="all-empty">Sem tarefas abertas</div>';

    return '<div class="all-emp-col" style="border-top:3px solid ' + color + '">' +
      '<div class="all-emp-head" style="background:' + colBg + '">' +
      '<div class="all-emp-av" style="background:' + color + '">' + ini(emp.name) + '</div>' +
      '<div><div class="all-emp-name">' + esc(emp.name) + '</div><div class="all-emp-status">' + badge + '</div></div>' +
      '</div>' +
      '<div class="all-task-list">' + cards + '</div>' +
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
}

function renderMgr() {
  var panel = document.getElementById('mgrPanel');
  if (!panel) return;
  if (currentUser && currentUser.role !== 'manager') {
    panel.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-light)">Acesso restrito ao gestor.</div>';
    return;
  }
  if (!mgrUnlocked) {
    panel.innerHTML = buildLockScreen();
    return;
  }
  buildDashboard().then(function (html) {
    panel.innerHTML = html;
  }).catch(function (error) {
    panel.innerHTML = '<div style="padding:40px;text-align:center;color:var(--red)">Erro ao carregar painel: ' + esc(error.message) + '</div>';
  });
}

function buildLockScreen() {
  return '<div class="lock-screen"><div class="lock-box">' +
    '<div class="lock-icon-big">🔐</div>' +
    '<div class="lock-title">Area do <em>Gestor</em></div>' +
    '<div class="lock-sub">Digite a senha para acessar relatorios e metricas.</div>' +
    '<div class="lock-input-wrap">' +
    '<input class="lock-input" id="pwInput" type="password" placeholder="••••••••" maxlength="32" oninput="document.getElementById(\'pwErr\').textContent=\'\'" onkeydown="if(event.key===\'Enter\')tryMgrUnlock()" />' +
    '<button class="toggle-pw" onclick="var i=document.getElementById(\'pwInput\');i.type=i.type===\'password\'?\'text\':\'password\'">👁</button>' +
    '</div>' +
    '<div class="lock-error" id="pwErr"></div>' +
    '<button class="btn-unlock" onclick="tryMgrUnlock()">Entrar no Painel</button>' +
    '</div></div>';
}

async function tryMgrUnlock() {
  var val = document.getElementById('pwInput') ? document.getElementById('pwInput').value : '';
  if (!val) return;
  try {
    if (currentUser && currentUser.role === 'manager') {
      mgrUnlocked = true;
      document.getElementById('lockIcon').textContent = '🔓';
      await loadManagerUsers();
      renderMgr();
      showToast('Acesso liberado');
    } else {
      throw new Error('Acesso restrito');
    }
  } catch (error) {
    var inp = document.getElementById('pwInput');
    if (inp) {
      inp.classList.add('error');
      inp.value = '';
      setTimeout(function () { inp.classList.remove('error'); }, 400);
    }
    var err = document.getElementById('pwErr');
    if (err) err.textContent = 'Acesso negado.';
  }
}

function lockMgr() {
  mgrUnlocked = false;
  document.getElementById('lockIcon').textContent = '🔒';
  renderMgr();
  showToast('Sessao encerrada');
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
    renderTeam();
    renderMgr();
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
      renderTeam();
      if (mgrUnlocked) renderMgr();
      showToast('Dia encerrado automaticamente (21h)');
    }).catch(function () {});
  }
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
setInterval(function () { if (currentTab === 'mgr' && mgrUnlocked) renderMgr(); }, 10000);
setInterval(updateDate, 60000);
