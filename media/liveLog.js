/*
 * MALT live reviewer log: the page script of the log webview.
 * Plain DOM APIs and textContent only: no innerHTML, no eval, no network. Events arrive by postMessage from the
 * extension, which has already validated them. At most MAX_CALLS cards are kept: evicting a card also releases its
 * entry, so a long session stays bounded and the timer only visits live calls.
 */
(function () {
  'use strict';

  const MAX_CALLS = 150;
  const STALL_MS = 30000;
  const calls = new Map();
  const order = [];
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
  const list = document.getElementById('calls');
  const status = document.getElementById('status');
  const usage = document.getElementById('usage');

  function el(tag, cls, text) {
    const element = document.createElement(tag);
    if (cls) {
      element.className = cls;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function nearBottom() {
    return window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  }

  function secs(ms) {
    return Math.max(0, Math.round(ms / 1000)) + 's';
  }

  function number(n) {
    return Math.round(n).toLocaleString();
  }

  function money(usd) {
    return '$' + usd.toFixed(usd < 0.01 ? 4 : 2);
  }

  function describeUsage(u) {
    return number(u.inputTokens) + ' in · ' + number(u.outputTokens) + ' out · ' + number(u.cachedTokens) + ' cached · ≈' + money(u.costUsd);
  }

  function showTotals() {
    usage.textContent = totals.calls === 0
      ? ''
      : 'This session: ' + totals.calls + ' call(s) · ' + describeUsage(totals) + ' (cost is notional on a subscription)';
  }

  function evictOldest() {
    while (order.length > MAX_CALLS) {
      const id = order.shift();
      const call = calls.get(id);
      calls.delete(id);
      if (call && call.card.parentNode === list) {
        list.removeChild(call.card);
      }
    }
  }

  function start(e) {
    const card = el('div', 'call');
    const head = el('div', 'head');
    const state = el('span', 'state', 'waiting for first token');
    const time = el('span', 'time', '');
    head.appendChild(el('span', 'label', e.label));
    head.appendChild(el('span', 'model', e.model + ' · ' + (e.effort === 'default' ? 'default effort' : e.effort + ' effort')));
    head.appendChild(state);
    head.appendChild(time);
    const details = el('details');
    details.appendChild(el('summary', '', 'Prompt sent (' + e.prompt.length + ' characters, secrets redacted)'));
    details.appendChild(el('pre', 'prompt', e.prompt));
    const answer = el('pre', 'answer', '');
    card.appendChild(head);
    card.appendChild(details);
    card.appendChild(answer);
    list.appendChild(card);
    calls.set(e.callId, { card: card, state: state, time: time, answer: answer, started: e.at, last: e.at, done: false });
    order.push(e.callId);
    evictOldest();
  }

  function text(e) {
    const call = calls.get(e.callId);
    if (!call) {
      return;
    }
    call.answer.textContent += e.text;
    call.last = e.at;
    call.state.textContent = 'streaming';
    call.state.className = 'state';
  }

  function end(e) {
    const call = calls.get(e.callId);
    if (!call) {
      return;
    }
    call.done = true;
    call.time.textContent = 'took ' + secs(e.at - call.started);
    call.state.textContent = e.ok ? 'done' : 'failed';
    call.state.className = 'state ' + (e.ok ? 'ok' : 'err');
    if (e.usage) {
      call.card.appendChild(el('div', 'usage', describeUsage(e.usage)));
      totals.calls += 1;
      totals.inputTokens += e.usage.inputTokens;
      totals.outputTokens += e.usage.outputTokens;
      totals.cachedTokens += e.usage.cachedTokens;
      totals.costUsd += e.usage.costUsd;
      showTotals();
    }
    if (!e.ok) {
      call.card.appendChild(el('pre', 'error', e.error));
    }
  }

  function clear() {
    list.textContent = '';
    calls.clear();
    order.length = 0;
  }

  window.addEventListener('message', function (message) {
    const data = message.data;
    if (!data || typeof data !== 'object') {
      return;
    }
    if (data.type === 'status') {
      status.textContent = String(data.text);
      return;
    }
    if (data.type === 'clear') {
      clear();
      return;
    }
    if (data.type !== 'event' || !data.event) {
      return;
    }
    const stick = nearBottom();
    const e = data.event;
    if (e.kind === 'start') {
      start(e);
    } else if (e.kind === 'text') {
      text(e);
    } else if (e.kind === 'end') {
      end(e);
    }
    if (stick) {
      window.scrollTo(0, document.body.scrollHeight);
    }
  });

  setInterval(function () {
    const now = Date.now();
    calls.forEach(function (call) {
      if (call.done) {
        return;
      }
      call.time.textContent = 'running ' + secs(now - call.started);
      if (now - call.last > STALL_MS) {
        call.state.textContent = 'no output for ' + secs(now - call.last);
        call.state.className = 'state stalled';
      }
    });
  }, 1000);
}());
