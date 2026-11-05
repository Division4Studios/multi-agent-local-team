(function () {
  'use strict';
  const host = window.acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  const send = (action, extra = {}) => host.postMessage({ action, ...extra });
  let state, selected = '', busy = false;
  const node = (tag, text, cls) => {
    const item = document.createElement(tag);
    if (text !== undefined) { item.textContent = text; }
    if (cls) { item.className = cls; }
    return item;
  };
  const button = (label, click, cls) => {
    const item = node('button', label, cls);
    item.type = 'button';
    item.addEventListener('click', click);
    return item;
  };
  const sourceButton = (path) => button(path, () => send('open', { path }), 'source-link');
  const statusOf = (file) => file.blocks.some((block) => block.status === 'fail') ? 'fail'
    : file.blocks.some((block) => block.status === 'error') ? 'error'
      : file.blocks.every((block) => block.status === 'pass') ? 'pass' : 'pending';
  const statusLabel = (status) => ({ fail: 'Review failed', error: 'Review error', pass: 'Reviews complete', pending: 'Review incomplete' })[status] || status;
  function metrics() {
    const counts = state.packet.counts, target = el('metrics');
    target.replaceChildren();
    for (const [value, label, cls] of [[state.packet.files.length, 'files changed', ''], [counts.failed, 'blocks with failed reviews', 'fail'], [counts.unfinished, 'blocks still need review', 'pending'], [counts.passed, 'blocks passed AI review', 'pass']]) {
      const card = node('div', undefined, 'metric ' + cls);
      card.append(node('strong', String(value)), node('span', label));
      target.append(card);
    }
    const blocks = state.packet.files.flatMap(file => file.blocks);
    el('queueStatus').textContent = blocks.filter(block => block.activity === 'reviewing').length + ' blocks reviewing · '
      + blocks.filter(block => block.activity === 'queued').length + ' queued · '
      + blocks.filter(block => block.activity === 'pending').length + ' waiting · '
      + blocks.filter(block => block.activity === 'error').length + ' errors';
  }
  function fileMap() {
    const target = el('fileMap'), query = el('filter').value.toLowerCase();
    const focused = document.activeElement?.getAttribute('data-file');
    target.replaceChildren();
    const files = state.packet.files.filter((file) => file.path.toLowerCase().includes(query));
    if (!files.length) { target.append(node('p', state.packet.files.length ? 'No matching files.' : 'No tracked changes. Save a change and wait for Git tracking to refresh.', 'muted')); }
    for (const folder of [...new Set(files.map((file) => file.folder))]) {
      const group = node('section', undefined, 'folder-group');
      group.append(node('h3', folder === '.' ? 'Project root' : folder));
      const cards = node('div', undefined, 'file-cards');
      for (const file of files.filter((item) => item.folder === folder)) {
        const card = button('', () => { selected = file.path; fileMap(); inspect(); }, 'file-card ' + statusOf(file));
        card.setAttribute('aria-pressed', String(file.path === selected));
        card.setAttribute('data-file', file.path);
        card.append(node('strong', file.name), node('span', file.responsibility || file.blocks[0]?.summary || 'Select to inspect the change.', 'responsibility'),
          node('span', '+' + file.added + ' / −' + file.removed + ' lines · ' + statusLabel(statusOf(file)), 'file-meta'));
        cards.append(card);
      }
      group.append(cards); target.append(group);
    }
    if (focused) { [...target.querySelectorAll('button')].find(card => card.getAttribute('data-file') === focused)?.focus(); }
  }
  function connections() {
    const target = el('connections'); target.replaceChildren();
    const edges = state.packet.imports.filter((edge) => !selected || edge.from === selected || edge.to === selected);
    if (!edges.length) { target.append(node('p', selected ? 'No changed import relationships resolved for this file.' : 'No changed import relationships resolved from these patches.', 'muted')); }
    for (const edge of edges) {
      const row = node('div', undefined, 'connection ' + edge.change);
      row.append(sourceButton(edge.from), node('span', edge.change === 'added' ? '→ now imports →' : '⇢ import removed ⇢', 'connection-label'), sourceButton(edge.to));
      target.append(row);
    }
  }
  function inspect() {
    const file = state.packet.files.find((item) => item.path === selected);
    const target = el('selected'); target.replaceChildren();
    el('selectedTitle').textContent = file?.name || 'Choose a file';
    connections();
    if (!file) { target.append(node('p', 'Select a file in the map to inspect its changes.', 'muted')); return; }
    target.append(node('p', file.path, 'path'));
    if (file.responsibility) { target.append(node('p', file.responsibility), node('p', 'Responsibility from the available architecture summary; it may predate these edits.', 'muted')); }
    const actions = node('div', undefined, 'actions');
    actions.append(button('Open changed source', () => send('open', { path: file.path })), button('Explore this file', () => send('architecture', { path: file.path })));
    target.append(actions);
    for (const block of file.blocks) {
      const section = node('section', undefined, 'block');
      section.append(node('h3', 'Lines ' + block.line + '–' + block.endLine), node('span', statusLabel(block.status), 'badge ' + block.status), node('p', block.summary));
      if (block.purpose) { section.append(node('h4', 'Reviewer’s explanation of the purpose'), node('p', block.purpose)); }
      if (block.error) { section.append(node('p', block.error, 'error')); }
      const detail = node('details'); detail.append(node('summary', 'Design notes and ' + block.checks.length + ' recorded checks'));
      if (block.design) { detail.append(node('p', block.design)); }
      for (const check of block.checks) {
        const checkBox = node('div', undefined, 'check ' + check.status);
        checkBox.append(node('strong', check.title + ' · ' + check.status), node('p', check.note), node('p', check.detail, 'muted'));
        detail.append(checkBox);
      }
      section.append(detail); target.append(section);
    }
  }
  function findings() {
    const target = el('findings'); target.replaceChildren();
    const failed = state.packet.files.flatMap((file) => file.blocks.flatMap((block) => block.checks.filter((check) => check.status === 'fail').map((check) => ({ file, check }))));
    for (const { file, check } of failed) {
      const card = node('article', undefined, 'finding fail');
      card.append(node('h3', check.title), node('p', check.note), sourceButton(file.path)); target.append(card);
    }
    for (const finding of state.packet.findings) {
      const card = node('article', undefined, 'finding');
      card.append(node('h3', finding.title), node('p', finding.note), node('p', 'Consolidation candidate from the last recorded check; confirm against current changes.', 'muted'));
      for (const path of finding.files.filter((path) => state.packet.files.some((file) => file.path === path))) { card.append(sourceButton(path)); }
      target.append(card);
    }
    if (!failed.length && !state.packet.findings.length) { target.append(node('p', 'No recorded failures or consolidation candidates. This does not establish readiness to commit.', 'muted')); }
    target.append(node('p', 'Consolidation: ' + state.consolidation + '. Test execution is tracked separately below.', 'muted'));
  }
  function answer(message) {
    const target = el('answer'); target.replaceChildren();
    target.append(node('p', message.answer.what, 'lead'), node('h3', 'Why it may matter'), node('p', message.answer.why),
      node('p', message.answer.whyEvidence ? 'The reviewer cited source evidence for this rationale.' : 'The rationale is an interpretation, not confirmed intent.', 'muted'));
    const evidence = [message.answer.whatEvidence, message.answer.whyEvidence].filter(Boolean);
    if (evidence.length) {
      const detail = node('details'); detail.append(node('summary', 'Inspect cited patch evidence'));
      for (const quote of evidence) { detail.append(node('pre', quote)); }
      target.append(detail);
    }
    if (message.answer.question) { target.append(node('p', message.answer.question, 'followup')); }
    target.append(node('p', 'Supplied patches from ' + message.supplied.length + ' files; ' + message.omitted + ' blocks omitted by the context budget. Complete implementations were not supplied.', 'muted'));
    const citations = el('citations'); citations.replaceChildren(node('span', 'Inspect supplied files:', 'muted'));
    for (const path of message.supplied) { citations.append(sourceButton(path)); }
    const turn = node('article', undefined, 'turn');
    turn.append(node('h3', message.question), node('p', message.answer.what), node('p', message.answer.why));
    el('thread').append(turn);
    while (el('thread').children.length > 8) { el('thread').firstChild.remove(); }
  }
  function controls() {
    const disabled = busy || !state?.packet.files.length || state.prActive;
    for (const id of ['analyze', 'ask']) { el(id).disabled = disabled; }
    el('review').disabled = Boolean(state?.prActive) || !state?.packet.files.length;
    el('recordTest').disabled = Boolean(state?.dirty || state?.prActive);
    for (const item of el('suggestions').querySelectorAll('button')) { item.disabled = disabled; }
  }
  const ask = (question) => { if (question.trim() && !busy) { send('ask', { text: question.trim() }); } };
  el('analyze').addEventListener('click', () => ask('Give a plain-English overview of these uncommitted changes. Explain what changed, the likely user benefit, how responsibilities changed, and what needs human attention before committing. Separate evidence from inferred intent and never treat code reviews as executed tests.'));
  el('review').addEventListener('click', () => send('review'));
  el('architecture').addEventListener('click', () => send('architecture'));
  el('openTests').addEventListener('click', () => send('tests'));
  el('filter').addEventListener('input', fileMap);
  el('questionForm').addEventListener('submit', (event) => { event.preventDefault(); ask(el('question').value); });
  for (const item of el('suggestions').querySelectorAll('button')) { item.addEventListener('click', () => ask(item.getAttribute('data-question'))); }
  el('recordTest').addEventListener('click', () => {
    const note = el('testNote').value.trim();
    if (!note) { el('testStatus').textContent = 'Describe the command or suite and its result before recording it.'; return; }
    send('recordTest', { outcome: el('testOutcome').value, note });
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== window.origin || !event.data) { return; }
    const message = event.data;
    if (message.type === 'state') {
      state = message;
      el('scope').textContent = state.workspace + ' · ' + state.branch + ' · saved local changes before commit';
      el('freshness').textContent = state.prActive ? 'Pull request review is active. Finish it before using this local review workspace.' :
        [state.dirty ? 'Unsaved edits are not included. Save them before requesting an explanation.' : 'Shows the latest tracked saved changes.', state.unrepresented ? state.unrepresented + ' Git changes are not represented here (for example deleted, binary or excluded files).' : ''].join(' ');
      if (message.changed) {
        el('answer').replaceChildren(node('p', 'The changes or recorded reviews changed. Request a fresh explanation.', 'muted'));
        el('citations').replaceChildren(); el('thread').replaceChildren();
        el('testStatus').textContent = 'Earlier manual test notes are stale after changes to the review evidence. No current result recorded.';
        el('testStatus').setAttribute('data-result', 'unknown');
      }
      if (message.verification) {
        el('testStatus').textContent = 'Developer-reported · ' + message.verification.outcome + ' · ' + message.verification.note + ' (not independently verified; applies to this captured change only)';
        el('testStatus').setAttribute('data-result', message.verification.outcome);
      }
      metrics(); fileMap(); inspect(); findings(); controls();
    } else if (message.type === 'busy') { busy = true; el('notice').textContent = 'Reading the captured changes…'; controls(); }
    else if (message.type === 'idle') { busy = false; controls(); }
    else if (message.type === 'answer') { answer(message); el('notice').textContent = 'Explanation prepared from the captured evidence.'; }
    else if (message.type === 'answerInvalidated') { el('answer').replaceChildren(node('p', message.text, 'muted')); el('citations').replaceChildren(); el('thread').replaceChildren(); }
    else if (message.type === 'notice') { el('notice').textContent = message.text; }
  });
  send('ready');
})();
