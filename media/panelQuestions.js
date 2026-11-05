window.startMaltQuestions = function (send) {
  const el = id => document.getElementById(id);
  let key = '', pending = false;
  const setBusy = value => {
    pending = value;
    for (const id of ['panelQuestionSend', 'askOverview', 'askJourney', 'askPurpose']) { el(id).disabled = value; }
  };
  const ask = text => {
    if (pending || !text.trim()) { return; }
    el('panelQuestionText').value = text;
    el('panelQuestionStatus').textContent = 'Reading the available evidence…';
    setBusy(true);
    send({ action: 'viewAsk', key, audience: el('questionAudience').value, text });
  };
  el('panelQuestionForm').addEventListener('submit', event => { event.preventDefault(); ask(el('panelQuestionText').value); });
  for (const [id, text] of [
    ['askOverview', 'What am I looking at? Explain the responsibilities and connections in this view in everyday language.'],
    ['askJourney', 'Walk me through one concrete example using these parts. Distinguish the recorded behavior from any hypothetical example.'],
    ['askPurpose', 'Why does the selected part or process exist? Explain what is known from the source and what is only inferred.'],
  ]) { el(id).addEventListener('click', () => ask(text)); }
  const paragraph = (heading, value) => {
    if (!value) { return; }
    const h = document.createElement('h3'), p = document.createElement('p');
    h.textContent = heading; p.textContent = value;
    el('panelAnswer').append(h, p);
  };
  return message => {
    if (message.action === 'perspective') {
      if (key !== message.questionKey) {
        key = message.questionKey;
        setBusy(false); el('panelAnswer').replaceChildren(); el('panelQuestionStatus').textContent = '';
      }
      const story = message.narration;
      el('storyTitle').textContent = story?.title || 'No diagram at this level';
      el('storySummary').textContent = story?.summary || message.empty || 'Select another view to explore the recorded evidence.';
      el('storyScope').textContent = story?.scope || '';
      el('storyReading').textContent = story?.reading || '';
      el('storyRecommendation').textContent = story?.recommendation || '';
      return;
    }
    if (message.action !== 'viewAnswer' || message.key !== key) { return; }
    setBusy(message.phase === 'busy');
    if (message.phase === 'error') { el('panelQuestionStatus').textContent = message.text; return; }
    if (message.phase !== 'answer') { return; }
    const answer = message.answer;
    el('panelAnswer').replaceChildren();
    paragraph('Explanation', answer.what);
    paragraph(answer.whyEvidence ? 'Documented purpose' : 'Possible purpose — not confirmed', answer.why);
    paragraph('Source excerpt', answer.whatEvidence);
    paragraph('Source supporting the purpose', answer.whyEvidence);
    paragraph('Follow-up to explore', answer.question);
    for (const source of message.sources || []) {
      const button = document.createElement('button');
      button.textContent = 'Open ' + source.path;
      button.addEventListener('click', () => send({ action: 'source', id: source.id, key }));
      el('panelAnswer').append(button);
    }
    el('panelQuestionStatus').textContent = message.coverage + ' Ask a follow-up above; this answer does not change the saved map.';
  };
};
