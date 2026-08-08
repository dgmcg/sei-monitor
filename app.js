// ============================================================
// SEI Monitor v2.2 — app.js
// ============================================================

// ==================== CONFIG ====================
const LIMITE_HORAS = { 'Máxima': 2, 'Alta': 24, 'Média': 48, 'Baixa': 96 };

// ── Urgência: pontuação para ordenação dos cards ─────────────
function _urgenciaScore(p) {
  if (p.status === 'Concluído') return -1000;
  const horas  = horasDesdeData(p.data_atualizacao || p.data_cadastro);
  const limite = LIMITE_HORAS[p.prioridade] || 336;
  const prioOrd = { 'Máxima': 4, 'Alta': 3, 'Média': 2, 'Baixa': 1 };
  const prio = prioOrd[p.prioridade] || 1;
  if (horas > limite) {
    // Atrasado: score muito alto; mais dias de atraso = mais urgente
    return 10000 + prio * 1000 + Math.floor((horas - limite) / 24) * 10;
  }
  if (horas > limite - 24) return 5000 + prio * 100; // Vence hoje
  return prio; // OK: apenas ordem por prioridade
}

// ── Urgência: estado e dias de atraso ────────────────────────
function _urgenciaInfo(p) {
  const horas  = horasDesdeData(p.data_atualizacao || p.data_cadastro);
  const limite = LIMITE_HORAS[p.prioridade] || 336;
  if (horas > limite) {
    const dias = Math.ceil((horas - limite) / 24);
    return { estado: 'atrasado', dias, muitoAtrasado: dias >= 2 };
  }
  if (horas > limite - 24) return { estado: 'hoje', dias: 0, muitoAtrasado: false };
  return { estado: 'ok', dias: 0, muitoAtrasado: false };
}
const OLLAMA_URL   = 'http://localhost:11434/api/generate';
let   OLLAMA_MODEL = localStorage.getItem('ollama_model') || 'llama3.2:3b';
const BLOCO_MAX    = 49000;
const RELEVANCIA_MAX_CHARS = 25000;

// ==================== STATE ====================
let API_URL        = '';
let sessao         = null;
let usuarioAtual   = null;
let todosProcessos = [];

// ==================== INIT ====================
window.onload = () => {
  API_URL = localStorage.getItem('sei_api_url') || '';
  if (API_URL) document.getElementById('api-url-input').value = API_URL;
  // Chat só aparece após login
  const chatFab = document.getElementById('chat-fab');
  if (chatFab) chatFab.style.display = 'none';
  verificarOllama();
  // Extensão Chrome: salva rascunho do hash antes de limpar a URL
  _lerRascunhoExtensaoDoHash();
};

