// ============================================================
// SEI Monitor v2.1 — app.js
// ============================================================

// ==================== CONFIG ====================
const LIMITE_HORAS = { 'Máxima': 2, 'Alta': 24, 'Média': 48, 'Baixa': 96 };
const OLLAMA_URL   = 'http://localhost:11434/api/generate';
let   OLLAMA_MODEL = localStorage.getItem('ollama_model') || 'llama3.2:3b';
const BLOCO_MAX    = 49000;
const RELEVANCIA_MAX_CHARS = 25000;

// ==================== STATE ====================
let API_URL       = '';
let sessao        = null;
let usuarioAtual  = null;
let todosProcessos = [];

// ==================== INIT ====================
window.onload = () => {
  API_URL = localStorage.getItem('sei_api_url') || '';
  if (API_URL) document.getElementById('api-url-input').value = API_URL;
  verificarOllama();
};

// ==================== API ====================
// FIX: detecta resposta HTML (página de erro/proteção do GAS) e exibe mensagem amigável
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
    // Resposta não é JSON — provavelmente página HTML de erro ou proteção
    const isHtml = text.trimStart().startsWith('<');
    if (isHtml) {
      console.error('API retornou HTML em vez de JSON:', text.substring(0, 300));
      return { ok: false, erro: 'O servidor retornou uma resposta inesperada. Verifique se a URL do Apps Script está correta e tente novamente.' };
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
}

function iniciarApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('sidebar-nome').textContent  = usuarioAtual.nome;
  document.getElementById('sidebar-email').textContent = usuarioAtual.usuario;
  if (usuarioAtual.perfil === 'admin') document.getElementById('nav-admin').classList.remove('hidden');
  carregarDadosFixos();
  showView('dashboard');
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
  if (!res.ok) { content.innerHTML = `<div class="alert alert-danger">${res.erro || 'Erro ao carregar processos.'}</div>`; return; }
  todosProcessos = res.processos || [];
  content.innerHTML = '';

  const rgBox = document.createElement('div');
  rgBox.id = 'resumo-geral-container';
  rgBox.innerHTML = '<div class="resumo-geral-box" style="opacity:.5;"><div class="rg-header"><h3><i class="fa fa-brain" style="color:var(--primary);"></i> Resumo do Período</h3></div><div class="rg-content text-muted"><span class="spinner"></span> Verificando resumo...</div></div>';
  content.appendChild(rgBox);

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
  lista.forEach(p => grid.appendChild(criarCard(p)));
}

