window.startMaltTheme = function (host) {
  const appearance = document.getElementById('appearance');
  const stored = host.getState?.() || {};
  appearance.value = ['light', 'dark'].includes(stored.appearance) ? stored.appearance : 'editor';
  const apply = () => {
    document.body.setAttribute('data-appearance', appearance.value);
    host.setState?.({ ...host.getState?.(), appearance: appearance.value });
  };
  appearance.addEventListener('change', apply);
  apply();
};