// ==================== EXTENSÃO CHROME: RASCUNHO ====================
// Lê o hash #rascunho=BASE64 que a extensão adiciona ao abrir o monitor.
// Guarda no sessionStorage e limpa a URL para não aparecer na barra.
function _lerRascunhoExtensaoDoHash() {
  try {
    const hash = window.location.hash;
    if (!hash) return;

    // #abrir=SEI_NUMBER → Flow A: abre detalhe do processo após login
    if (hash.includes('abrir=')) {
      const sei = decodeURIComponent(
        hash.replace(/^#/, '').replace(/^.*abrir=/, '').split('&')[0]
      );
      if (sei) sessionStorage.setItem('sei_abrir_processo', sei);
      if (history.replaceState) history.replaceState(null, '', window.location.pathname + window.location.search);
      return;
    }

    // #rascunho=BASE64 → Flow B: pré-preenche formulário após login
    if (hash.includes('rascunho=')) {
      const b64   = hash.replace(/^#/, '').replace(/^.*rascunho=/, '');
      const dados = JSON.parse(decodeURIComponent(escape(atob(b64))));
      sessionStorage.setItem('sei_rascunho_extensao', JSON.stringify(dados));
      // Salva domínio do SEI para usar em abrirNoSEI
      if (dados.url_sei) {
        try { const u = new URL(dados.url_sei); localStorage.setItem('sei_base_url', u.origin + '/sei'); } catch(e) {}
      }
      if (history.replaceState) history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  } catch (e) { /* hash inválido ou ausente */ }
}

// Preenche o formulário "Novo Processo" (renderNovo já foi chamado e resetou novoProc).
// Usamos setTimeout para esperar o DOM renderizar antes de manipular os campos.
function _preencherRascunhoNoFormulario() {
  try {
    const raw = sessionStorage.getItem('sei_rascunho_extensao');
    if (!raw) return;
    const d = JSON.parse(raw);
    sessionStorage.removeItem('sei_rascunho_extensao');

    // Preenche os campos da etapa 1
    const eSei    = document.getElementById('w-sei');
    const eTitulo = document.getElementById('w-titulo');
    const eTipo   = document.getElementById('w-tipo');
    if (eSei)    eSei.value    = d.numero_sei || '';
    if (eTitulo) eTitulo.value = d.titulo || '';  // deixa vazio para o usuário preencher
    if (eTipo && d.tipo) {
      const tipoLow = d.tipo.toLowerCase();
      for (let i = 0; i < eTipo.options.length; i++) {
        const v = eTipo.options[i].value.toLowerCase();
        if (v && (tipoLow.includes(v) || v.includes(tipoLow.split(' ')[0]))) {
          eTipo.selectedIndex = i;
          if (typeof tipoSelecionado === 'function') tipoSelecionado();
          break;
        }
      }
    }

    // Armazena no novoProc para as próximas etapas do wizard
    novoProc.sei                  = d.numero_sei       || '';
    novoProc.unidade              = d.unidade          || '';
    novoProc.tipo                 = d.tipo             || '';
    novoProc.andamentos           = d.andamentos_texto || '';
    novoProc._docListExtensao     = d.docList          || [];  // lista exibida no Step 3

    // Aviso visual
    const count = d.andamentos_count || 0;
    if (count > 0) {
      const banner = document.createElement('div');
      banner.style.cssText = 'background:#dcfce7;border:1px solid #16a34a;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#15803d;';
      banner.innerHTML = '✅ <b>' + count + ' andamento(s)</b> importado(s) da extensão SEI Monitor. Revise os dados abaixo e salve.';
      const content = document.getElementById('content');
      if (content && content.firstChild) content.insertBefore(banner, content.firstChild);
    }
  } catch (e) { console.warn('SEI Monitor rascunho:', e); }
}
// ==================== API ====================
async function api(path, body = null) {
  const [basePath, queryStr] = path.split('?');
  let url = API_URL + (API_URL.includes('?') ? '&' : '?') + 'path=' + encodeURIComponent(basePath);
  if (queryStr) url += '&' + queryStr;
  if (!body && sessao?.token) url += '&token=' + encodeURIComponent(sessao.token);
  const opts = { redirect: 'follow' };
  if (body) {
    opts.method  = 'POST';
    opts.headers = { 'Content-Type': 'text/plain' };
    opts.body    = JSON.stringify({ ...body, token: sessao?.token });
  } else {
    opts.method = 'GET';
  }
  let r, text;
  try {
    r    = await fetch(url, opts);
    text = await r.text();
  } catch(e) { return { ok: false, erro: 'Erro de rede: ' + e.message }; }
  try {
    return JSON.parse(text);
  } catch {
    const isHtml = text.trimStart().startsWith('<');
    if (isHtml) {
      console.error('API retornou HTML:', text.substring(0, 300));
      return { ok: false, erro: 'O servidor retornou uma resposta inesperada. Verifique a URL do Apps Script.' };
    }
    return { ok: false, erro: text.substring(0, 200) };
  }
}

// ==================== AUTH ====================
async function fazerLogin() {
  const urlInput = document.getElementById('api-url-input').value.trim();
  const usuario  = document.getElementById('login-email').value.trim().toLowerCase();
  const senha    = document.getElementById('login-senha').value;
  const errEl    = document.getElementById('login-error');
  errEl.classList.add('hidden');
  if (!urlInput) { errEl.textContent = 'Informe a URL do Apps Script.'; errEl.classList.remove('hidden'); return; }
  API_URL = urlInput;
  localStorage.setItem('sei_api_url', API_URL);
  const senhaHash = await sha256(senha);
  const res = await api('auth/login', { usuario, senha: senhaHash });
  if (!res.ok) { errEl.textContent = res.erro || 'Credenciais inválidas.'; errEl.classList.remove('hidden'); return; }
  sessao       = res.sessao;
  usuarioAtual = res.usuario;
  iniciarApp();
  api('log/registrar', { acao: 'LOGIN', numero_sei: '', detalhes: 'Login realizado' });
}

function logout() {
  if (sessao) api('auth/logout', { token: sessao.token });
  sessao = null; usuarioAtual = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').style.display = '';
  const chatFab = document.getElementById('chat-fab');
  if (chatFab) { chatFab.style.display = 'none'; }
}

function iniciarApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('sidebar-nome').textContent  = usuarioAtual.nome;
  document.getElementById('sidebar-email').textContent = usuarioAtual.usuario;
  if (usuarioAtual.perfil === 'admin') document.getElementById('nav-admin').classList.remove('hidden');
  // Mostrar chat após login
  const chatFab = document.getElementById('chat-fab');
  if (chatFab) chatFab.style.display = '';
  carregarDadosFixos();
  // Extensão Chrome: decide qual view abrir após o login
  const _seiParaAbrir = sessionStorage.getItem('sei_abrir_processo');
  if (_seiParaAbrir) {
    // Flow A: processo existente atualizado → abre detalhe direto
    sessionStorage.removeItem('sei_abrir_processo');
    showView('dashboard');
    setTimeout(function () { abrirProcesso(_seiParaAbrir); }, 500);
  } else if (sessionStorage.getItem('sei_rascunho_extensao')) {
    // Flow B: processo novo → abre formulário pré-preenchido
    showView('novo');
    setTimeout(_preencherRascunhoNoFormulario, 600);
  } else {
    showView('dashboard');
  }
  verificarOllama();
}

// ==================== VIEWS ====================
function showView(v) {
  document.querySelectorAll('#sidebar nav a').forEach(a => a.classList.remove('active'));
  const el = document.getElementById('nav-' + v);
  if (el) el.classList.add('active');
  const titles = { dashboard: 'Dashboard', novo: 'Novo Processo', admin: 'Administração' };
  document.getElementById('page-title').textContent = titles[v] || v;
  if (v === 'dashboard') renderDashboard();
  else if (v === 'novo') renderNovo();
  else if (v === 'admin') renderAdmin();
}

// ==================== DASHBOARD ====================
async function renderDashboard() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="text-muted"><span class="spinner"></span> Carregando processos...</div>';
  let res;
  try { res = await api('processos/listar'); } catch(e) { res = { ok: false, erro: e.message }; }
  if (!res.ok) { content.innerHTML = `<div class="alert alert-danger">${res.erro || 'Erro ao carregar.'}</div>`; return; }
  todosProcessos = res.processos || [];
  content.innerHTML = '';

  // Barra de estatísticas: totais + média de tramitação por prioridade
  const statsBox = document.createElement('div');
  statsBox.id = 'stats-bar';
  content.appendChild(statsBox);
  renderStatsBar(statsBox);

  // Banner de alerta para processos com prioridade Máxima em andamento
  const urgentes = todosProcessos.filter(p => p.prioridade === 'Máxima' && p.status === 'Em andamento');
  if (urgentes.length) {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:#7c3aed;color:#fff;border-radius:8px;padding:12px 16px;margin-bottom:14px;font-size:.85rem;';
    banner.innerHTML = `<i class="fa fa-exclamation-triangle"></i> <b>${urgentes.length} processo(s) com PRIORIDADE MÁXIMA</b> em andamento: ${urgentes.map(p => `<a onclick="abrirProcesso('${p.numero_sei}')" style="color:#e9d5ff;cursor:pointer;text-decoration:underline;">${p.numero_sei}</a>`).join(', ')}`;
    content.appendChild(banner);
  }

  const rgBox = document.createElement('div');
  rgBox.id = 'resumo-geral-container';
  rgBox.innerHTML = '<div class="resumo-geral-box" style="opacity:.5;"><div class="rg-header"><h3><i class="fa fa-brain" style="color:var(--primary);"></i> Resumo do Período</h3></div><div class="rg-content text-muted"><span class="spinner"></span> Verificando resumo...</div></div>';
  content.appendChild(rgBox);

  const agendaBox = document.createElement('div');
  agendaBox.id = 'agenda-container';
  content.appendChild(agendaBox);
  renderAgendaProcessos(agendaBox);

  const filtros = document.createElement('div');
  filtros.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px;';
  filtros.innerHTML = `
    <button class="btn btn-secondary btn-sm" onclick="filtrarPorStatus('')">Todos</button>
    <button class="btn btn-secondary btn-sm" onclick="filtrarPorStatus('Em andamento')">Em andamento</button>
    <button class="btn btn-secondary btn-sm" onclick="filtrarPorStatus('Aguardando')">Aguardando</button>
    <button class="btn btn-secondary btn-sm" onclick="filtrarPorStatus('Concluído')">Concluídos</button>
    <select onchange="filtrarPorPrioridade(this.value)" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-size:.78rem;">
      <option value="">Todas prioridades</option>
      <option>Máxima</option><option>Alta</option><option>Média</option><option>Baixa</option>
    </select>`;
  content.appendChild(filtros);

  const grid = document.createElement('div');
  grid.className = 'cards-grid'; grid.id = 'cards-grid';
  content.appendChild(grid);
  renderCards(todosProcessos, grid);

  (async () => {
    try {
      await verificarEGerarResumoGeral();
      const rgBoxAtual = document.getElementById('resumo-geral-container');
      if (rgBoxAtual) await renderResumoGeral(rgBoxAtual);
    } catch(e) {
      const rgBoxAtual = document.getElementById('resumo-geral-container');
      if (rgBoxAtual) rgBoxAtual.innerHTML = '';
    }
  })();
}

function renderCards(lista, grid) {
  grid.innerHTML = '';
  if (!lista.length) { grid.innerHTML = '<p class="text-muted">Nenhum processo encontrado.</p>'; return; }
  // Ordena: atrasados primeiro, depois vence hoje, depois por prioridade
  const sorted = [...lista].sort((a, b) => _urgenciaScore(b) - _urgenciaScore(a));
  sorted.forEach(p => grid.appendChild(criarCard(p)));
}

function criarCard(p) {
  const sei = p.numero_sei;
  const div = document.createElement('div');
  div.className = 'process-card';
  const urg = _urgenciaInfo(p);
  // Classes visuais
  if (p.prioridade === 'Máxima') div.classList.add('alerta-maxima');
  if (urg.estado === 'atrasado') {
    div.classList.add(urg.muitoAtrasado ? 'alerta-muito-atrasado' : 'alerta-atrasado');
  } else if (urg.estado === 'hoje' && p.prioridade !== 'Máxima') {
    div.classList.add('alerta-hoje');
  }
  const priBadge = (p.prioridade || '').replace('á','a').replace('é','e');
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div class="sei-num">SEI: ${sei}</div>
      <button onclick="deletarProcessoCard(event,'${sei}')" title="Excluir"
        style="background:none;border:none;cursor:pointer;color:#d1d5db;font-size:.85rem;padding:0;">
        <i class="fa fa-trash"></i>
      </button>
    </div>
    <div class="titulo">${p.titulo}</div>
    ${p.unidade ? `<div style="font-size:.75rem;color:var(--muted);margin-bottom:4px;"><i class="fa fa-building" style="margin-right:3px;"></i>${p.unidade}${p.oss ? ' · ' + p.oss : ''}</div>` : ''}
    ${p.situacao_atual ? `<div class="situacao" style="font-size:.84rem;">${p.situacao_atual}</div>` : ''}
    ${p.ultimo_andamento_resumo ? `<div class="ultimo-and"><i class="fa fa-clock" style="margin-right:4px;color:var(--muted);"></i>${p.ultimo_andamento_resumo}${p.ultimo_andamento_data ? ' <small>('+formatarDataGAS(p.ultimo_andamento_data)+')</small>' : ''}</div>` : ''}
    <div class="card-footer">
      <span class="badge-prioridade ${priBadge}" onclick="event.stopPropagation();alterarPrioridade('${sei}','${p.prioridade||''}',this)" title="Clique para alterar prioridade" style="cursor:pointer;">${p.prioridade}</span>
      <span class="badge-status">${p.status}</span>
      ${p.prioridade==='Máxima' ? `<span style="color:#7c3aed;font-size:.72rem;font-weight:700;">⚠ URGENTE</span>` : urg.estado==='atrasado' ? `<span style="color:#dc2626;font-size:.72rem;font-weight:700;">🔴 ATRASADO${urg.dias>0?' '+urg.dias+'d':''}</span>` : urg.estado==='hoje' ? `<span style="color:#2563eb;font-size:.72rem;font-weight:600;">⚡ Verificar hoje</span>` : ''}
    </div>`;
  div.onclick = () => abrirProcesso(sei);
  return div;
}

async function deletarProcessoCard(event, sei) {
  event.stopPropagation();
  if (!confirm(`Excluir o processo SEI ${sei}?\n\nEsta ação não pode ser desfeita.`)) return;
  const res = await api('processos/deletar', { sei });
  if (res.ok) {
    todosProcessos = todosProcessos.filter(p => p.numero_sei !== sei);
    aplicarFiltros();
    api('log/registrar', { acao: 'DELETAR_PROCESSO', numero_sei: sei, detalhes: 'Excluído do dashboard' });
  } else {
    alert('Erro ao excluir: ' + (res.erro || 'Tente novamente.'));
  }
}

let filtroStatus = '', filtroPrioridade = '', filtroTexto = '';
function filtrarPorStatus(s)    { filtroStatus     = s; aplicarFiltros(); }
function filtrarPorPrioridade(s){ filtroPrioridade = s; aplicarFiltros(); }
function filtrarCards()         { filtroTexto = document.getElementById('search-input').value.toLowerCase(); aplicarFiltros(); }
function aplicarFiltros() {
  let lista = todosProcessos;
  if (filtroStatus)     lista = lista.filter(p => p.status === filtroStatus);
  if (filtroPrioridade) lista = lista.filter(p => p.prioridade === filtroPrioridade);
  if (filtroTexto)      lista = lista.filter(p => (p.numero_sei+p.titulo+p.situacao_atual+'').toLowerCase().includes(filtroTexto));
  renderCards(lista, document.getElementById('cards-grid'));
}

// ==================== RESUMO GERAL ====================
function getPeriodo() {
  const h = new Date().getHours();
  if (h >= 6 && h < 12)  return 'manha';
  if (h >= 13 && h < 18) return 'tarde';
  return null;
}

async function verificarEGerarResumoGeral() {
  const periodo = getPeriodo(); if (!periodo) return;
  const res = await api('resumo-geral/obter?periodo=' + periodo);
  if (res.ok && res.resumo?.conteudo) return;
  const ollamaOk = await testarOllama(); if (!ollamaOk) return;
  if (!todosProcessos.length) return;
  const lista = todosProcessos.slice(0, 20).map(p =>
    `SEI ${p.numero_sei}: ${p.titulo} (${p.status}, Prioridade ${p.prioridade}, Unidade: ${p.unidade||'—'}) — ${p.situacao_atual || p.resumo_ia || 'sem análise'}`
  ).join('\n');
  const turno = periodo === 'manha' ? 'manhã' : 'tarde';
  const prompt = `Você é especialista em gestão de contratos de Organização Social de Saúde (OSS) e processos administrativos do setor público de saúde.
Gere um resumo gerencial de ${turno} sobre os processos monitorados abaixo.
Identifique: processos críticos (prioridade Máxima/Alta), riscos contratuais, pontos de atenção imediata e recomendações de gestão.
Seja objetivo, máx 300 palavras. Use linguagem executiva.

PROCESSOS MONITORADOS:
${lista}

RESUMO GERENCIAL — ${turno.toUpperCase()}:`;
  try {
    const resp = await fetch(OLLAMA_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:OLLAMA_MODEL, prompt, stream:false }) });
    const data = await resp.json();
    await api('resumo-geral/salvar', { periodo, conteudo: data.response || '' });
  } catch(e) { console.warn('Erro ao gerar resumo geral:', e); }
}

async function renderResumoGeral(container) {
  // Tenta mostrar o resumo mais recente do dia — tarde tem prioridade sobre manhã
  // A exibição não depende do horário atual; só a geração é restrita ao período
  let resumo = null, periodo = null;
  for (const p of ['tarde', 'manha']) {
    const res = await api('resumo-geral/obter?periodo=' + p);
    if (res.ok && res.resumo?.conteudo) { resumo = res.resumo; periodo = p; break; }
  }
  if (!resumo) { container.innerHTML = ''; return; }
  const turno = periodo === 'manha' ? '🌅 Resumo da Manhã' : '🌇 Resumo da Tarde';
  container.innerHTML = `
  <div class="resumo-geral-box">
    <div class="rg-header">
      <h3><i class="fa fa-brain" style="color:var(--primary);"></i> ${turno}</h3>
      <span class="rg-meta">Gerado às ${formatarDataHora(resumo.data_hora)}</span>
    </div>
    <div class="rg-content">${resumo.conteudo}</div>
  </div>`;
}

// ==================== AGENDA DE VERIFICAÇÃO ====================
function toggleDiaAgenda(key, btn) {
  const el = document.getElementById('dia-extra-' + key);
  if (!el) return;
  const hidden = el.style.display === 'none';
  el.style.display = hidden ? '' : 'none';
  const count = el.querySelectorAll('[data-dia-item]').length;
  btn.textContent = hidden ? '▲ Recolher' : '▼ Ver todos (' + count + ')';
}

function renderAgendaProcessos(container) {
  const ativos = todosProcessos.filter(p => p.status === 'Em andamento');
  if (!ativos.length) { container.innerHTML = ''; return; }

  const agora    = Date.now();
  const hojeInicio = new Date(); hojeInicio.setHours(0,0,0,0);
  const nomeDias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

  // Calcula data de vencimento de cada processo
  const buckets = {};
  ativos.forEach(p => {
    const horas  = horasDesdeData(p.data_atualizacao || p.data_cadastro);
    const limite = LIMITE_HORAS[p.prioridade] || 336;
    const horasRestantes = limite - horas;

    let venc = new Date(agora + horasRestantes * 3600000);
    venc.setHours(0,0,0,0);
    if (venc < hojeInicio) venc = new Date(hojeInicio);
    const key = venc.toISOString().substring(0, 10);
    if (!buckets[key]) buckets[key] = [];
    const diasAtraso = horasRestantes < 0 ? Math.ceil(-horasRestantes / 24) : 0;
    buckets[key].push({ p, diasAtraso });
  });

  // Gera 8 dias a partir de hoje
  const dias = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(hojeInicio);
    d.setDate(d.getDate() + i);
    dias.push(d);
  }

  const ITEMS_VISIVEIS = 3;

  let html = `
  <div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:16px;">
    <div style="margin-bottom:10px;">
      <h3 style="margin:0;font-size:.9rem;font-weight:700;color:#111827;"><i class="fa fa-calendar-check" style="color:var(--primary);margin-right:6px;"></i> Agenda de Verificação</h3>
    </div>
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;">`;

  dias.forEach((dia, i) => {
    const key    = dia.toISOString().substring(0, 10);
    const keyId  = key.replace(/-/g,'');
    const procs  = (buckets[key] || []).slice().sort((a, b) => {
      if (b.diasAtraso !== a.diasAtraso) return b.diasAtraso - a.diasAtraso;
      const prioOrd = { 'Máxima': 4, 'Alta': 3, 'Média': 2, 'Baixa': 1 };
      return (prioOrd[b.p.prioridade] || 0) - (prioOrd[a.p.prioridade] || 0);
    });
    const isHoje = i === 0;
    const nomeDia = isHoje ? 'Hoje' : nomeDias[dia.getDay()];
    const diaMes  = dia.getDate() + '/' + (dia.getMonth() + 1);
    const temAtrasado = procs.some(x => x.diasAtraso > 0);
    const borderColor = isHoje ? (temAtrasado ? '#dc2626' : '#3b82f6') : (procs.length ? '#d1d5db' : '#e5e7eb');
    const bgColor     = isHoje ? (temAtrasado ? '#fef2f2' : '#eff6ff') : (procs.length ? '#f9fafb' : '#fafafa');
    const headerColor = isHoje ? (temAtrasado ? '#dc2626' : '#2563eb') : '#6b7280';
    const badgeBg     = temAtrasado ? '#dc2626' : isHoje ? '#2563eb' : '#6b7280';

    const visiveisItems = procs.slice(0, ITEMS_VISIVEIS);
    const extrasItems   = procs.slice(ITEMS_VISIVEIS);

    function procHtml({ p, diasAtraso }) {
      const priBadge = (p.prioridade||'').replace('á','a').replace('é','e');
      return `<div data-dia-item onclick="abrirProcesso('${p.numero_sei}')" style="cursor:pointer;margin-bottom:5px;padding:5px 6px;background:#fff;border:1px solid #e5e7eb;border-radius:5px;font-size:.7rem;">
        <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.69rem;color:#111;" title="${p.numero_sei}">${p.numero_sei}</div>
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6b7280;font-size:.67rem;" title="${p.titulo||''}">${(p.titulo||'Sem título').substring(0,28)}</div>
        <div style="margin-top:3px;display:flex;gap:3px;align-items:center;flex-wrap:wrap;">
          <span class="badge-prioridade ${priBadge}" style="font-size:.6rem;padding:1px 4px;">${p.prioridade}</span>
          ${diasAtraso > 0 ? `<span style="color:#dc2626;font-size:.64rem;font-weight:700;">⚠ +${diasAtraso}d</span>` : ''}
        </div>
      </div>`;
    }

    html += `
    <div style="min-width:130px;flex:0 0 130px;border:1.5px solid ${borderColor};border-radius:8px;padding:8px;background:${bgColor};">
      <div style="font-size:.72rem;font-weight:700;color:${headerColor};text-align:center;margin-bottom:6px;white-space:nowrap;">
        ${nomeDia} <span style="font-weight:400;">${diaMes}</span>
        ${procs.length ? `<span style="background:${badgeBg};color:#fff;border-radius:10px;padding:1px 6px;font-size:.65rem;margin-left:3px;">${procs.length}</span>` : ''}
      </div>`;

    if (!procs.length) {
      html += `<div style="text-align:center;color:#9ca3af;font-size:.68rem;padding:10px 0;"><i class="fa fa-check" style="color:#86efac;"></i> Livre</div>`;
    } else {
      html += visiveisItems.map(procHtml).join('');
      if (extrasItems.length > 0) {
        html += `<div id="dia-extra-${keyId}" style="display:none;">${extrasItems.map(procHtml).join('')}</div>`;
        html += `<button onclick="event.stopPropagation();toggleDiaAgenda('${keyId}',this)" style="width:100%;background:none;border:1px solid #e5e7eb;border-radius:4px;padding:3px;cursor:pointer;font-size:.65rem;color:var(--muted);margin-top:2px;">▼ Ver todos (${procs.length})</button>`;
      }
    }
    html += `</div>`;
  });

  html += `</div></div>`;
  container.innerHTML = html;
}

// ==================== STATS BAR ====================
function renderStatsBar(container) {
  const ativos = todosProcessos.filter(p => p.status === 'Em andamento');
  if (!ativos.length) { container.innerHTML = ''; return; }

  const prioridades = ['Máxima', 'Alta', 'Média', 'Baixa'];
  const coresPrio = { 'Máxima': '#7c3aed', 'Alta': '#dc2626', 'Média': '#ca8a04', 'Baixa': '#16a34a' };

  function avgDias(grupo) {
    if (!grupo.length) return 0;
    const total = grupo.reduce((s, p) => {
      const criado = new Date(p.data_cadastro || p.data_atualizacao);
      const dias = isNaN(criado.getTime()) ? 0 : (Date.now() - criado.getTime()) / 86400000;
      return s + dias;
    }, 0);
    return Math.round(total / grupo.length);
  }

  let html = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:stretch;">`;

  html += `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 14px;display:flex;align-items:center;gap:10px;min-width:120px;">
    <i class="fa fa-tasks" style="color:#2563eb;font-size:1.1rem;"></i>
    <div>
      <div style="font-size:1.4rem;font-weight:700;color:#1e40af;line-height:1;">${ativos.length}</div>
      <div style="font-size:.65rem;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;">Em andamento</div>
    </div>
  </div>`;

  prioridades.forEach(pri => {
    const grupo = ativos.filter(p => p.prioridade === pri);
    if (!grupo.length) return;
    const avg = avgDias(grupo);
    const priBadge = pri.replace('á','a').replace('é','e');
    const cor = coresPrio[pri];
    html += `<div style="background:#fff;border:1px solid ${cor}55;border-radius:8px;padding:8px 14px;cursor:pointer;min-width:110px;" onclick="filtrarPorPrioridade('${pri}')">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
        <span class="badge-prioridade ${priBadge}" style="font-size:.65rem;padding:2px 6px;pointer-events:none;">${pri}</span>
        <span style="font-size:1.2rem;font-weight:700;color:${cor};line-height:1;">${grupo.length}</span>
      </div>
      <div style="font-size:.65rem;color:#6b7280;">ø ${avg} dias tramitação</div>
    </div>`;
  });

  html += `</div>`;
  container.innerHTML = html;
}

// ==================== ALTERAR PRIORIDADE INLINE ====================
async function alterarPrioridade(sei, prioridadeAtual, elemento) {
  document.querySelectorAll('.prio-dropdown').forEach(el => el.remove());

  const prioridades = ['Máxima', 'Alta', 'Média', 'Baixa'];
  const dropdown = document.createElement('div');
  dropdown.className = 'prio-dropdown';

  prioridades.forEach(p => {
    const item = document.createElement('div');
    item.className = 'prio-dropdown-item';
    if (p === prioridadeAtual) item.style.background = '#f3f4f6';
    const priBadge = p.replace('á','a').replace('é','e');
    item.innerHTML = `<span class="badge-prioridade ${priBadge}" style="font-size:.68rem;padding:2px 7px;pointer-events:none;">${p}</span>`;
    item.onclick = async (e) => {
      e.stopPropagation();
      dropdown.remove();
      if (p === prioridadeAtual) return;
      const res = await api('processos/atualizar', { numero_sei: sei, prioridade: p });
      if (res.ok) {
        const proc = todosProcessos.find(x => x.numero_sei === sei);
        if (proc) proc.prioridade = p;
        const newBadge = p.replace('á','a').replace('é','e');
        elemento.className = 'badge-prioridade ' + newBadge;
        elemento.textContent = p;
        const sb = document.getElementById('stats-bar');
        if (sb) renderStatsBar(sb);
        const ag = document.getElementById('agenda-container');
        if (ag) renderAgendaProcessos(ag);
        const grid = document.getElementById('cards-grid');
        if (grid) aplicarFiltros();
      } else {
        alert('Erro: ' + (res.erro || 'Tente novamente'));
      }
    };
    dropdown.appendChild(item);
  });

  const rect = elemento.getBoundingClientRect();
  dropdown.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:9999;background:#fff;border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:6px;min-width:120px;`;
  document.body.appendChild(dropdown);

  setTimeout(() => {
    const close = (e) => {
      if (!dropdown.contains(e.target)) { dropdown.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

// ==================== PROCESSO DETALHE ====================
async function abrirProcesso(sei) {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="text-muted"><span class="spinner"></span> Carregando processo...</div>';
  document.getElementById('page-title').textContent = 'Processo ' + sei;
  document.querySelectorAll('#sidebar nav a').forEach(a => a.classList.remove('active'));
  api('log/registrar', { acao: 'ABRIR_PROCESSO', numero_sei: sei, detalhes: 'Visualizou processo' });

  const [resP, resA, resD, resAnot, resVer] = await Promise.all([
    api('processos/obter?sei=' + sei),
    api('andamentos/listar?sei=' + sei),
    api('documentos/listar?sei=' + sei),
    api('anotacoes/listar?sei=' + sei),
    api('verificacoes/listar?sei=' + sei)
  ]);

  if (!resP.ok) { content.innerHTML = `<div class="alert alert-danger">${resP.erro}</div>`; return; }
  const proc       = resP.processo;
  const andamentos = (resA.andamentos || []).sort((a,b) => new Date(b.data_movimento) - new Date(a.data_movimento));
  const documentos = resD.documentos  || [];
  const anotacoes  = (resAnot.anotacoes || []).sort((a,b) => new Date(b.data_hora) - new Date(a.data_hora));
  const verificacoes = resVer.verificacoes || [];
  const ultimaAnotacao = anotacoes[0] || null;

  const priBadge = (proc.prioridade||'').replace('á','a').replace('é','e');
  const temIA = proc.resumo_ia || proc.situacao_atual;

  content.innerHTML = `
  <div style="margin-bottom:16px;">
    <button class="btn btn-secondary btn-sm" onclick="showView('dashboard')"><i class="fa fa-arrow-left"></i> Voltar</button>
  </div>

  <div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:10px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:.75rem;color:var(--muted);font-weight:600;margin-bottom:2px;">SEI: ${proc.numero_sei}</div>
        <h2 style="font-size:1.15rem;margin:0;line-height:1.3;">${proc.titulo}</h2>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <span class="badge-prioridade ${priBadge}" onclick="event.stopPropagation();alterarPrioridade('${sei}','${proc.prioridade||''}',this)" title="Clique para alterar prioridade" style="cursor:pointer;">${proc.prioridade||'—'}</span>
        <span class="badge-status">${proc.status||'—'}</span>
        <button class="btn btn-secondary btn-sm" onclick="abrirNoSEI('${sei}','${(proc.url_sei||'').replace(/'/g,'&apos;')}')"><i class="fa fa-external-link-alt"></i> Abrir no SEI</button>
        <button class="btn btn-secondary btn-sm" onclick="editarProcesso('${sei}')" title="Editar processo"><i class="fa fa-edit"></i> Editar</button>
        <button class="btn btn-warning btn-sm" onclick="registrarSemMovimentacao('${sei}')" title="Registrar: sem movimentação"><i class="fa fa-check-circle"></i> Sem Movim.</button>
      </div>
    </div>

    ${ultimaAnotacao ? `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:.83rem;">
      <span style="color:#15803d;font-weight:600;"><i class="fa fa-pen"></i> Atualização de Gestão</span>
      <span style="color:#6b7280;margin:0 6px;">•</span>
      <span style="color:#374151;">${ultimaAnotacao.texto||''}</span>
      <span style="color:#9ca3af;font-size:.75rem;margin-left:8px;">— ${formatarDataHora(ultimaAnotacao.data_hora)}</span>
    </div>` : ''}

    ${proc.situacao_atual ? `<div class="situacao" style="font-size:.92rem;margin-bottom:10px;">${proc.situacao_atual}</div>` : ''}

    <div style="font-size:.82rem;color:var(--muted);display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;">
      <span><b>Tipo:</b> ${proc.tipo||'—'}</span>
      <span><b>Unidade:</b> ${proc.unidade||'—'}</span>
      <span><b>OSS:</b> ${proc.oss||'—'}</span>
      <span><b>Atualização:</b> ${formatarDataSeguro(proc.data_atualizacao)}</span>
    </div>
    ${proc.descricao ? `<p style="margin-top:10px;font-size:.85rem;color:#374151;">${proc.descricao}</p>` : ''}
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab(this,'tab-ia')">Análise IA</div>
    <div class="tab" onclick="switchTab(this,'tab-anotacoes')">Anotações (${anotacoes.length})</div>
    <div class="tab" onclick="switchTab(this,'tab-andamentos')">Andamentos (${andamentos.length})</div>
    <div class="tab" onclick="switchTab(this,'tab-documentos')">Documentos (${documentos.length})</div>
    ${proc.unidade ? `<div class="tab" onclick="switchTab(this,'tab-unidade')"><i class="fa fa-building" style="margin-right:4px;"></i>${proc.unidade}</div>` : ''}
  </div>

  <!-- ABA: ANÁLISE IA (padrão) -->
  <div id="tab-ia">
    <div id="ia-content">
      ${temIA ? renderIABox(proc) : '<div style="padding:20px;text-align:center;color:var(--muted);"><i class="fa fa-brain" style="font-size:2rem;margin-bottom:10px;display:block;"></i>Nenhuma análise disponível ainda.<br><small>Adicione documentos ou andamentos para acionar a IA.</small></div>'}
    </div>
    <div style="margin-top:12px;">
      <button class="btn btn-secondary btn-sm" onclick="acionarIAManual('${sei}')"><i class="fa fa-sync-alt"></i> Atualizar Análise IA</button>
    </div>
    <div id="ia-status-msg" class="mt-2"></div>
  </div>

  <!-- ABA: ANOTAÇÕES -->
  <div id="tab-anotacoes" class="hidden">
    <div style="margin-bottom:16px;">
      <textarea id="nova-anotacao" rows="3" placeholder="Registre uma atualização de gestão, observação ou decisão..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:.85rem;box-sizing:border-box;"></textarea>
      <button class="btn btn-primary btn-sm mt-2" onclick="salvarAnotacao('${sei}')"><i class="fa fa-save"></i> Adicionar Anotação</button>
    </div>
    ${anotacoes.length ? anotacoes.map(a => `
      <div class="anotacao-item">
        <div class="anot-header">${formatarDataHora(a.data_hora)}${a.usuario ? ' — <b>'+a.usuario+'</b>' : ''}</div>
        <div class="anot-body">${a.texto||''}</div>
      </div>`).join('') : '<p class="text-muted">Nenhuma anotação registrada.</p>'}
  </div>

  <!-- ABA: ANDAMENTOS -->
  <div id="tab-andamentos" class="hidden">
    <div class="flex gap-2" style="margin-bottom:14px;">
      <button class="btn btn-primary btn-sm" onclick="mostrarIndexarAndamento('${sei}')"><i class="fa fa-paste"></i> Indexar Andamentos</button>
    </div>
    ${proc.aprendizado_ia ? `
    <div style="background:#f5f3ff;border:1px solid #c4b5fd;border-radius:8px;padding:14px;margin-bottom:16px;">
      <div style="font-weight:600;color:#6d28d9;font-size:.85rem;margin-bottom:6px;"><i class="fa fa-brain"></i> Resumo IA da Timeline</div>
      <div style="font-size:.84rem;color:#374151;white-space:pre-wrap;">${proc.aprendizado_ia}</div>
    </div>` : ''}
    ${andamentos.length ? andamentos.map(a => `
      <div class="andamento-item">
        <div class="and-header">${formatarDataGAS(a.data_movimento)}${a.hora_movimento ? ' às ' + formatarHoraGAS(a.hora_movimento) : ''}</div>
        <div class="and-body">${a.descricao||''}</div>
      </div>`).join('') : '<p class="text-muted">Nenhum andamento registrado.</p>'}
  </div>

  <!-- ABA: DOCUMENTOS -->
  <div id="tab-documentos" class="hidden">
    <div class="flex gap-2" style="margin-bottom:12px;">
      <button class="btn btn-primary btn-sm" onclick="mostrarUpload('${sei}')"><i class="fa fa-upload"></i> Importar Documentos</button>
    </div>
    ${documentos.length ? documentos.map(d => `
      <div class="doc-item">
        <i class="${iconDoc(d.nome_arquivo)}"></i>
        <div style="flex:1;">
          <div class="doc-name">${d.nome_arquivo}</div>
          <div class="doc-meta">${formatarDataSeguro(d.data_upload)} — ${d.usuario_upload||''} — ${d.tamanho ? formatarTamanho(d.tamanho) : 'texto extraído'}</div>
        </div>
        ${d.link_verificacao
          ? `<a href="${d.link_verificacao}" target="_blank" class="btn btn-secondary btn-sm" title="Verificar no SEI"><i class="fa fa-check-circle"></i> SEI</a>`
          : d.link_sei ? `<a href="${d.link_sei}" target="_blank" class="btn btn-secondary btn-sm"><i class="fa fa-external-link-alt"></i></a>` : ''}
      </div>`).join('') : '<p class="text-muted">Nenhum documento importado.</p>'}
  </div>

  <!-- ABA: PROCESSOS DA UNIDADE -->
  ${proc.unidade ? (() => {
    const relacionados = todosProcessos.filter(p => p.unidade === proc.unidade && p.numero_sei !== sei);
    const emAndamento  = relacionados.filter(p => p.status === 'Em andamento');
    const outros       = relacionados.filter(p => p.status !== 'Em andamento');
    return `<div id="tab-unidade" class="hidden">
      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:.83rem;color:#0369a1;">
        <i class="fa fa-building"></i> <b>${proc.unidade}</b>${proc.oss ? ' · ' + proc.oss : ''} — ${relacionados.length} processo(s) monitorado(s)
      </div>
      ${emAndamento.length ? `
        <div style="font-weight:600;font-size:.82rem;color:#374151;margin-bottom:8px;">Em andamento (${emAndamento.length})</div>
        ${emAndamento.map(p => {
          const priBadge2 = (p.prioridade||'').replace('á','a').replace('é','e');
          return `<div class="process-card" onclick="abrirProcesso('${p.numero_sei}')" style="cursor:pointer;margin-bottom:8px;">
            <div style="font-size:.73rem;color:var(--muted);margin-bottom:2px;">SEI: ${p.numero_sei}</div>
            <div style="font-weight:600;font-size:.9rem;margin-bottom:4px;">${p.titulo}</div>
            ${p.situacao_atual ? `<div style="font-size:.8rem;color:#374151;margin-bottom:6px;">${p.situacao_atual.substring(0,120)}${p.situacao_atual.length>120?'...':''}</div>` : ''}
            <div class="card-footer">
              <span class="badge-prioridade ${priBadge2}">${p.prioridade}</span>
              <span class="badge-status">${p.status}</span>
              ${p.data_atualizacao ? `<span style="font-size:.72rem;color:var(--muted);">Atualizado ${formatarDataSeguro(p.data_atualizacao)}</span>` : ''}
            </div>
          </div>`;
        }).join('')}` : '<p class="text-muted">Nenhum processo em andamento para esta unidade.</p>'}
      ${outros.length ? `
        <div style="font-weight:600;font-size:.82rem;color:var(--muted);margin:16px 0 8px;">Outros status (${outros.length})</div>
        ${outros.map(p => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;font-size:.83rem;" onclick="abrirProcesso('${p.numero_sei}')">
            <div>
              <span style="color:var(--muted);margin-right:6px;">${p.numero_sei}</span>
              <span>${p.titulo}</span>
            </div>
            <span class="badge-status">${p.status}</span>
          </div>`).join('')}` : ''}
    </div>`;
  })() : ''}`;

  window._processoAtual = proc;
}

// ==================== ANÁLISE IA BOX ====================
function renderIABox(proc) {
  return `<div class="ia-box">
    <h4><i class="fa fa-brain"></i> Análise de IA — ${proc.categoria||'Processo'}</h4>
    ${proc.situacao_atual ? `<div class="ia-section"><h5>Situação Atual</h5><p>${proc.situacao_atual}</p></div>` : ''}
    ${proc.resumo_ia ? `<div class="ia-section"><h5>Resumo Gerencial</h5><p>${proc.resumo_ia}</p></div>` : ''}
    ${proc.apontamentos_ia ? `<div class="ia-section"><h5>Pontos Críticos e Riscos</h5><p>${proc.apontamentos_ia}</p></div>` : ''}
    ${proc.sugestoes_ia ? `<div class="ia-section"><h5>Sugestões de Ação</h5><p>${proc.sugestoes_ia}</p></div>` : ''}
    ${proc.proximos_passos_ia ? `<div class="ia-section"><h5>Próximos Passos</h5><p>${proc.proximos_passos_ia}</p></div>` : ''}
    ${proc.processos_similares_ref ? `<div class="ia-section"><h5><i class="fa fa-link"></i> Processos Semelhantes</h5><p>${proc.processos_similares_ref}</p></div>` : ''}
    <div style="font-size:.72rem;color:var(--muted);margin-top:12px;">Última análise: ${formatarDataHora(proc.data_atualizacao)}</div>
  </div>`;
}

async function acionarIAManual(sei) {
  const statusEl = document.getElementById('ia-status-msg');
  if (statusEl) statusEl.innerHTML = '<span class="spinner"></span> Gerando análise completa...';
  await acionarIA(sei);
  abrirProcesso(sei);
}

function switchTab(el, id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['tab-ia','tab-anotacoes','tab-andamentos','tab-documentos','tab-unidade'].forEach(t => {
    const el2 = document.getElementById(t);
    if (el2) el2.classList.toggle('hidden', t !== id);
  });
}

// ==================== SEM MOVIMENTAÇÃO ====================
async function registrarSemMovimentacao(sei) {
  const obs = prompt('Observação (opcional):') || 'Sem movimentação verificada';
  const res = await api('verificacoes/registrar', { sei, observacao: obs });
  if (res.ok) {
    api('log/registrar', { acao: 'SEM_MOVIMENTACAO', numero_sei: sei, detalhes: obs });
    alert('Verificação registrada.');
    abrirProcesso(sei);
  } else alert('Erro: ' + (res.erro || 'Não foi possível registrar.'));
}

// ==================== ANOTAÇÕES ====================
async function salvarAnotacao(sei) {
  const texto = document.getElementById('nova-anotacao').value.trim();
  if (!texto) { alert('Digite uma anotação.'); return; }
  const res = await api('anotacoes/salvar', { sei, texto });
  if (!res.ok) { alert('Erro: ' + res.erro); return; }
  api('log/registrar', { acao: 'ANOTACAO', numero_sei: sei, detalhes: texto.substring(0,100) });
  document.getElementById('nova-anotacao').value = '';
  const statusEl = document.getElementById('ia-status-msg');
  if (statusEl) statusEl.innerHTML = '<span class="spinner"></span> Atualizando análise com nova anotação...';
  await acionarIA(sei);
  abrirProcesso(sei);
}

// ==================== EDITAR PROCESSO ====================
function editarProcesso(sei) {
  const proc = window._processoAtual;
  if (!proc) return;
  criarModal(`
    <h2 style="margin-bottom:16px;"><i class="fa fa-edit"></i> Editar Processo</h2>
    <div class="form-group"><label>Título / Objeto</label><input id="edit-titulo" value="${(proc.titulo||'').replace(/"/g,'&quot;')}"></div>
    <div class="form-group"><label>Tipo</label>
      <select id="edit-tipo">${optsTipos(proc.tipo)}</select></div>
    <div class="form-group"><label>Status</label>
      <select id="edit-status">${['Em andamento','Aguardando','Concluído','Suspenso'].map(s=>`<option ${proc.status===s?'selected':''}>${s}</option>`).join('')}</select></div>
    <div class="form-group"><label>Prioridade</label>
      <select id="edit-prioridade">${['Baixa','Média','Alta','Máxima'].map(p=>`<option ${proc.prioridade===p?'selected':''}>${p}</option>`).join('')}</select></div>
    <div class="form-group"><label>Unidade</label>
      <select id="edit-unidade" onchange="editarUnidadeSelecionada()">
        <option value="">— Selecione —</option>
        ${optsUnidades(proc.unidade)}
      </select></div>
    <div class="form-group"><label>OSS <small style="color:var(--muted);">(preenchida automaticamente)</small></label>
      <input id="edit-oss" value="${(proc.oss||'').replace(/"/g,'&quot;')}"></div>
    <div class="form-group"><label>Descrição</label>
      <textarea id="edit-descricao" rows="3">${proc.descricao||''}</textarea></div>
    <div id="edit-err" class="hidden alert alert-danger" style="margin-bottom:8px;"></div>
    <div class="flex gap-2">
      <button class="btn btn-primary" onclick="salvarEdicaoProcesso('${sei}')"><i class="fa fa-save"></i> Salvar</button>
      <button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button>
    </div>`);
}

function editarUnidadeSelecionada() {
  const sel = document.getElementById('edit-unidade'); if (!sel) return;
  const opt = sel.options[sel.selectedIndex];
  const oss = opt?.getAttribute('data-oss') || '';
  const ossEl = document.getElementById('edit-oss');
  if (ossEl && oss) ossEl.value = oss;
}

async function salvarEdicaoProcesso(sei) {
  const titulo    = document.getElementById('edit-titulo').value.trim();
  const tipo      = document.getElementById('edit-tipo').value;
  const status    = document.getElementById('edit-status').value;
  const prioridade = document.getElementById('edit-prioridade').value;
  const unidade   = document.getElementById('edit-unidade').value;
  const oss       = document.getElementById('edit-oss').value.trim();
  const descricao = document.getElementById('edit-descricao').value.trim();
  const errEl     = document.getElementById('edit-err');
  if (!titulo) { errEl.textContent = 'Título obrigatório.'; errEl.classList.remove('hidden'); return; }
  const res = await api('processos/atualizar', { numero_sei: sei, titulo, tipo, status, prioridade, unidade, oss, descricao });
  if (!res.ok) { errEl.textContent = res.erro || 'Erro ao salvar.'; errEl.classList.remove('hidden'); return; }
  api('log/registrar', { acao: 'EDITAR_PROCESSO', numero_sei: sei, detalhes: `Prioridade: ${prioridade}` });
  fecharModal();
  // Atualiza todosProcessos em memória
  const idx2 = todosProcessos.findIndex(p => p.numero_sei === sei);
  if (idx2 > -1) Object.assign(todosProcessos[idx2], { titulo, tipo, status, prioridade, unidade, oss, descricao });
  abrirProcesso(sei);
}

// ==================== INDEXAR ANDAMENTOS ====================
function mostrarIndexarAndamento(sei) {
  criarModal(`
    <h2><i class="fa fa-paste"></i> Indexar Andamentos</h2>
    <p style="font-size:.85rem;color:var(--muted);margin-bottom:12px;">Cole o histórico de andamentos copiado do SEI. O sistema extrai datas, horários e descrições automaticamente.</p>
    <div class="form-group">
      <label>Texto dos Andamentos</label>
      <textarea id="texto-andamentos" rows="12" placeholder="Cole o histórico de andamentos do SEI..."></textarea>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-primary" onclick="processarAndamentos('${sei}')"><i class="fa fa-sync"></i> Processar</button>
      <button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button>
    </div>
    <div id="and-result" class="mt-2"></div>`);
}

async function processarAndamentos(sei) {
  const texto    = document.getElementById('texto-andamentos').value.trim();
  if (!texto) { alert('Cole o texto dos andamentos.'); return; }
  const resultEl = document.getElementById('and-result');
  resultEl.innerHTML = '<span class="spinner"></span> Processando...';
  const res = await api('andamentos/indexar', { sei, texto });
  if (!res.ok) { resultEl.innerHTML = `<div class="alert alert-danger">${res.erro}</div>`; return; }
  api('log/registrar', { acao: 'INDEXAR_ANDAMENTOS', numero_sei: sei, detalhes: `${res.novos||0} novos` });
  resultEl.innerHTML = `<div class="alert alert-success"><i class="fa fa-check"></i> ${res.novos||0} novos andamentos, ${res.ignorados||0} duplicatas ignoradas.</div>`;
  if ((res.novos || 0) > 0) {
    resultEl.innerHTML += '<div class="mt-2"><span class="spinner"></span> Gerando resumo da timeline de andamentos...';
    await gerarResumoAndamentos(sei);
    resultEl.innerHTML += '<br><span class="spinner"></span> Acionando análise completa de IA...';
    await acionarIA(sei);
    resultEl.innerHTML += '<br><i class="fa fa-check"></i> Análise concluída!</div>';
  }
  setTimeout(() => { fecharModal(); abrirProcesso(sei); }, 1500);
}

// Gera resumo específico de andamentos e salva em aprendizado_ia
async function gerarResumoAndamentos(sei) {
  const ollamaOk = await testarOllama(); if (!ollamaOk) return;
  const resA = await api('andamentos/listar?sei=' + sei);
  const andamentos = resA.andamentos || [];
  if (!andamentos.length) return;

  // Ordenar cronologicamente para análise
  const sorted = [...andamentos].sort((a,b) => new Date(a.data_movimento) - new Date(b.data_movimento));
  const primeiraData = formatarDataGAS(sorted[0]?.data_movimento);
  const ultimaData   = formatarDataGAS(sorted[sorted.length-1]?.data_movimento);
  const andamentosTxt = sorted.map(a =>
    `${formatarDataGAS(a.data_movimento)} ${formatarHoraGAS(a.hora_movimento)}: ${a.descricao||''}`
  ).join('\n');

  const prompt = `Você é especialista em gestão de processos administrativos de OSS (Organização Social de Saúde).