function criarCard(p) {
  const sei = p.numero_sei;  // FIX: era p.numero_sei || p.sei
  const div = document.createElement('div');
  div.className = 'process-card';
  const horas  = horasDesdeData(p.data_atualizacao || p.data_cadastro);
  const limite = LIMITE_HORAS[p.prioridade] || 96;
  const atrasado = horas > limite;
  if (atrasado) {
    if (p.prioridade === 'Máxima') div.classList.add('alerta-maxima');
    else if (p.prioridade === 'Alta')  div.classList.add('alerta-alta');
    else if (p.prioridade === 'Média') div.classList.add('alerta-media');
  }
  const priBadge = (p.prioridade || '').replace('á','a').replace('é','e');
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div class="sei-num">SEI: ${sei}</div>
      <button onclick="deletarProcessoCard(event,'${sei}')" title="Excluir processo"
        style="background:none;border:none;cursor:pointer;color:#d1d5db;font-size:.85rem;padding:0;">
        <i class="fa fa-trash"></i>
      </button>
    </div>
    <div class="titulo">${p.titulo}</div>
    ${p.situacao_atual ? `<div class="situacao">${p.situacao_atual}</div>` : ''}
    ${p.ultimo_andamento_resumo ? `<div class="ultimo-and"><i class="fa fa-clock" style="margin-right:4px;color:var(--muted);"></i>${p.ultimo_andamento_resumo}${p.ultimo_andamento_data ? ' <small>('+formatarData(p.ultimo_andamento_data)+')</small>' : ''}</div>` : ''}
    <div class="card-footer">
      <span class="badge-prioridade ${priBadge}">${p.prioridade}</span>
      <span class="badge-status">${p.status}</span>
      ${atrasado ? `<span style="color:${p.prioridade==='Máxima'?'#7c3aed':p.prioridade==='Alta'?'#dc2626':'#ca8a04'};font-size:.72rem;font-weight:600;">⚠ Atrasado</span>` : ''}
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
  const lista  = todosProcessos.slice(0, 20).map(p =>
    `SEI ${p.numero_sei}: ${p.titulo} (${p.status}, ${p.prioridade}) — ${p.situacao_atual || 'sem situação atual'}`
  ).join('\n');
  const turno  = periodo === 'manha' ? 'manhã' : 'tarde';
  const prompt = `Você é analista de processos administrativos de uma Organização Social de Saúde.\nGere um resumo gerencial de ${turno} sobre os processos abaixo. Identifique prioridades críticas, processos em risco e pontos de atenção.\nSeja objetivo, máx 300 palavras.\n\nPROCESSOS:\n${lista}\n\nRESUMO GERENCIAL DE ${turno.toUpperCase()}:`;
  try {
    const resp = await fetch(OLLAMA_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:OLLAMA_MODEL, prompt, stream:false }) });
    const data = await resp.json();
    await api('resumo-geral/salvar', { periodo, conteudo: data.response || '' });
  } catch(e) { console.warn('Erro ao gerar resumo geral:', e); }
}

