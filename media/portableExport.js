/* Browser encoders consume the vector at the requested pixel size. */
(() => {
  const doc = document;
  const snapshot = (theme, scale = 1) => {
    const svg = doc.getElementById('modelSvg').cloneNode(true);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
    svg.setAttribute('width', w * scale);
    svg.setAttribute('height', h * scale);
    svg.dataset.motion = 'still';
    if (theme) svg.dataset.theme = theme;
    const css = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    css.textContent = doc.getElementById('drawing-style').textContent;
    svg.prepend(css);
    return { body: new window.XMLSerializer().serializeToString(svg), w, h };
  };
  const blob = (bytes, type) => new window.Blob([bytes], { type });
  function download(data, name) {
    const a = doc.createElement('a');
    a.download = name;
    a.href = window.URL.createObjectURL(data);
    a.click();
    window.setTimeout(() => window.URL.revokeObjectURL(a.href), 3000);
  }
  async function raster(scale, canvas) {
    const theme = doc.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const { body, w, h } = snapshot(theme, scale);
    if (w * scale > 32767 || h * scale > 32767 || w * h * scale * scale > 64000000)
      throw new Error('Canvas size exceeds 64 megapixels. Choose a smaller scope or scale.');
    if (canvas.width !== w * scale || canvas.height !== h * scale) {
      canvas.width = w * scale;
      canvas.height = h * scale;
    }
    const image = new window.Image(),
      url = window.URL.createObjectURL(blob(body, 'image/svg+xml;charset=utf-8'));
    try {
      image.src = url;
      await image.decode();
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = window.getComputedStyle(doc.body).getPropertyValue('--surface').trim();
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    } finally {
      window.URL.revokeObjectURL(url);
    }
  }
  const encode = (canvas, type) =>
    new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b && b.type === type ? resolve(b) : reject(new Error('Encoder unavailable: ' + type))), type, 0.95),
    );
  async function video(canvas, scale, route, inspect) {
    if (!window.MediaRecorder || !canvas.captureStream || !window.MediaRecorder.isTypeSupported('video/webm'))
      throw new Error('WebM recording unavailable in this browser');
    const stream = canvas.captureStream(15),
      rec = new window.MediaRecorder(stream, { mimeType: 'video/webm' }),
      chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const finished = new Promise((res, rej) => {
      rec.onstop = () => res(new window.Blob(chunks, { type: 'video/webm' }));
      rec.onerror = (e) => rej(e.error);
    });
    const wait = (ms) => new Promise((res) => window.setTimeout(res, ms));
    try {
      rec.start();
      await wait(220);
      for (let i = 0; i < route.length; i++) {
        inspect(i);
        await raster(scale, canvas);
        await wait(500);
      }
      await wait(300);
    } finally {
      if (rec.state !== 'inactive') rec.stop();
      stream.getTracks().forEach((track) => track.stop());
    }
    return finished;
  }
  window.maltEncode = async (format, scale, route, inspect) => {
    if (format === 'svg') return blob(snapshot(doc.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')).body, 'image/svg+xml');
    const canvas = doc.createElement('canvas');
    await raster(scale, canvas);
    if (format === 'webm') return video(canvas, scale, route, inspect);
    return encode(canvas, 'image/' + (format === 'clipboard' ? 'png' : format));
  };
  window.maltExport = async (format, scale, diagram, route, inspect) => {
    const name = diagram.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 80) || 'malt';
    const image = await window.maltEncode(format, scale, route, inspect);
    if (format === 'clipboard') {
      await window.navigator.clipboard.write([new window.ClipboardItem({ 'image/png': image })]);
      return;
    }
    download(image, name + '.' + format);
  };
})();