Analise o histórico de andamentos abaixo e gere um resumo executivo.

Inclua obrigatoriamente:
- Data de início do processo (primeira movimentação)
- Data da última movimentação
- Principais eventos (despachos, aprovações, documentos juntados/criados, prazos, encaminhamentos)
- Foco especial: inclusão, criação ou juntada de documentos importantes

Seja objetivo, máx 200 palavras. Responda em JSON:
{"inicio":"data início","ultima_movimentacao":"data/evento mais recente","resumo":"resumo executivo focado em documentos e decisões importantes"}

HISTÓRICO:
${andamentosTxt.substring(0, 8000)}`;

  try {
    const resp = await fetch(OLLAMA_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:OLLAMA_MODEL, prompt, stream:false }) });
    const data = await resp.json();
    const raw  = (data.response || '').trim();
    let parsed;
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = null; } }
    const resumoFinal = parsed
      ? `📅 Início: ${parsed.inicio||primeiraData} | Última movimentação: ${parsed.ultima_movimentacao||ultimaData}\n\n${parsed.resumo||''}`
      : `📅 Início: ${primeiraData} | Última movimentação: ${ultimaData}`;
    await api('processos/atualizar', {
      numero_sei: sei,
      ultimo_andamento_resumo: parsed?.resumo?.substring(0,150) || resumoFinal.substring(0,150),
      ultimo_andamento_data:   sorted[sorted.length-1]?.data_movimento || ''
    });
    // Salva análise completa em aprendizado_ia
    await api('processos/salvar-ia', { numero_sei: sei, aprendizado_ia: resumoFinal });
  } catch(e) { console.warn('Erro ao gerar resumo de andamentos:', e); }
}

// ==================== LINKS SEI ====================
function extrairCodigoSEI(nomeArquivo) {
  const m = nomeArquivo.match(/\[\d+\]-(\d{6,})[_\.]/);
  return m ? m[1] : null;
}
function extrairCRCSEI(texto) {
  const m = texto.match(/c[oó]digo\s+CRC\s+([A-F0-9]{6,})/i);
  return m ? m[1] : null;
}
function extrairUrlBaseSEI(texto) {
  const m = texto.match(/(https?:\/\/[^\s\/]+\/sei)\/controlador_externo/i);
  if (m) return m[1];
  const m2 = texto.match(/href="(https?:\/\/[^\s"\/]+\/sei)\/controlador/i);
  return m2 ? m2[1] : null;
}
function buildLinkVerificacao(baseUrl, codigo, crc) {
  if (!codigo) return null;
  const base = baseUrl || localStorage.getItem('sei_base_url') || 'https://sei.pe.gov.br/sei';
  let url = `${base}/controlador_externo.php?acao=documento_conferir&id_orgao_acesso_externo=0&codigo_verificador=${codigo}`;
  if (crc) url += `&crc=${crc}`;
  return url;
}
function buildLinkProcessoEstavel(url) {
  try {
    const u = new URL(url); const p = new URLSearchParams(u.search);
    p.delete('infra_hash'); p.delete('acao_origem'); p.delete('acao_retorno');
    return u.origin + u.pathname + '?' + p.toString();
  } catch(e) { return url; }
}

// Abre o processo no SEI usando a URL de pesquisa rápida (estável para qualquer sessão).
// urlSei é o url_sei armazenado na exportação — usado apenas para extrair o domínio.
function abrirNoSEI(sei, urlSei) {
  let base = localStorage.getItem('sei_base_url');
  if (!base && urlSei) {
    try { const u = new URL(urlSei); base = u.origin + '/sei'; localStorage.setItem('sei_base_url', base); } catch(e) {}
  }
  if (base) {
    window.open(base + '/controlador.php?acao=pesquisa_rapida&txtPesquisaRapida=' + encodeURIComponent(sei), '_blank');
  } else {
    const d = prompt('Informe o endereço base do SEI (ex: https://sei.pe.gov.br/sei):\n(Necessário apenas na primeira vez — ficará salvo.)');
    if (d) { localStorage.setItem('sei_base_url', d.trim().replace(/\/+$/, '')); abrirNoSEI(sei, null); }
  }
}

// ==================== UPLOAD DOCUMENTOS ====================
function mostrarUpload(sei) {
  criarModal(`
    <h2><i class="fa fa-file-import"></i> Importar Documentos</h2>
    <p style="font-size:.82rem;color:var(--muted);margin-bottom:12px;">
      O texto é extraído localmente e salvo no banco de dados para análise da IA. Os arquivos originais <b>não são armazenados</b>.<br>
      <i class="fa fa-magic" style="color:var(--primary);"></i> Links de verificação SEI gerados automaticamente.
    </p>
    <div class="dropzone" id="dropzone-area" onclick="document.getElementById('file-input-hidden').click()">
      <i class="fa fa-file-import"></i>
      <p>Arraste arquivos aqui ou clique para selecionar</p>
      <p style="font-size:.75rem;color:var(--muted);">PDF, DOCX, XLSX, HTML, ZIP</p>
    </div>
    <input type="file" id="file-input-hidden" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.zip,.html" style="display:none" onchange="processarArquivos(event.target.files,'${sei}')">
    <div id="upload-progress" class="upload-progress mt-2"></div>
    <div style="margin-top:12px;text-align:right;">
      <button class="btn btn-secondary" onclick="fecharModal()">Fechar</button>
    </div>`);
  const dz = document.getElementById('dropzone-area');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); processarArquivos(e.dataTransfer.files, sei); });
}

async function processarArquivos(files, sei) {
  const prog        = document.getElementById('upload-progress');
  const todosArquivos = [];

  for (const f of Array.from(files)) {
    if (f.name.toLowerCase().endsWith('.zip')) {
      addProgItem(prog, f.name, 'proc', 'Extraindo ZIP...');
      try {
        const zip = await JSZip.loadAsync(f);
        for (const [nome, zipEntry] of Object.entries(zip.files)) {
          if (!zipEntry.dir && /\.(pdf|docx?|xlsx?|html?)$/i.test(nome)) {
            const blob  = await zipEntry.async('blob');
            const file2 = new File([blob], nome.split('/').pop(), { type: blob.type });
            todosArquivos.push(file2);
          }
        }
        updateProgItem(prog, f.name, 'ok', 'ZIP extraído');
      } catch(e) { updateProgItem(prog, f.name, 'err', 'Erro ao extrair ZIP'); }
    } else { todosArquivos.push(f); }
  }

  for (const file of todosArquivos) {
    addProgItem(prog, file.name, 'proc', 'Verificando...');
    try {
      const buf  = await file.arrayBuffer();
      const hash = await sha256Buf(buf);
      const resHash = await api('documentos/verificar-hash', { numero_sei: sei, hash });
      if (resHash.existe) { updateProgItem(prog, file.name, 'dup', 'Duplicata ignorada'); continue; }

      updateProgItem(prog, file.name, 'proc', 'Extraindo texto...');
      const texto = await extrairTexto(file, buf);

      const codigoSEI = extrairCodigoSEI(file.name);
      const crcSEI    = texto ? extrairCRCSEI(texto) : null;
      if (texto && file.name.toLowerCase().match(/\.(html?)/)) {
        const detectedBase = extrairUrlBaseSEI(texto);
        if (detectedBase) localStorage.setItem('sei_base_url', detectedBase);
      }
      const linkVerificacao = buildLinkVerificacao(null, codigoSEI, crcSEI);

      const resReg = await api('documentos/registrar', {
        numero_sei: sei, nome_arquivo: file.name,
        hash_arquivo: hash, tamanho: file.size,
        link_verificacao: linkVerificacao || ''
      });
      if (!resReg.ok) { updateProgItem(prog, file.name, 'err', resReg.erro || 'Falha ao registrar'); continue; }

      if (texto && texto.trim().length > 0) {
        updateProgItem(prog, file.name, 'proc', 'Salvando texto...');
        await salvarBlocosSheets(sei, resReg.doc_id, file.name, texto);
      }

      api('log/registrar', { acao: 'IMPORTAR_DOCUMENTO', numero_sei: sei, detalhes: file.name });
      updateProgItem(prog, file.name, 'ok', texto ? 'Importado — texto extraído' : 'Importado — sem texto');
    } catch(e) { updateProgItem(prog, file.name, 'err', 'Erro: ' + e.message); }
  }

  const statusSpan = document.createElement('div');
  statusSpan.className = 'alert alert-info mt-2';
  statusSpan.innerHTML = '<span class="spinner"></span> Acionando análise de IA...';
  prog.appendChild(statusSpan);
  await acionarIA(sei);
  statusSpan.className = 'alert alert-success mt-2';
  statusSpan.innerHTML = '<i class="fa fa-check"></i> Análise de IA concluída!';
}

function addProgItem(container, nome, tipo, msg) {
  const id = 'up-' + nome.replace(/[^a-z0-9]/gi, '_');
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('div'); el.className = 'up-item'; el.id = id; container.appendChild(el); }
  const icons = { ok:'fa-check-circle up-ok', dup:'fa-minus-circle up-dup', err:'fa-times-circle up-err', proc:'fa-circle-notch fa-spin up-proc' };
  el.innerHTML = `<i class="fa ${icons[tipo]||'fa-circle'}"></i><span class="up-name">${nome}</span><span>${msg}</span>`;
}
function updateProgItem(c, nome, tipo, msg) { addProgItem(c, nome, tipo, msg); }

// ==================== EXTRAÇÃO DE TEXTO ====================
async function extrairTexto(file, buf) {
  const nome = file.name.toLowerCase();
  try {
    if (nome.endsWith('.pdf')) return await extrairPDF(buf);
    if (nome.endsWith('.docx') || nome.endsWith('.doc')) { const res = await mammoth.extractRawText({ arrayBuffer: buf }); return res.value || ''; }
    if (nome.endsWith('.xlsx') || nome.endsWith('.xls')) { const wb = XLSX.read(new Uint8Array(buf), { type:'array' }); return wb.SheetNames.map(sn => XLSX.utils.sheet_to_csv(wb.Sheets[sn])).join('\n\n'); }
    if (nome.endsWith('.html') || nome.endsWith('.htm')) { const html = new TextDecoder('utf-8').decode(buf); const doc = new DOMParser().parseFromString(html,'text/html'); return doc.body ? doc.body.innerText || doc.body.textContent : ''; }
  } catch(e) { console.warn('Erro ao extrair texto de', file.name, e); }
  return '';
}

async function extrairPDF(buf) {
  if (typeof pdfjsLib !== 'undefined') {
    const pdf   = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    let texto   = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      texto += content.items.map(item => item.str).join(' ') + '\n';
    }
    return texto;
  }
  const decoder = new TextDecoder('latin1');
  const text    = decoder.decode(buf);
  const matches = text.match(/\(([^\)]{2,})\)/g) || [];
  return matches.map(m => m.slice(1,-1)).join(' ');
}

function dividirEmBlocos(texto, maxChars) {
  const blocos = [];
  let i = 0;
  while (i < texto.length) { blocos.push(texto.substring(i, i + maxChars)); i += maxChars; }
  return blocos;
}

async function salvarBlocosSheets(sei, docId, docNome, texto) {
  const blocos = dividirEmBlocos(texto, BLOCO_MAX);
  for (let i = 0; i < blocos.length; i++) {
    await api('conteudo/salvar-bloco', {
      numero_sei: sei, documento_id: docId, documento_nome: docNome,
      bloco_num: i + 1, total_blocos: blocos.length, conteudo: blocos[i]
    });
  }
}

// ==================== IA ANÁLISE COMPLETA ====================
async function acionarIA(sei) {
  const ollamaOk = await testarOllama(); if (!ollamaOk) return;

  // Carrega todos os dados em paralelo
  const [resConteudo, resBases, resP, resA, resAnot, resSim] = await Promise.all([
    api('conteudo/listar?sei=' + sei),
    api('bases-legais/listar'),
    api('processos/obter?sei=' + sei),
    api('andamentos/listar?sei=' + sei),
    api('anotacoes/listar?sei=' + sei),
    api('processos/similares?sei=' + sei)
  ]);

  const proc       = resP.processo || {};
  const blocos     = (resConteudo.blocos || []).map(b => b.conteudo || '');
  const basesLegais = (resBases.blocos || []).map(b => b.conteudo || '');
  const andamentos = (resA.andamentos || []).slice(-10).map(a =>
    `${formatarDataGAS(a.data_movimento)} ${formatarHoraGAS(a.hora_movimento)}: ${a.descricao||''}`
  ).join('\n');
  const anotacoes = (resAnot.anotacoes || []).slice(-5).map(a =>
    `${formatarDataHora(a.data_hora)}: ${a.texto||''}`
  ).join('\n');

  // Processos similares (por categoria OU por tipo)
  let similares = resSim.processos || [];
  if (!similares.length && proc.tipo) {
    similares = todosProcessos.filter(p => p.numero_sei !== sei && p.tipo === proc.tipo).slice(0, 3);
  }
  const similaresTxt = similares.length
    ? similares.map(s => `SEI ${s.numero_sei}: ${s.titulo} — Status: ${s.status} — ${s.situacao_atual || s.resumo_ia || 'sem análise'}`).join('\n')
    : '';

  // Filtrar conteúdo mais relevante
  const keywords = [proc.titulo||'', proc.tipo||'', sei, 'contrato','prazo','pagamento','execução','saúde','OSS']
    .join(' ').toLowerCase().split(/\s+/).filter(k => k.length > 3);
  const conteudoFiltrado     = filtrarBlocos(blocos, keywords, RELEVANCIA_MAX_CHARS);
  const basesLegaisFiltradas = filtrarBlocos(basesLegais, keywords, 12000);

  const prompt = `Você é um ESPECIALISTA em gestão de contratos, processos administrativos e regulação de Organizações Sociais de Saúde (OSS) no setor público brasileiro.