async function renderResumoGeral(container) {
  const periodo = getPeriodo(); if (!periodo) { container.innerHTML = ''; return; }
  const res    = await api('resumo-geral/obter?periodo=' + periodo);
  const turno  = periodo === 'manha' ? '🌅 Resumo da Manhã' : '🌇 Resumo da Tarde';
  const conteudo = res.ok && res.resumo ? res.resumo.conteudo : null;
  const horario  = res.ok && res.resumo ? res.resumo.data_hora : null;
  container.innerHTML = `
  <div class="resumo-geral-box">
    <div class="rg-header">
      <h3><i class="fa fa-brain" style="color:var(--primary);"></i> ${turno}</h3>
      <span class="rg-meta">${horario ? 'Gerado às '+formatarDataHora(horario) : 'Aguardando geração...'}</span>
    </div>
    <div class="rg-content">${conteudo || '<span class="text-muted">Resumo ainda não gerado para este período.</span>'}</div>
  </div>`;
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
  const proc        = resP.processo;
  const andamentos  = resA.andamentos  || [];
  const documentos  = resD.documentos  || [];
  const anotacoes   = resAnot.anotacoes || [];
  const verificacoes = resVer.verificacoes || [];

  content.innerHTML = `
  <div style="margin-bottom:16px;">
    <button class="btn btn-secondary btn-sm" onclick="showView('dashboard')"><i class="fa fa-arrow-left"></i> Voltar</button>
  </div>
  <div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px;">
    <div class="flex justify-between items-center" style="margin-bottom:12px;">
      <div>
        <div style="font-size:.75rem;color:var(--muted);font-weight:600;">SEI: ${proc.numero_sei}</div>
        <h2 style="font-size:1.1rem;margin-top:2px;">${proc.titulo}</h2>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <span class="badge-prioridade ${(proc.prioridade||'').replace('á','a').replace('é','e')}">${proc.prioridade}</span>
        <span class="badge-status">${proc.status}</span>
        ${proc.link_sei
          ? `<span style="display:inline-flex;gap:4px;">
               <a href="${proc.link_sei}" target="_blank" class="btn btn-secondary btn-sm" title="Abrir processo no SEI"><i class="fa fa-external-link-alt"></i> Abrir no SEI</a>
               <button class="btn btn-secondary btn-sm" onclick="definirLinkSEI('${sei}')" title="Atualizar link SEI" style="padding:4px 8px;"><i class="fa fa-sync-alt"></i></button>
             </span>`
          : `<button class="btn btn-secondary btn-sm" onclick="definirLinkSEI('${sei}')"><i class="fa fa-link"></i> Link SEI</button>`}
      </div>
    </div>
    ${proc.situacao_atual ? `<div class="situacao" style="margin-bottom:10px;">${proc.situacao_atual}</div>` : ''}
    <div style="font-size:.82rem;color:var(--muted);display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;">
      <span><b>Tipo:</b> ${proc.tipo||'—'}</span>
      <span><b>Unidade:</b> ${proc.unidade||'—'}</span>
      <span><b>OSS:</b> ${proc.oss||'—'}</span>
      <span><b>Cadastro:</b> ${formatarData(proc.data_cadastro)}</span>
      <span><b>Atualização:</b> ${formatarData(proc.data_atualizacao)}</span>
    </div>
    ${proc.descricao ? `<p style="margin-top:10px;font-size:.85rem;color:#374151;">${proc.descricao}</p>` : ''}
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab(this,'tab-andamentos')">Andamentos (${andamentos.length})</div>
    <div class="tab" onclick="switchTab(this,'tab-documentos')">Documentos (${documentos.length})</div>
    <div class="tab" onclick="switchTab(this,'tab-anotacoes')">Anotações (${anotacoes.length})</div>
    <div class="tab" onclick="switchTab(this,'tab-ia')">Análise IA</div>
    <div class="tab" onclick="switchTab(this,'tab-verificacoes')">Sem Movimentação (${verificacoes.length})</div>
  </div>

  <div id="tab-andamentos">
    <div class="flex gap-2" style="margin-bottom:12px;">
      <button class="btn btn-primary btn-sm" onclick="mostrarIndexarAndamento('${sei}')"><i class="fa fa-paste"></i> Indexar Andamentos</button>
    </div>
    ${andamentos.length ? andamentos.map(a => `
      <div class="andamento-item">
        <div class="and-header">${a.data_movimento||''} ${a.hora_movimento||''} — ${a.usuario_indexacao||''}</div>
        <div class="and-body">${a.descricao||''}</div>
      </div>`).join('') : '<p class="text-muted">Nenhum andamento registrado.</p>'}
  </div>

  <div id="tab-documentos" class="hidden">
    <div class="flex gap-2" style="margin-bottom:12px;">
      <button class="btn btn-primary btn-sm" onclick="mostrarUpload('${sei}')"><i class="fa fa-upload"></i> Importar Documentos</button>
    </div>
    ${documentos.length ? documentos.map(d => `
      <div class="doc-item">
        <i class="${iconDoc(d.nome_arquivo)}"></i>
        <div style="flex:1;">
          <div class="doc-name">${d.nome_arquivo}</div>
          <div class="doc-meta">${formatarData(d.data_upload)} — ${d.usuario_upload||''} — ${d.tamanho ? formatarTamanho(d.tamanho) : 'texto extraído'}</div>
        </div>
        ${d.link_verificacao
          ? `<a href="${d.link_verificacao}" target="_blank" class="btn btn-secondary btn-sm" title="Verificar no SEI (sem login)"><i class="fa fa-check-circle"></i> SEI</a>`
          : d.link_sei
            ? `<a href="${d.link_sei}" target="_blank" class="btn btn-secondary btn-sm" title="Abrir no SEI"><i class="fa fa-external-link-alt"></i></a>`
            : ''}
      </div>`).join('') : '<p class="text-muted">Nenhum documento importado.</p>'}
  </div>

  <div id="tab-anotacoes" class="hidden">
    <div style="margin-bottom:12px;">
      <textarea id="nova-anotacao" rows="3" placeholder="Digite sua anotação..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:.85rem;"></textarea>
      <button class="btn btn-primary btn-sm mt-2" onclick="salvarAnotacao('${sei}')"><i class="fa fa-save"></i> Adicionar Anotação</button>
    </div>
    ${anotacoes.length ? anotacoes.map(a => `
      <div class="anotacao-item">
        <div class="anot-header">${formatarDataHora(a.data_hora)} — <b>${a.usuario||''}</b></div>
        <div class="anot-body">${a.texto||''}</div>
      </div>`).join('') : '<p class="text-muted">Nenhuma anotação registrada.</p>'}
  </div>

  <div id="tab-ia" class="hidden">
    <div id="ia-content">
      ${proc.resumo_ia || proc.situacao_atual ? renderIABox(proc) : '<p class="text-muted">Nenhuma análise de IA disponível. Adicione documentos ou andamentos para acionar a IA.</p>'}
    </div>
    <div id="ia-status-msg" class="mt-2"></div>
  </div>

  <div id="tab-verificacoes" class="hidden">
    <div class="alert alert-info" style="margin-bottom:12px;">
      <i class="fa fa-info-circle"></i> Registre aqui quando não houve movimentação. O contador de tempo é reiniciado sem acionar nova análise de IA.
    </div>
    <button class="btn btn-warning" onclick="registrarSemMovimentacao('${sei}')">
      <i class="fa fa-check-circle"></i> Registrar: Sem Movimentação
    </button>
    <div id="lista-verificacoes" style="margin-top:16px;">
      ${verificacoes.length ? verificacoes.map(v => `
        <div style="padding:8px;border-bottom:1px solid var(--border);font-size:.83rem;">
          <i class="fa fa-check text-muted"></i> ${formatarDataHora(v.data_hora)} — ${v.usuario||''} — ${v.observacao||'Sem movimentação verificada'}
        </div>`).join('') : '<p class="text-muted">Nenhum registro de verificação.</p>'}
    </div>
  </div>`;

  window._processoAtual = proc;
}

