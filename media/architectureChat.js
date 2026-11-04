(function () {
  'use strict';
  const api = window.acquireVsCodeApi();
  const el = id => document.getElementById(id);
  function entry(role, text) {
    const box = document.createElement('section'), heading = document.createElement('h3'), body = document.createElement('p');
    heading.textContent = role;
    body.textContent = text;
    box.append(heading, body);
    el('thread').append(box);
  }
  function answer(a) {
    entry(a.whatEvidence ? 'What · source evidence' : 'What · working hypothesis', a.what + (a.whatEvidence ? '\n“' + a.whatEvidence + '”' : ''));
    entry(a.whyEvidence ? 'Why · documented rationale' : 'Why · working hypothesis', a.why + (a.whyEvidence ? '\n“' + a.whyEvidence + '”' : ''));
    if (a.question) { entry('Reviewer asks', a.question); }
    if (a.confirmed) { entry('Developer clarification', a.confirmed); }
  }
  function lock(busy) { el('send').disabled = busy; el('apply').disabled = busy; }
  el('replyForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = el('reply').value.trim();
    if (!text) { return; }
    entry('You', text);
    el('reply').value = '';
    lock(true);
    api.postMessage({ action: 'send', text });
  });
  el('apply').addEventListener('click', () => {
    const text = el('proposal').value.trim();
    if (text) { lock(true); api.postMessage({ action: 'save', text }); }
  });
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'initial') {
      el('scope').textContent = m.branch + ' / ' + m.file;
      answer(m.answer);
      el('proposal').value = m.answer.confirmed || '';
    }
    if (m.type === 'answer') {
      answer(m.answer);
      el('proposal').value = m.answer.why;
      el('notice').textContent = 'Review or edit the proposed clarification before applying.';
    }
    if (m.type === 'busy') { lock(true); el('notice').textContent = 'Reading the code and your clarification…'; }
    if (m.type === 'idle') { lock(false); }
    if (m.type === 'notice') { el('notice').textContent = m.text; }
  });
  api.postMessage({ action: 'ready' });
}());