Possui profundo conhecimento em: Lei 9.637/98 (OS), contratos de gestão, licitações na saúde, fiscalização contratual, metas assistenciais e normativas do SUS.

ANALISE o processo abaixo com visão gerencial estratégica:

=== PROCESSO SEI ${sei} ===
TÍTULO: ${proc.titulo||''}
TIPO: ${proc.tipo||'Não informado'}
STATUS: ${proc.status||''}
PRIORIDADE: ${proc.prioridade||''}
UNIDADE: ${proc.unidade||'Não informada'}
OSS: ${proc.oss||'Não informada'}

ÚLTIMOS ANDAMENTOS:
${andamentos || 'Nenhum andamento registrado.'}

ANOTAÇÕES DE GESTÃO:
${anotacoes || 'Nenhuma anotação.'}

${conteudoFiltrado ? '=== CONTEÚDO DOS DOCUMENTOS ===\n' + conteudoFiltrado : ''}

${basesLegaisFiltradas ? '=== BASES LEGAIS APLICÁVEIS ===\n' + basesLegaisFiltradas : ''}

${similaresTxt ? '=== PROCESSOS SEMELHANTES NO SISTEMA ===\n' + similaresTxt : ''}

Responda EXATAMENTE neste formato JSON (sem markdown, sem texto fora do JSON):
{
  "categoria": "categoria do processo em 3-5 palavras",
  "situacao_atual": "situação atual e status do processo em 1-2 frases objetivas",
  "resumo": "análise gerencial detalhada incluindo contexto, histórico e situação atual (mín. 3 parágrafos)",
  "apontamentos": "pontos críticos, riscos contratuais, prazos importantes e alertas legais",
  "sugestoes": "sugestões práticas de ação baseadas nas bases legais aplicáveis e boas práticas de gestão de OSS",
  "proximos_passos": "próximos passos concretos e priorizados com responsáveis e prazos sugeridos",
  "processos_similares": "${similaresTxt ? 'comparação com os processos semelhantes: como foram conduzidos, lições aprendidas e benchmarks aplicáveis' : 'sem processos semelhantes identificados no sistema'}"
}`;

  try {
    const resp = await fetch(OLLAMA_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:OLLAMA_MODEL, prompt, stream:false }) });
    const data = await resp.json();
    const raw  = (data.response || '').trim();
    let ia;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) { try { ia = JSON.parse(jsonMatch[0]); } catch { ia = null; } }
    if (!ia) ia = { categoria:'Análise', situacao_atual:'', resumo:raw, apontamentos:'', sugestoes:'', proximos_passos:'', processos_similares:'' };

    await api('processos/salvar-ia', {
      numero_sei:          sei,
      categoria:           ia.categoria           || '',
      situacao_atual:      ia.situacao_atual       || '',
      resumo_ia:           ia.resumo               || '',
      apontamentos_ia:     ia.apontamentos         || '',
      sugestoes_ia:        ia.sugestoes            || '',
      proximos_passos_ia:  ia.proximos_passos      || '',
      processos_similares_ref: ia.processos_similares || ''
    });
    api('log/registrar', { acao:'ANALISE_IA', numero_sei:sei, detalhes:'Análise completa concluída' });
  } catch(e) { console.warn('Erro na análise IA:', e); }
}

function filtrarBlocos(blocos, keywords, maxChars) {
  if (!blocos.length) return '';
  const pontuados = blocos.map(b => {
    const bl = b.toLowerCase();
    const score = keywords.reduce((acc, k) => acc + (bl.split(k).length - 1), 0);
    return { b, score };
  }).sort((a, b2) => b2.score - a.score);
  let resultado = '';
  for (const { b } of pontuados) {
    if (resultado.length + b.length > maxChars) break;
    resultado += b + '\n---\n';
  }
  return resultado;
}

// ==================== DADOS FIXOS ====================
let _tipos = [], _unidades = [];
async function carregarDadosFixos() {
  const [resT, resU] = await Promise.all([
    api('dados-fixos/listar?categoria=tipo'),
    api('dados-fixos/listar?categoria=unidade')
  ]);
  _tipos    = (resT.itens || []).map(i => i.valor);
  _unidades = resU.itens || [];
}

function optsTipos(sel) {
  const opcoes = _tipos.length ? _tipos : ['Contrato','Convênio','Aditivo','Ata de Registro','Autorização','Outro'];
  return opcoes.map(t => `<option ${sel===t?'selected':''}>${t}</option>`).join('');
}
function optsUnidades(sel) {
  return _unidades.map(u => `<option value="${u.valor}" data-oss="${u.associado||''}" ${sel===u.valor?'selected':''}>${u.valor}</option>`).join('');
}

function tipoSelecionado() {
  // FIX: id correto é w-tipo (não w-tipo-novo)
  const v = document.getElementById('w-tipo')?.value;
  if (v === '__novo__') mostrarNovoTipo();
}
function mostrarNovoTipo() {
  const nome = prompt('Nome do novo tipo:'); if (!nome) return;
  api('dados-fixos/criar', { categoria:'tipo', valor:nome }).then(r => {
    if (r.ok) { _tipos.push(nome); renderWizardStep(); } else alert('Erro: '+r.erro);
  });
}
function excluirTipo(nome) {
  if (!confirm('Excluir tipo "'+nome+'"?')) return;
  api('dados-fixos/listar?categoria=tipo').then(r => {
    const found = (r.itens||[]).find(i => i.valor === nome);
    if (!found) { alert('Tipo não encontrado.'); return; }
    api('dados-fixos/remover', { id:found.id }).then(r2 => {
      if (r2.ok) { _tipos = _tipos.filter(t => t !== nome); renderWizardStep(); }
    });
  });
}

function unidadeSelecionada() {
  const sel = document.getElementById('w-unidade'); if (!sel) return;
  if (sel.value === '__nova__') { mostrarNovaUnidade(); return; }
  const opt = sel.options[sel.selectedIndex];
  const oss = opt?.getAttribute('data-oss') || '';
  const ossEl = document.getElementById('w-oss');
  if (ossEl) ossEl.value = oss;
  // Mostrar processos relacionados à unidade
  mostrarProcessosDaUnidade(sel.value, 'processos-unidade-info');
}

function mostrarNovaUnidade() {
  const unidade = prompt('Nome da Unidade:'); if (!unidade) return;
  const oss = prompt('OSS associada:') || '';
  api('dados-fixos/criar', { categoria:'unidade', valor:unidade, associado:oss }).then(r => {
    if (r.ok) { _unidades.push({ valor:unidade, associado:oss }); renderWizardStep(); } else alert('Erro: '+r.erro);
  });
}

function mostrarProcessosDaUnidade(unidade, containerId) {
  const el = document.getElementById(containerId);
  if (!el || !unidade || !todosProcessos.length) { if(el) el.innerHTML=''; return; }
  const relacionados = todosProcessos.filter(p => p.unidade === unidade && p.status === 'Em andamento');
  if (!relacionados.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div style="margin-top:10px;padding:10px;background:#f0f9ff;border-radius:6px;border:1px solid #bae6fd;">
      <p style="font-size:.78rem;color:#0369a1;margin-bottom:6px;font-weight:600;"><i class="fa fa-info-circle"></i> ${relacionados.length} processo(s) em andamento nesta unidade:</p>
      ${relacionados.map(p => `
        <div style="padding:4px 0;border-bottom:1px solid #e0f2fe;font-size:.78rem;">
          <span style="color:#0369a1;font-weight:600;cursor:pointer;" onclick="fecharModal();abrirProcesso('${p.numero_sei}')">${p.numero_sei}</span>
          — ${p.titulo}
          ${p.situacao_atual ? `<br><span style="color:#64748b;">${p.situacao_atual.substring(0,100)}${p.situacao_atual.length>100?'...':''}</span>` : ''}
        </div>`).join('')}
    </div>`;
}