// FIX: usa campos corretos do schema (resumo_ia, apontamentos_ia, etc.)
function renderIABox(proc) {
  return `<div class="ia-box">
    <h4><i class="fa fa-brain"></i> Análise de IA — ${proc.categoria||''}</h4>
    ${proc.situacao_atual ? `<div class="ia-section"><h5>Situação Atual</h5><p>${proc.situacao_atual}</p></div>` : ''}
    ${proc.resumo_ia ? `<div class="ia-section"><h5>Resumo</h5><p>${proc.resumo_ia}</p></div>` : ''}
    ${proc.apontamentos_ia ? `<div class="ia-section"><h5>Apontamentos</h5><p>${proc.apontamentos_ia}</p></div>` : ''}
    ${proc.sugestoes_ia ? `<div class="ia-section"><h5>Sugestões</h5><p>${proc.sugestoes_ia}</p></div>` : ''}
    ${proc.proximos_passos_ia ? `<div class="ia-section"><h5>Próximos Passos</h5><p>${proc.proximos_passos_ia}</p></div>` : ''}
    <div style="font-size:.72rem;color:var(--muted);margin-top:10px;">Última análise: ${formatarDataHora(proc.data_atualizacao)}</div>
  </div>`;
}

function switchTab(el, id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['tab-andamentos','tab-documentos','tab-anotacoes','tab-ia','tab-verificacoes'].forEach(t => {
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
    alert('Verificação registrada! Contador reiniciado.');
    abrirProcesso(sei);
  } else alert('Erro: ' + (res.erro || 'Não foi possível registrar.'));
}

// ==================== ANOTAÇÕES ====================
async function salvarAnotacao(sei) {
  const texto = document.getElementById('nova-anotacao').value.trim();
  if (!texto) { alert('Digite uma anotação.'); return; }
  const res = await api('anotacoes/salvar', { sei, texto });  // FIX: campo "texto"
  if (!res.ok) { alert('Erro: ' + res.erro); return; }
  api('log/registrar', { acao: 'ANOTACAO', numero_sei: sei, detalhes: texto.substring(0,100) });
  document.getElementById('nova-anotacao').value = '';
  const statusEl = document.getElementById('ia-status-msg');
  if (statusEl) statusEl.innerHTML = '<span class="spinner"></span> Analisando com IA...';
  await acionarIA(sei);
  abrirProcesso(sei);
}

// ==================== INDEXAR ANDAMENTOS ====================
function mostrarIndexarAndamento(sei) {
  criarModal(`
    <h2><i class="fa fa-paste"></i> Indexar Andamentos</h2>
    <p style="font-size:.85rem;color:var(--muted);margin-bottom:12px;">Cole o histórico de andamentos copiado do SEI.</p>
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
  // FIX: campo "texto" (era "texto_bruto")
  const res = await api('andamentos/indexar', { sei, texto });
  if (!res.ok) { resultEl.innerHTML = `<div class="alert alert-danger">${res.erro}</div>`; return; }
  api('log/registrar', { acao: 'INDEXAR_ANDAMENTOS', numero_sei: sei, detalhes: `${res.novos||0} novos` });
  resultEl.innerHTML = `<div class="alert alert-success"><i class="fa fa-check"></i> ${res.novos||0} novos andamentos, ${res.ignorados||0} duplicatas ignoradas.</div>`;
  if ((res.novos || 0) > 0) {
    resultEl.innerHTML += '<div class="mt-2"><span class="spinner"></span> Acionando IA...</div>';
    await acionarIA(sei);
    resultEl.innerHTML += '<div class="alert alert-success mt-2">Análise de IA concluída!</div>';
  }
  setTimeout(() => { fecharModal(); abrirProcesso(sei); }, 1500);
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

async function definirLinkSEI(sei) {
  const link = prompt('Cole o link do processo no portal SEI:\n(Copie diretamente do navegador enquanto estiver com o processo aberto)');
  if (link === null) return;
  const linkTrimado = link.trim();
  const linkEstavel = buildLinkProcessoEstavel(linkTrimado);
  try { const u = new URL(linkTrimado); localStorage.setItem('sei_base_url', u.origin + '/sei'); } catch(e) {}
  const res = await api('processos/atualizar', { numero_sei: sei, link_sei: linkEstavel });
  if (res.ok) abrirProcesso(sei);
  else alert('Erro ao salvar: ' + (res.erro || 'Falha'));
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
        // FIX: doc_id → documento_id, doc_nome → documento_nome
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

// FIX: usa documento_id / documento_nome (eram doc_id / doc_nome)
async function salvarBlocosSheets(sei, docId, docNome, texto) {
  const blocos = dividirEmBlocos(texto, BLOCO_MAX);
  for (let i = 0; i < blocos.length; i++) {
    await api('conteudo/salvar-bloco', {
      numero_sei: sei, documento_id: docId, documento_nome: docNome,
      bloco_num: i + 1, total_blocos: blocos.length, conteudo: blocos[i]
    });
  }
}

// ==================== IA ANÁLISE ====================
async function acionarIA(sei) {
  const ollamaOk = await testarOllama(); if (!ollamaOk) return;
  const resConteudo = await api('conteudo/listar?sei=' + sei);
  const blocos      = (resConteudo.blocos || []).map(b => b.conteudo || '');
  const resBases    = await api('bases-legais/listar');
  const basesLegais = (resBases.blocos || []).map(b => b.conteudo || '');
  const [resP, resA, resAnot] = await Promise.all([
    api('processos/obter?sei=' + sei),
    api('andamentos/listar?sei=' + sei),
    api('anotacoes/listar?sei=' + sei)
  ]);
  const proc = resP.processo || {};
  // FIX: campos corretos — data_movimento + hora_movimento (era data_hora); texto (era conteudo)
  const andamentos = (resA.andamentos || []).slice(-5).map(a => `${a.data_movimento||''} ${a.hora_movimento||''}: ${a.descricao||''}`).join('\n');
  const anotacoes  = (resAnot.anotacoes || []).slice(-3).map(a => `${a.data_hora||''}: ${a.texto||''}`).join('\n');

  const keywords = [proc.titulo||'', proc.tipo||'', sei, 'contrato','prazo','pagamento','execução','saúde']
    .join(' ').toLowerCase().split(/\s+/).filter(k => k.length > 3);
  const conteudoFiltrado    = filtrarBlocos(blocos, keywords, RELEVANCIA_MAX_CHARS);
  const basesLegaisFiltradas = filtrarBlocos(basesLegais, keywords, 10000);

  const prompt = `Você é um especialista em gestão de contratos e processos administrativos de Organização Social de Saúde (OSS).
Analise o processo abaixo e gere uma análise estruturada.

PROCESSO: SEI ${sei}
TÍTULO: ${proc.titulo||''}
TIPO: ${proc.tipo||''}
STATUS: ${proc.status||''}
PRIORIDADE: ${proc.prioridade||''}
OSS: ${proc.oss||''}
UNIDADE: ${proc.unidade||''}

ÚLTIMOS ANDAMENTOS:
${andamentos || 'Sem andamentos.'}

ANOTAÇÕES RECENTES:
${anotacoes || 'Sem anotações.'}

${conteudoFiltrado ? 'CONTEÚDO DOS DOCUMENTOS:\n' + conteudoFiltrado : ''}
${basesLegaisFiltradas ? '\nBASES LEGAIS APLICÁVEIS:\n' + basesLegaisFiltradas : ''}

Responda EXATAMENTE neste formato JSON (sem markdown):
{"categoria":"categoria do processo em 3-5 palavras","situacao_atual":"situação atual em 1-2 frases","resumo":"resumo detalhado","apontamentos":"pontos críticos e riscos","sugestoes":"sugestões de ação","proximos_passos":"próximos passos concretos"}`;

  try {
    const resp = await fetch(OLLAMA_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:OLLAMA_MODEL, prompt, stream:false }) });
    const data = await resp.json();
    const raw  = (data.response || '').trim();
    let ia;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) { try { ia = JSON.parse(jsonMatch[0]); } catch { ia = null; } }
    if (!ia) ia = { categoria:'Análise', situacao_atual:'', resumo:raw, apontamentos:'', sugestoes:'', proximos_passos:'' };

    // FIX: campos corretos do schema — resumo_ia, apontamentos_ia, etc.
    await api('processos/salvar-ia', {
      numero_sei: sei,
      categoria:        ia.categoria || '',
      situacao_atual:   ia.situacao_atual || '',
      resumo_ia:        ia.resumo || '',
      apontamentos_ia:  ia.apontamentos || '',
      sugestoes_ia:     ia.sugestoes || '',
      proximos_passos_ia: ia.proximos_passos || ''
    });
    api('log/registrar', { acao:'ANALISE_IA', numero_sei:sei, detalhes:'Análise concluída' });
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
  return _unidades.map(u => `<option value="${u.valor}" data-oss="${u.associado}" ${sel===u.valor?'selected':''}>${u.valor}</option>`).join('');
}

function tipoSelecionado() {
  const v = document.getElementById('w-tipo-novo')?.value;
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
}
function mostrarNovaUnidade() {
  const unidade = prompt('Nome da Unidade:'); if (!unidade) return;
  const oss = prompt('OSS associada:') || '';
  api('dados-fixos/criar', { categoria:'unidade', valor:unidade, associado:oss }).then(r => {
    if (r.ok) { _unidades.push({ valor:unidade, associado:oss }); renderWizardStep(); } else alert('Erro: '+r.erro);
  });
}

// ==================== NOVO PROCESSO (WIZARD) ====================
let wizardStep = 1, novoProc = {};

async function renderNovo() {
  wizardStep = 1; novoProc = {};
  await carregarDadosFixos();
  document.getElementById('content').innerHTML = `
  <div style="max-width:680px;margin:0 auto;">
    <div class="wizard-steps" id="wizard-steps">
      <div class="wizard-step active" id="ws1">1. Identificação</div>
      <div class="wizard-step" id="ws2">2. Detalhes</div>
      <div class="wizard-step" id="ws3">3. Documentos</div>
      <div class="wizard-step" id="ws4">4. Andamentos</div>
      <div class="wizard-step" id="ws5">5. Confirmar</div>
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
        <div style="display:flex;gap:6px;align-items:center;">
          <select id="w-tipo" style="flex:1;" onchange="tipoSelecionado()">
            ${optsTipos(novoProc.tipo)}
            <option value="__novo__">+ Cadastrar novo tipo...</option>
          </select>
        </div>
        ${_tipos.length ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">${_tipos.map(t=>`<span style="background:#f3f4f6;border-radius:4px;padding:2px 8px;font-size:.75rem;">${t}<button onclick="excluirTipo('${t}')" style="background:none;border:none;cursor:pointer;color:#ef4444;margin-left:2px;">✕</button></span>`).join('')}</div>` : ''}
      </div>
      <div class="flex gap-2 mt-4"><button class="btn btn-primary" onclick="wizardNext()">Próximo <i class="fa fa-arrow-right"></i></button></div>`;
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
        </select></div>
      <div class="form-group"><label>OSS <small style="color:var(--muted);">(preenchido automaticamente)</small></label>
        <input id="w-oss" value="${novoProc.oss||''}" style="background:#f9fafb;"></div>
      <div class="form-group"><label>Descrição</label><textarea id="w-descricao">${novoProc.descricao||''}</textarea></div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-secondary" onclick="wizardPrev()"><i class="fa fa-arrow-left"></i> Voltar</button>
        <button class="btn btn-primary" onclick="wizardNext()">Próximo <i class="fa fa-arrow-right"></i></button></div>`;
  } else if (wizardStep === 3) {
    body.innerHTML = `
      <h3 style="margin-bottom:16px;">Documentos (opcional)</h3>
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
      <div class="form-group"><textarea id="w-andamentos" rows="10" placeholder="Cole o histórico de andamentos...">${novoProc.andamentos||''}</textarea></div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-secondary" onclick="wizardPrev()"><i class="fa fa-arrow-left"></i> Voltar</button>
        <button class="btn btn-primary" onclick="wizardNext()">Próximo <i class="fa fa-arrow-right"></i></button></div>`;
  } else if (wizardStep === 5) {
    body.innerHTML = `
      <h3 style="margin-bottom:16px;">Confirmar Cadastro</h3>
      <div style="background:#f9fafb;border-radius:8px;padding:16px;font-size:.85rem;margin-bottom:16px;">
        <b>SEI:</b> ${novoProc.sei}<br><b>Título:</b> ${novoProc.titulo}<br>
        <b>Tipo:</b> ${novoProc.tipo||'—'} — <b>Status:</b> ${novoProc.status} — <b>Prioridade:</b> ${novoProc.prioridade}<br>
        <b>Unidade:</b> ${novoProc.unidade||'—'} — <b>OSS:</b> ${novoProc.oss||'—'}<br>
        <b>Documentos:</b> ${novoProc._files?novoProc._files.length:0} — <b>Andamentos:</b> ${novoProc.andamentos?'Sim':'Não'}
      </div>
      <div id="novo-status"></div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-secondary" onclick="wizardPrev()"><i class="fa fa-arrow-left"></i> Voltar</button>
        <button class="btn btn-success" onclick="cadastrarProcesso()"><i class="fa fa-save"></i> Cadastrar Processo</button></div>`;
  }
  for (let i = 1; i <= 5; i++) {
    const ws = document.getElementById('ws'+i);
    if (ws) ws.className = 'wizard-step' + (i < wizardStep ? ' done' : i === wizardStep ? ' active' : '');
  }
}

function wizardNext() {
  if (wizardStep === 1) {
    novoProc.sei   = document.getElementById('w-sei').value.trim();
    novoProc.titulo = document.getElementById('w-titulo').value.trim();
    novoProc.tipo  = document.getElementById('w-tipo').value;
    if (!novoProc.sei || !novoProc.titulo) { alert('Preencha SEI e Título.'); return; }
  } else if (wizardStep === 2) {
    novoProc.status    = document.getElementById('w-status').value;
    novoProc.prioridade = document.getElementById('w-prioridade').value;
    novoProc.unidade   = document.getElementById('w-unidade')?.value || '';
    if (novoProc.unidade === '__nova__') novoProc.unidade = '';
    novoProc.oss       = document.getElementById('w-oss')?.value.trim() || '';
    novoProc.descricao = document.getElementById('w-descricao').value.trim();
  } else if (wizardStep === 4) {
    novoProc.andamentos = document.getElementById('w-andamentos').value.trim();
  }
  wizardStep = Math.min(wizardStep + 1, 5);
  renderWizardStep();
}
function wizardPrev() { wizardStep = Math.max(wizardStep - 1, 1); renderWizardStep(); }

function mostrarArquivosSelecionados() {
  const el = document.getElementById('files-selecionados');
  if (!novoProc._files || !novoProc._files.length) { el.innerHTML = ''; return; }
  el.innerHTML = Array.from(novoProc._files).map(f =>
    `<div class="doc-item"><i class="${iconDoc(f.name)}"></i><span>${f.name}</span><span class="doc-meta">${formatarTamanho(f.size)}</span></div>`
  ).join('');
}

async function cadastrarProcesso() {
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
    // FIX: campo "texto" (era "texto_bruto")
    await api('andamentos/indexar', { sei: novoProc.sei, texto: novoProc.andamentos });
  }

  if (novoProc._files?.length || novoProc.andamentos) {
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

// FIX: configListar retorna res.config (objeto, não array)
async function carregarAdmConfig() {
  const el  = document.getElementById('adm-config');
  const res = await api('config/listar');
  const cfg = res.config || {};  // FIX: era res.configs (array inexistente)
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

// FIX: res.total_blocos / res.total_docs (era res.status.total_blocos)
async function carregarAdmBases() {
  const el  = document.getElementById('adm-bases');
  const res = await api('bases-legais/status');
  el.innerHTML = `
  <div class="alert alert-info" style="margin-bottom:16px;"><i class="fa fa-info-circle"></i> Importe documentos Word/PDF com leis, contratos-modelo e normativas para enriquecer as análises da IA.</div>
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
  const ctx = todosProcessos.slice(0,15).map(p => `SEI ${p.numero_sei}: ${p.titulo} (${p.status}, ${p.prioridade}) — ${p.situacao_atual||''}`).join('\n');
  const prompt = `Você é um assistente de monitoramento de processos de OSS.\n\nPROCESSOS:\n${ctx||'Nenhum.'}\n\nPERGUNTA: ${msg}\n\nResponda em português, objetivamente.`;
  const loadMsg = document.createElement('div');
  loadMsg.className = 'chat-msg ai';
  loadMsg.innerHTML = '<span class="spinner"></span>';
  msgs.appendChild(loadMsg);
  msgs.scrollTop = msgs.scrollHeight;
  try {
    const ollamaOk = await testarOllama();
    if (!ollamaOk) { loadMsg.textContent = 'IA não disponível. Verifique o Ollama.'; return; }
    const resp = await fetch(OLLAMA_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ model:OLLAMA_MODEL, prompt, stream:false }) });
    const data = await resp.json();
    loadMsg.textContent = data.response || 'Sem resposta.';
  } catch(e) { loadMsg.textContent = 'Erro ao contatar IA: '+e.message; }
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
function formatarData(s) {
  if (!s) return '—';
  const d = new Date(s); if (isNaN(d)) return s;
  return d.toLocaleDateString('pt-BR');
}
function formatarDataHora(s) {
  if (!s) return '—';
  const d = new Date(s); if (isNaN(d)) return s;
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