// ==================== NOVO PROCESSO (WIZARD) ====================
let wizardStep = 1, novoProc = {};

async function renderNovo() {
  wizardStep = 1; novoProc = {};
  await carregarDadosFixos();
  // Garante que todosProcessos esteja carregado mesmo sem passar pelo Dashboard
  if (!todosProcessos.length) {
    const res = await api('processos/listar');
    if (res.ok) todosProcessos = res.processos || [];
  }
  document.getElementById('content').innerHTML = `
  <div style="max-width:680px;margin:0 auto;">
    <div class="wizard-steps" id="wizard-steps">
      <div class="wizard-step active" id="ws1" onclick="irParaEtapa(1)" style="cursor:pointer;">1. Identificação</div>
      <div class="wizard-step" id="ws2" onclick="irParaEtapa(2)" style="cursor:pointer;">2. Detalhes</div>
      <div class="wizard-step" id="ws3" onclick="irParaEtapa(3)" style="cursor:pointer;">3. Documentos</div>
      <div class="wizard-step" id="ws4" onclick="irParaEtapa(4)" style="cursor:pointer;">4. Andamentos</div>
      <div class="wizard-step" id="ws5" onclick="irParaEtapa(5)" style="cursor:pointer;">5. Confirmar</div>
    </div>
    <div id="wizard-body" style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:24px;"></div>
  </div>`;
  renderWizardStep();
}

function renderWizardStep() {
  const body = document.getElementById('wizard-body');
  if (wizardStep === 1) {
    body.innerHTML = `
      <h3 style="margin-bottom:16px;">Identificação do Processo</h3>
      <div class="form-group"><label>Número SEI *</label><input id="w-sei" value="${novoProc.sei||''}" placeholder="Ex: 2300002104.000011/2025-91"></div>
      <div class="form-group"><label>Título / Objeto *</label><input id="w-titulo" value="${novoProc.titulo||''}" placeholder="Descrição resumida do processo"></div>
      <div class="form-group">
        <label>Tipo</label>
        <select id="w-tipo" onchange="tipoSelecionado()">
          ${optsTipos(novoProc.tipo)}
          <option value="__novo__">+ Cadastrar novo tipo...</option>
        </select>
        ${_tipos.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">${_tipos.map(t=>`<span style="background:#f3f4f6;border-radius:4px;padding:2px 8px;font-size:.75rem;">${t}<button onclick="excluirTipo('${t}')" style="background:none;border:none;cursor:pointer;color:#ef4444;margin-left:2px;">✕</button></span>`).join('')}</div>` : ''}
      </div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-primary" onclick="wizardNext()">Próximo <i class="fa fa-arrow-right"></i></button>
      </div>`;
  } else if (wizardStep === 2) {
    body.innerHTML = `
      <h3 style="margin-bottom:16px;">Detalhes do Processo</h3>
      <div class="form-group"><label>Status</label>
        <select id="w-status">${['Em andamento','Aguardando','Concluído','Suspenso'].map(s=>`<option ${novoProc.status===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="form-group"><label>Prioridade</label>
        <select id="w-prioridade">${['Baixa','Média','Alta','Máxima'].map(p=>`<option ${novoProc.prioridade===p?'selected':''}>${p}</option>`).join('')}</select></div>
      <div class="form-group">
        <label>Unidade</label>
        <select id="w-unidade" onchange="unidadeSelecionada()">
          <option value="">— Selecione —</option>${optsUnidades(novoProc.unidade)}
          <option value="__nova__">+ Cadastrar nova unidade/OSS...</option>
        </select>
        <div id="processos-unidade-info"></div>
      </div>
      <div class="form-group"><label>OSS <small style="color:var(--muted);">(preenchida automaticamente)</small></label>
        <input id="w-oss" value="${novoProc.oss||''}" style="background:#f9fafb;"></div>
      <div class="form-group"><label>Descrição</label><textarea id="w-descricao">${novoProc.descricao||''}</textarea></div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-secondary" onclick="wizardPrev()"><i class="fa fa-arrow-left"></i> Voltar</button>
        <button class="btn btn-primary" onclick="wizardNext()">Próximo <i class="fa fa-arrow-right"></i></button></div>`;
    // Se já havia unidade selecionada, mostrar processos relacionados
    if (novoProc.unidade) mostrarProcessosDaUnidade(novoProc.unidade, 'processos-unidade-info');
  } else if (wizardStep === 3) {
    // Documentos detectados pela extensão Chrome
    const extDocs = Array.isArray(novoProc._docListExtensao) ? novoProc._docListExtensao : [];
    const extDocsHtml = extDocs.length > 0 ? `
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
          <span style="font-size:1.1rem;">🤖</span>
          <span style="font-weight:600;color:#15803d;font-size:.9rem;">
            ${extDocs.length} documento(s) detectado(s) pela extensão SEI Monitor
          </span>
          <span style="margin-left:auto;background:#dcfce7;color:#15803d;font-size:.75rem;padding:3px 10px;border-radius:12px;font-weight:500;">
            Indexação automática ✓
          </span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${extDocs.map(function(d) {
            const nome = (typeof d === 'object' ? (d.nome || d.name || '') : String(d)) || 'Documento';
            return `<div style="background:#fff;border:1px solid #bbf7d0;border-radius:6px;padding:9px 12px;font-size:.82rem;display:flex;align-items:center;gap:10px;">
              <span style="color:#6b7280;">📄</span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${nome}">${nome}</span>
              <span style="background:#dcfce7;color:#15803d;font-size:.72rem;padding:2px 8px;border-radius:10px;white-space:nowrap;flex-shrink:0;">✓ será indexado</span>
            </div>`;
          }).join('')}
        </div>
        <p style="font-size:.77rem;color:#6b7280;margin-top:10px;margin-bottom:0;">
          O texto desses documentos será extraído e indexado automaticamente ao salvar o processo.
        </p>
      </div>` : '';

    const manualLabel = extDocs.length > 0
      ? '<div style="font-size:.85rem;color:var(--muted);margin-bottom:8px;">Adicionar outros documentos manualmente (opcional):</div>'
      : '';

    body.innerHTML = `
      <h3 style="margin-bottom:16px;">Documentos</h3>
      ${extDocsHtml}
      ${manualLabel}
      <div class="dropzone" id="dropzone-novo" onclick="document.getElementById('file-novo').click()">
        <i class="fa fa-cloud-upload-alt"></i><p>Arraste documentos ou clique para selecionar</p>
        <p style="font-size:.75rem;color:var(--muted);">PDF, DOCX, XLSX, ZIP, HTML</p></div>
      <input type="file" id="file-novo" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.zip,.html" style="display:none" onchange="novoProc._files=event.target.files;mostrarArquivosSelecionados()">
      <div id="files-selecionados" class="mt-2"></div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-secondary" onclick="wizardPrev()"><i class="fa fa-arrow-left"></i> Voltar</button>
        <button class="btn btn-primary" onclick="wizardNext()">Próximo <i class="fa fa-arrow-right"></i></button></div>`;
    const dz = document.getElementById('dropzone-novo');
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); novoProc._files = e.dataTransfer.files; mostrarArquivosSelecionados(); });
  } else if (wizardStep === 4) {
    body.innerHTML = `
      <h3 style="margin-bottom:16px;">Andamentos Iniciais (opcional)</h3>
      <p style="font-size:.83rem;color:var(--muted);margin-bottom:10px;">Cole o histórico de andamentos do SEI para análise automática.</p>
      <div class="form-group"><textarea id="w-andamentos" rows="10" placeholder="Cole o histórico de andamentos...">${novoProc.andamentos||''}</textarea></div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-secondary" onclick="wizardPrev()"><i class="fa fa-arrow-left"></i> Voltar</button>
        <button class="btn btn-primary" onclick="wizardNext()">Próximo <i class="fa fa-arrow-right"></i></button></div>`;
  } else if (wizardStep === 5) {
    // Campos obrigatórios faltando
    const faltaSEI    = !novoProc.sei;
    const faltaTitulo = !novoProc.titulo;
    const alertaObrig = (faltaSEI || faltaTitulo)
      ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.83rem;color:#dc2626;">
           ⚠️ Preencha os campos obrigatórios antes de salvar:
           ${faltaSEI ? '<br>• Número SEI (<a href="#" onclick="irParaEtapa(1);return false;">Etapa 1</a>)' : ''}
           ${faltaTitulo ? '<br>• Título / Objeto (<a href="#" onclick="irParaEtapa(1);return false;">Etapa 1</a>)' : ''}
         </div>` : '';
    // Aviso de processo já cadastrado
    const jaExiste = todosProcessos.find(p => p.numero_sei === novoProc.sei);
    const alertaDup = (jaExiste && novoProc.sei)
      ? `<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.83rem;color:#92400e;">
           ⚠️ O processo <b>${novoProc.sei}</b> já está monitorado como "<b>${jaExiste.titulo}</b>".
           <br><a href="#" onclick="abrirProcesso('${jaExiste.numero_sei}');showView('dashboard');return false;">Abrir processo existente →</a>
         </div>` : '';
    body.innerHTML = `
      <h3 style="margin-bottom:16px;">Confirmar Cadastro</h3>
      ${alertaObrig}${alertaDup}
      <div style="background:#f9fafb;border-radius:8px;padding:16px;font-size:.85rem;margin-bottom:16px;line-height:1.8;">
        <b>SEI:</b> ${novoProc.sei || '<span style="color:#dc2626">não informado</span>'}<br>
        <b>Título:</b> ${novoProc.titulo || '<span style="color:#dc2626">não informado</span>'}<br>
        <b>Tipo:</b> ${novoProc.tipo||'—'} &nbsp;·&nbsp; <b>Status:</b> ${novoProc.status||'Em andamento'} &nbsp;·&nbsp; <b>Prioridade:</b> ${novoProc.prioridade||'Média'}<br>
        <b>Unidade:</b> ${novoProc.unidade||'—'} &nbsp;·&nbsp; <b>OSS:</b> ${novoProc.oss||'—'}<br>
        <b>Docs manuais:</b> ${novoProc._files ? novoProc._files.length : 0} &nbsp;·&nbsp;
        <b>Docs extensão:</b> ${(novoProc._docListExtensao || []).length} (indexação auto) &nbsp;·&nbsp;
        <b>Andamentos:</b> ${novoProc.andamentos ? novoProc.andamentos.split('\n').length + ' linha(s)' : 'Nenhum'}
      </div>
      <div id="novo-status"></div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-secondary" onclick="wizardPrev()"><i class="fa fa-arrow-left"></i> Voltar</button>
        <button class="btn btn-success" onclick="cadastrarProcesso()" ${(faltaSEI||faltaTitulo)?'disabled title="Preencha SEI e Título primeiro"':''}>
          <i class="fa fa-save"></i> Cadastrar Processo
        </button>
      </div>`;
  }
  for (let i = 1; i <= 5; i++) {
    const ws = document.getElementById('ws'+i);
    if (ws) ws.className = 'wizard-step' + (i < wizardStep ? ' done' : i === wizardStep ? ' active' : '');
  }
}

// Salva os dados do campo atual em novoProc (sem validar)
function salvarEtapaAtual() {
  if (wizardStep === 1) {
    novoProc.sei    = (document.getElementById('w-sei')?.value    || '').trim();
    novoProc.titulo = (document.getElementById('w-titulo')?.value || '').trim();
    novoProc.tipo   = document.getElementById('w-tipo')?.value    || '';
    if (novoProc.tipo === '__novo__') novoProc.tipo = '';
  } else if (wizardStep === 2) {
    novoProc.status    = document.getElementById('w-status')?.value      || 'Em andamento';
    novoProc.prioridade = document.getElementById('w-prioridade')?.value || 'Média';
    novoProc.unidade   = document.getElementById('w-unidade')?.value     || '';
    if (novoProc.unidade === '__nova__') novoProc.unidade = '';
    novoProc.oss       = (document.getElementById('w-oss')?.value.trim()       || '');
    novoProc.descricao = (document.getElementById('w-descricao')?.value.trim() || '');
  } else if (wizardStep === 4) {
    novoProc.andamentos = (document.getElementById('w-andamentos')?.value.trim() || '');
  }
}

// Navega para qualquer etapa (clique no indicador ou botões Voltar/Próximo)
function irParaEtapa(n) {
  salvarEtapaAtual();
  wizardStep = Math.max(1, Math.min(n, 5));
  renderWizardStep();
}

function wizardNext() { irParaEtapa(wizardStep + 1); }
function wizardPrev() { irParaEtapa(wizardStep - 1); }

function mostrarArquivosSelecionados() {
  const el = document.getElementById('files-selecionados');
  if (!novoProc._files || !novoProc._files.length) { el.innerHTML = ''; return; }
  el.innerHTML = Array.from(novoProc._files).map(f =>
    `<div class="doc-item"><i class="${iconDoc(f.name)}"></i><span>${f.name}</span><span class="doc-meta">${formatarTamanho(f.size)}</span></div>`
  ).join('');
}

async function cadastrarProcesso() {
  // Garante que os dados da etapa atual estão salvos
  salvarEtapaAtual();

  // Validação dos campos obrigatórios
  if (!novoProc.sei || !novoProc.titulo) {
    const statusEl = document.getElementById('novo-status');
    if (statusEl) statusEl.innerHTML = '<div class="alert alert-danger">⚠️ Preencha o Número SEI e o Título antes de salvar.</div>';
    irParaEtapa(1);
    return;
  }

  const statusEl = document.getElementById('novo-status');
  statusEl.innerHTML = '<span class="spinner"></span> Cadastrando processo...';

  const res = await api('processos/criar', {
    numero_sei: novoProc.sei, titulo: novoProc.titulo, tipo: novoProc.tipo,
    status: novoProc.status, prioridade: novoProc.prioridade,
    unidade: novoProc.unidade, oss: novoProc.oss, descricao: novoProc.descricao
  });
  if (!res.ok) { statusEl.innerHTML = `<div class="alert alert-danger">${res.erro}</div>`; return; }
  api('log/registrar', { acao:'CRIAR_PROCESSO', numero_sei:novoProc.sei, detalhes:novoProc.titulo });

  if (novoProc._files && novoProc._files.length > 0) {
    statusEl.innerHTML = '<span class="spinner"></span> Importando documentos...';
    for (const file of Array.from(novoProc._files)) {
      try {
        const buf  = await file.arrayBuffer();
        const hash = await sha256Buf(buf);
        const texto = await extrairTexto(file, buf);
        const codigoSEI = extrairCodigoSEI(file.name);
        const crcSEI    = texto ? extrairCRCSEI(texto) : null;
        if (texto && file.name.toLowerCase().match(/\.html?/)) {
          const db = extrairUrlBaseSEI(texto);
          if (db) localStorage.setItem('sei_base_url', db);
        }
        const linkVerificacao = buildLinkVerificacao(null, codigoSEI, crcSEI);
        const resReg = await api('documentos/registrar', {
          numero_sei: novoProc.sei, nome_arquivo: file.name,
          hash_arquivo: hash, tamanho: file.size, link_verificacao: linkVerificacao || ''
        });
        if (resReg.ok && texto) await salvarBlocosSheets(novoProc.sei, resReg.doc_id, file.name, texto);
      } catch(e) { console.warn('Erro ao importar', file.name, e); }
    }
  }

  if (novoProc.andamentos) {
    statusEl.innerHTML = '<span class="spinner"></span> Indexando andamentos...';
    await api('andamentos/indexar', { sei: novoProc.sei, texto: novoProc.andamentos });
    statusEl.innerHTML = '<span class="spinner"></span> Gerando resumo de andamentos...';
    await gerarResumoAndamentos(novoProc.sei);
  }

  // ── Documentos da extensão Chrome (extraídos via ZIP pelo backend) ──
  const docsExt = await api('extensao/recuperar-docs?sei=' + encodeURIComponent(novoProc.sei));
  const listaDocsExt = Array.isArray(docsExt.documentos) ? docsExt.documentos : [];
  if (docsExt.ok && listaDocsExt.length > 0) {
    statusEl.innerHTML = `<span class="spinner"></span> Indexando ${listaDocsExt.length} documento(s) da extensão...`;
    for (const doc of listaDocsExt) {
      try {
        const texto = (typeof doc.texto === 'string') ? doc.texto : '';
        // Registra o doc mesmo sem texto (nome aparece na aba Documentos)
        const resReg = await api('documentos/registrar', {
          numero_sei: novoProc.sei, nome_arquivo: doc.nome,
          hash_arquivo: '', tamanho: texto.length, link_verificacao: ''
        });
        // Salva blocos de conteúdo apenas se há texto suficiente
        if (texto.length >= 20) {
          const idParaSalvar = (resReg.ok && resReg.doc_id)
            ? resReg.doc_id
            : ('ext_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
          await salvarBlocosSheets(novoProc.sei, idParaSalvar, doc.nome, texto);
        }
      } catch(eDoc) { console.warn('Erro ao indexar doc:', doc.nome, eDoc); }
    }
  }

  if (novoProc._files?.length || novoProc.andamentos || (docsExt.documentos && docsExt.documentos.length)) {
    statusEl.innerHTML = '<span class="spinner"></span> Gerando análise de IA...';
    await acionarIA(novoProc.sei);
  }

  statusEl.innerHTML = '<div class="alert alert-success"><i class="fa fa-check"></i> Processo cadastrado com sucesso!</div>';
  setTimeout(() => abrirProcesso(novoProc.sei), 1500);
}

// ==================== ADMIN ====================
async function renderAdmin() {
  if (usuarioAtual?.perfil !== 'admin') { document.getElementById('content').innerHTML = '<div class="alert alert-danger">Acesso negado.</div>'; return; }
  document.getElementById('content').innerHTML = `
  <div class="tabs">
    <div class="tab active" onclick="switchTabAdmin(this,'adm-usuarios')">Usuários</div>
    <div class="tab" onclick="switchTabAdmin(this,'adm-config')">Configurações</div>
    <div class="tab" onclick="switchTabAdmin(this,'adm-dados')">Dados Fixos</div>
    <div class="tab" onclick="switchTabAdmin(this,'adm-bases')">Bases Legais</div>
    <div class="tab" onclick="switchTabAdmin(this,'adm-logs')">Logs</div>
  </div>
  <div id="adm-usuarios"><span class="spinner"></span> Carregando...</div>
  <div id="adm-config" class="hidden"><span class="spinner"></span></div>
  <div id="adm-dados" class="hidden"><span class="spinner"></span></div>
  <div id="adm-bases" class="hidden"><span class="spinner"></span></div>
  <div id="adm-logs" class="hidden"><span class="spinner"></span></div>`;
  carregarAdmUsuarios();
}

function switchTabAdmin(el, id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['adm-usuarios','adm-config','adm-dados','adm-bases','adm-logs'].forEach(t => {
    const e = document.getElementById(t);
    if (e) e.classList.toggle('hidden', t !== id);
  });
  if (id==='adm-config') carregarAdmConfig();
  else if (id==='adm-dados') carregarAdmDados();
  else if (id==='adm-bases') carregarAdmBases();
  else if (id==='adm-logs') carregarAdmLogs();
}

async function carregarAdmUsuarios() {
  const el = document.getElementById('adm-usuarios');
  const res = await api('usuarios/listar');
  if (!res.ok) { el.innerHTML = `<div class="alert alert-danger">${res.erro}</div>`; return; }
  el.innerHTML = `
  <div class="flex justify-between items-center mt-2" style="margin-bottom:12px;">
    <h3 style="font-size:.95rem;">Usuários (${(res.usuarios||[]).length})</h3>
    <button class="btn btn-primary btn-sm" onclick="mostrarNovoUsuario()"><i class="fa fa-plus"></i> Novo Usuário</button>
  </div>
  <table class="admin-table">
    <thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Status</th><th>Ações</th></tr></thead>
    <tbody>${(res.usuarios||[]).map(u=>`
      <tr><td>${u.nome}</td><td>${u.usuario}</td>
      <td><span class="badge-status">${u.perfil}</span></td>
      <td><span class="badge-status">${u.ativo!==false?'Ativo':'Inativo'}</span></td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="mostrarResetSenha('${u.usuario}')"><i class="fa fa-key"></i></button>
        <button class="btn btn-danger btn-sm" onclick="removerUsuario('${u.usuario}')"><i class="fa fa-trash"></i></button>
      </td></tr>`).join('')}
    </tbody></table>`;
}

function mostrarNovoUsuario() {
  criarModal(`
    <h2>Novo Usuário</h2>
    <div class="form-group"><label>Nome</label><input id="nu-nome"></div>
    <div class="form-group"><label>Usuário (nome.sobrenome)</label><input type="text" id="nu-email" placeholder="ex: ivson.galvao" autocapitalize="none"></div>
    <div class="form-group"><label>Senha</label><input type="password" id="nu-senha"></div>
    <div class="form-group"><label>Perfil</label><select id="nu-perfil"><option value="usuario">Usuário</option><option value="admin">Admin</option></select></div>
    <div id="nu-err" class="hidden alert alert-danger"></div>
    <div class="flex gap-2"><button class="btn btn-primary" onclick="criarUsuario()">Criar</button><button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button></div>`);
}

async function criarUsuario() {
  const nome    = document.getElementById('nu-nome').value.trim();
  const usuario = document.getElementById('nu-email').value.trim().toLowerCase();
  const senha   = document.getElementById('nu-senha').value;
  const perfil  = document.getElementById('nu-perfil').value;
  const errEl   = document.getElementById('nu-err');
  if (!nome||!usuario||!senha) { errEl.textContent='Preencha todos os campos.'; errEl.classList.remove('hidden'); return; }
  if (!/^[a-z]+\.[a-z]+/.test(usuario)) { errEl.textContent='Usuário deve ser no formato nome.sobrenome.'; errEl.classList.remove('hidden'); return; }
  const senhaHash = await sha256(senha);
  const res = await api('usuarios/criar', { nome, usuario, senha:senhaHash, perfil });
  if (!res.ok) { errEl.textContent=res.erro; errEl.classList.remove('hidden'); return; }
  fecharModal(); carregarAdmUsuarios();
}

function mostrarResetSenha(usuario) {
  criarModal(`
    <h2>Redefinir Senha</h2>
    <p style="margin-bottom:12px;font-size:.85rem;">Usuário: <b>${usuario}</b></p>
    <div class="form-group"><label>Nova Senha</label><input type="password" id="ns-senha"></div>
    <div class="flex gap-2">
      <button class="btn btn-warning" onclick="resetarSenha('${usuario}')">Redefinir</button>
      <button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button></div>`);
}
async function resetarSenha(usuario) {
  const senha = document.getElementById('ns-senha').value;
  if (!senha) { alert('Digite a nova senha.'); return; }
  const res = await api('usuarios/reset-senha', { usuario, senha: await sha256(senha) });
  if (res.ok) { fecharModal(); alert('Senha redefinida.'); } else alert('Erro: '+res.erro);
}
async function removerUsuario(usuario) {
  if (!confirm(`Remover usuário ${usuario}?`)) return;
  const res = await api('usuarios/remover', { usuario });
  if (res.ok) carregarAdmUsuarios(); else alert('Erro: '+res.erro);
}

async function carregarAdmConfig() {
  const el  = document.getElementById('adm-config');
  const res = await api('config/listar');
  const cfg = res.config || {};
  el.innerHTML = `
  <h3 style="font-size:.95rem;margin:12px 0;">Configurações do Sistema</h3>
  <div class="form-group"><label>Modelo Ollama</label><input id="cfg-ollama" value="${OLLAMA_MODEL}" placeholder="llama3.2:3b"></div>
  <div id="cfg-status" class="hidden alert alert-success">Configurações salvas.</div>
  <button class="btn btn-primary" onclick="salvarConfig()"><i class="fa fa-save"></i> Salvar</button>`;
}
async function salvarConfig() {
  const ollama = document.getElementById('cfg-ollama').value.trim();
  if (ollama) { OLLAMA_MODEL = ollama; localStorage.setItem('ollama_model', ollama); }
  const s = document.getElementById('cfg-status');
  s.classList.remove('hidden');
  setTimeout(() => s.classList.add('hidden'), 3000);
}

async function carregarAdmDados() {
  const el = document.getElementById('adm-dados');
  await carregarDadosFixos();
  const [resT, resU] = await Promise.all([
    api('dados-fixos/listar?categoria=tipo'),
    api('dados-fixos/listar?categoria=unidade')
  ]);
  const tipos    = resT.itens || [];
  const unidades = resU.itens || [];
  el.innerHTML = `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:12px;">
    <div>
      <div class="flex justify-between items-center" style="margin-bottom:10px;">
        <h3 style="font-size:.95rem;">Tipos de Processo</h3>
        <button class="btn btn-primary btn-sm" onclick="mostrarNovoTipoAdmin()"><i class="fa fa-plus"></i> Novo</button>
      </div>
      <table class="admin-table"><thead><tr><th>Tipo</th><th></th></tr></thead><tbody>
        ${tipos.map(t=>`<tr><td>${t.valor}</td><td><button class="btn btn-danger btn-sm" onclick="removerDadoFixo('${t.id}','adm-dados')"><i class="fa fa-trash"></i></button></td></tr>`).join()||'<tr><td colspan="2" class="text-muted">Nenhum.</td></tr>'}
      </tbody></table>
    </div>
    <div>
      <div class="flex justify-between items-center" style="margin-bottom:10px;">
        <h3 style="font-size:.95rem;">Unidades / OSS</h3>
        <button class="btn btn-primary btn-sm" onclick="mostrarNovaUnidadeAdmin()"><i class="fa fa-plus"></i> Nova</button>
      </div>
      <table class="admin-table"><thead><tr><th>Unidade</th><th>OSS</th><th></th></tr></thead><tbody>
        ${unidades.map(u=>`<tr><td>${u.valor}</td><td>${u.associado||'—'}</td><td><button class="btn btn-danger btn-sm" onclick="removerDadoFixo('${u.id}','adm-dados')"><i class="fa fa-trash"></i></button></td></tr>`).join()||'<tr><td colspan="3" class="text-muted">Nenhuma.</td></tr>'}
      </tbody></table>
    </div>
  </div>`;
}

function mostrarNovoTipoAdmin() {
  criarModal(`<h2>Novo Tipo de Processo</h2>
    <div class="form-group"><label>Nome do tipo</label><input id="nt-nome" placeholder="Ex: Contrato, Aditivo..."></div>
    <div class="flex gap-2"><button class="btn btn-primary" onclick="salvarNovoTipoAdmin()">Salvar</button><button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button></div>`);
}
async function salvarNovoTipoAdmin() {
  const nome = document.getElementById('nt-nome').value.trim();
  if (!nome) { alert('Informe o nome.'); return; }
  const r = await api('dados-fixos/criar', { categoria:'tipo', valor:nome });
  if (r.ok) { fecharModal(); await carregarDadosFixos(); carregarAdmDados(); } else alert('Erro: '+r.erro);
}

function mostrarNovaUnidadeAdmin() {
  criarModal(`<h2>Nova Unidade / OSS</h2>
    <div class="form-group"><label>Nome da Unidade</label><input id="nu2-unidade" placeholder="Ex: UPA Centro"></div>
    <div class="form-group"><label>OSS Associada</label><input id="nu2-oss" placeholder="Ex: Sociedade XYZ"></div>
    <div class="flex gap-2"><button class="btn btn-primary" onclick="salvarNovaUnidadeAdmin()">Salvar</button><button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button></div>`);
}
async function salvarNovaUnidadeAdmin() {
  const unidade = document.getElementById('nu2-unidade').value.trim();
  const oss     = document.getElementById('nu2-oss').value.trim();
  if (!unidade) { alert('Informe a unidade.'); return; }
  const r = await api('dados-fixos/criar', { categoria:'unidade', valor:unidade, associado:oss });
  if (r.ok) { fecharModal(); await carregarDadosFixos(); carregarAdmDados(); } else alert('Erro: '+r.erro);
}

async function removerDadoFixo(id, recarregar) {
  if (!confirm('Remover este item?')) return;
  const r = await api('dados-fixos/remover', { id });
  if (r.ok) { await carregarDadosFixos(); if (recarregar==='adm-dados') carregarAdmDados(); }
  else alert('Erro: '+r.erro);
}

async function carregarAdmBases() {
  const el  = document.getElementById('adm-bases');
  const res = await api('bases-legais/status');
  el.innerHTML = `
  <div class="alert alert-info" style="margin-bottom:16px;"><i class="fa fa-info-circle"></i> Importe documentos com leis, contratos-modelo, normativas e regulamentos de OSS para enriquecer as análises da IA.</div>
  <div style="background:#f9fafb;border-radius:8px;padding:14px;margin-bottom:16px;font-size:.85rem;">
    <b>Blocos armazenados:</b> ${res.total_blocos||0} — <b>Documentos:</b> ${res.total_docs||0}
  </div>
  <div class="dropzone" id="dz-bases" onclick="document.getElementById('file-bases').click()">
    <i class="fa fa-balance-scale"></i><p>Arraste documentos de bases legais</p><p style="font-size:.75rem;color:var(--muted);">DOCX, PDF, HTML</p></div>
  <input type="file" id="file-bases" multiple accept=".pdf,.doc,.docx,.html" style="display:none" onchange="importarBasesLegais(event.target.files)">
  <div id="bases-progress" class="upload-progress mt-2"></div>
  <div style="margin-top:12px;">
    <button class="btn btn-danger btn-sm" onclick="limparBasesLegais()"><i class="fa fa-trash"></i> Limpar todas as bases legais</button>
  </div>`;
  const dz = document.getElementById('dz-bases');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); importarBasesLegais(e.dataTransfer.files); });
}

async function importarBasesLegais(files) {
  const prog = document.getElementById('bases-progress');
  for (const file of Array.from(files)) {
    addProgItem(prog, file.name, 'proc', 'Extraindo texto...');
    try {
      const buf   = await file.arrayBuffer();
      const texto = await extrairTexto(file, buf);
      if (!texto || texto.trim().length < 50) { updateProgItem(prog, file.name, 'err', 'Sem texto extraído'); continue; }
      const blocos = dividirEmBlocos(texto, BLOCO_MAX);
      for (let i = 0; i < blocos.length; i++) {
        await api('bases-legais/salvar', { doc_nome:file.name, bloco_num:i+1, total_blocos:blocos.length, conteudo:blocos[i] });
      }
      api('log/registrar', { acao:'IMPORTAR_BASE_LEGAL', numero_sei:'', detalhes:file.name });
      updateProgItem(prog, file.name, 'ok', `${blocos.length} bloco(s) salvos`);
    } catch(e) { updateProgItem(prog, file.name, 'err', 'Erro: '+e.message); }
  }
}

async function limparBasesLegais() {
  if (!confirm('Isso removerá TODAS as bases legais. Confirmar?')) return;
  const res = await api('bases-legais/limpar', {});
  if (res.ok) { alert('Bases legais removidas.'); carregarAdmBases(); } else alert('Erro: '+res.erro);
}

async function carregarAdmLogs() {
  const el  = document.getElementById('adm-logs');
  const res = await api('log/listar');
  const logs = res.logs || [];
  el.innerHTML = `
  <h3 style="font-size:.95rem;margin:12px 0;">Log de Ações (últimas ${logs.length})</h3>
  <table class="admin-table">
    <thead><tr><th>Data/Hora</th><th>Usuário</th><th>Ação</th><th>SEI</th><th>Detalhes</th></tr></thead>
    <tbody>${logs.map(l=>`
      <tr>
        <td style="white-space:nowrap;">${formatarDataHora(l.data_hora)}</td>
        <td>${l.usuario_nome||'—'}</td>
        <td><code style="font-size:.78rem;">${l.acao||''}</code></td>
        <td>${l.numero_sei||'—'}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${l.detalhes||''}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

// ==================== CHAT FLUTUANTE ====================
function toggleChat() { document.getElementById('chat-panel').classList.toggle('open'); }

async function enviarChat() {
  const input = document.getElementById('chat-input');
  const msg   = input.value.trim(); if (!msg) return;
  input.value = '';
  const msgs  = document.getElementById('chat-msgs');
  msgs.innerHTML += `<div class="chat-msg user">${msg}</div>`;
  msgs.scrollTop = msgs.scrollHeight;

  const loadMsg = document.createElement('div');
  loadMsg.className = 'chat-msg ai';
  loadMsg.innerHTML = '<span class="spinner"></span>';
  msgs.appendChild(loadMsg);
  msgs.scrollTop = msgs.scrollHeight;

  try {
    const ollamaOk = await testarOllama();
    if (!ollamaOk) { loadMsg.textContent = 'IA não disponível. Verifique se o Ollama está rodando.'; return; }

    // Extrai palavras-chave da pergunta
    const keywords = msg.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    // Busca processos relevantes no cache local
    const relevantes = todosProcessos.filter(p =>
      keywords.some(k =>
        (p.numero_sei + ' ' + p.titulo + ' ' + (p.situacao_atual||'') + ' ' + (p.unidade||'') + ' ' + (p.oss||'') + ' ' + (p.tipo||'')).toLowerCase().includes(k)
      )
    ).slice(0, 2);

    let ctx = '';

    if (relevantes.length > 0) {
      // Carrega dados completos dos processos mais relevantes
      for (const p of relevantes) {
        const [resA, resAnot, resConteudo] = await Promise.all([
          api('andamentos/listar?sei=' + p.numero_sei),
          api('anotacoes/listar?sei=' + p.numero_sei),
          api('conteudo/listar?sei=' + p.numero_sei)
        ]);
        ctx += `\n=== PROCESSO SEI ${p.numero_sei} ===\n`;
        ctx += `TÍTULO: ${p.titulo}\n`;
        ctx += `TIPO: ${p.tipo||'—'} | STATUS: ${p.status} | PRIORIDADE: ${p.prioridade}\n`;
        ctx += `UNIDADE: ${p.unidade||'—'} | OSS: ${p.oss||'—'}\n`;
        if (p.situacao_atual) ctx += `SITUAÇÃO ATUAL: ${p.situacao_atual}\n`;
        if (p.resumo_ia)      ctx += `ANÁLISE IA: ${p.resumo_ia}\n`;
        if (p.apontamentos_ia) ctx += `APONTAMENTOS: ${p.apontamentos_ia}\n`;

        const andamentos = (resA.andamentos || []).slice(-5);
        if (andamentos.length) {
          ctx += 'ÚLTIMOS ANDAMENTOS:\n';
          andamentos.forEach(a => ctx += `- ${formatarDataGAS(a.data_movimento)}: ${a.descricao||''}\n`);
        }
        const anots = (resAnot.anotacoes || []).slice(-3);
        if (anots.length) {
          ctx += 'ANOTAÇÕES DE GESTÃO:\n';
          anots.forEach(a => ctx += `- ${a.texto||''}\n`);
        }
        const blocos = (resConteudo.blocos || []).slice(0, 2);
        if (blocos.length) ctx += 'CONTEÚDO DOCS (trecho):\n' + blocos[0].conteudo?.substring(0, 800) + '\n';
      }
    } else {
      // Sem match específico: visão geral dos processos
      ctx = 'PROCESSOS MONITORADOS:\n' + todosProcessos.slice(0, 12).map(p =>
        `SEI ${p.numero_sei}: ${p.titulo} (${p.status}, ${p.prioridade}, Unidade: ${p.unidade||'—'}) — ${p.situacao_atual||p.resumo_ia||''}`
      ).join('\n');
    }

    // Inclui amostra de bases legais relevantes
    const resBases = await api('bases-legais/listar');
    const basesBlocos = (resBases.blocos || []).slice(0, 2).map(b => b.conteudo?.substring(0, 600)).join('\n');

    const prompt = `Você é um ESPECIALISTA em gestão de contratos, processos administrativos e regulação de Organizações Sociais de Saúde (OSS) no setor público brasileiro.
Tem profundo conhecimento em: Lei 9.637/98 (OS), contratos de gestão, licitações na saúde, fiscalização contratual, metas assistenciais e normativas do SUS.

DADOS DO SISTEMA SEI MONITOR:
${ctx}

${basesBlocos ? 'BASES LEGAIS DISPONÍVEIS:\n' + basesBlocos : ''}

PERGUNTA: ${msg}

Responda em português, de forma objetiva e especializada.
- Se a pergunta mencionar um processo específico e ele estiver nos dados, analise com detalhes
- Consulte as bases legais quando pertinente para fundamentar sua resposta
- Se não encontrar o processo mencionado, informe e ofereça uma análise geral do contexto disponível
- Máx 300 palavras`;

    const resp = await fetch(OLLAMA_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:OLLAMA_MODEL, prompt, stream:false }) });
    const data = await resp.json();
    loadMsg.textContent = data.response || 'Sem resposta.';
  } catch(e) { loadMsg.textContent = 'Erro ao contatar IA: ' + e.message; }
  msgs.scrollTop = msgs.scrollHeight;
}

// ==================== OLLAMA ====================
async function testarOllama() {
  try { const r = await fetch('http://localhost:11434/api/tags', { signal:AbortSignal.timeout(3000) }); return r.ok; }
  catch { return false; }
}
async function verificarOllama() {
  const dot = document.getElementById('ai-dot'), txt = document.getElementById('ai-status-txt');
  if (!dot) return;
  const ok = await testarOllama();
  dot.className = 'ai-dot ' + (ok ? 'on' : 'off');
  txt.textContent = ok ? 'IA Local ativa' : 'IA não detectada';
}

// ==================== MODAL ====================
function criarModal(html) {
  fecharModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay'; overlay.id = 'modal-overlay';
  overlay.onclick = e => { if (e.target === overlay) fecharModal(); };
  const modal = document.createElement('div');
  modal.className = 'modal'; modal.innerHTML = html;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  return overlay;
}
function fecharModal() { const m = document.getElementById('modal-overlay'); if (m) m.remove(); }

// ==================== UTILS ====================
async function sha256(text) { const buf = new TextEncoder().encode(text); return sha256Hex(await crypto.subtle.digest('SHA-256',buf)); }
async function sha256Buf(buf) { return sha256Hex(await crypto.subtle.digest('SHA-256', buf)); }
function sha256Hex(hashBuf) { return Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join(''); }

function horasDesdeData(dataStr) {
  if (!dataStr) return 9999;
  const d = new Date(dataStr);
  if (isNaN(d)) return 9999;
  return (Date.now() - d.getTime()) / 3600000;
}

// Formata datas normais (ISO string)
function formatarData(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('pt-BR');
}

// Formata data mas retorna '—' para strings inválidas (evita mostrar textos como "Máxima")
function formatarDataSeguro(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('pt-BR');
}

// Formata datas vindas do Google Sheets (que podem ter epoch diferente para valores de hora)
function formatarDataGAS(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  // Sheets armazena datas com hora 03:00 UTC (fuso BR) — mostra apenas a data
  return d.toLocaleDateString('pt-BR');
}

// Formata horas vindas do Sheets (epoch 1899-12-30 para valores de hora-apenas)
function formatarHoraGAS(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return String(s);
  // Extrai apenas HH:MM
  return d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
}

function formatarDataHora(s) {
  if (!s) return '—';
  const d = new Date(s); if (isNaN(d)) return String(s);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}
function formatarTamanho(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k,i)).toFixed(1)) + ' ' + sizes[i];
}
function iconDoc(nome) {
  const ext = (nome||'').split('.').pop().toLowerCase();
  return { pdf:'fa fa-file-pdf', doc:'fa fa-file-word', docx:'fa fa-file-word',
    xls:'fa fa-file-excel', xlsx:'fa fa-file-excel', html:'fa fa-file-code',
    htm:'fa fa-file-code', zip:'fa fa-file-archive' }[ext] || 'fa fa-file';
}
