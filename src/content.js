(() => {
  'use strict';

  const MEASURE_SECONDS = 20;

  const graphs = new WeakMap();
  const lookupCache = new Map();
  let session = null;
  let lookupToken = 0;
  let measureToken = 0;
  let panel = null;
  let onlineArea = null;
  let measureArea = null;
  let actions = null;

  function isVideoPage() {
    return location.pathname === '/watch' || location.pathname.startsWith('/shorts/');
  }

  function videoId() {
    return new URLSearchParams(location.search).get('v') || location.pathname;
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    return (
      videos.find((v) => !v.paused && v.readyState > 2) ||
      document.querySelector('#movie_player video, video.html5-main-video') ||
      videos[0] ||
      null
    );
  }

  function isAdPlaying() {
    return !!document.querySelector('#movie_player.ad-showing');
  }

  function videoMetadata() {
    const meta = navigator.mediaSession && navigator.mediaSession.metadata;
    const h1 = document.querySelector('h1.ytd-watch-metadata, #title h1');
    const owner = document.querySelector('ytd-video-owner-renderer #channel-name a, #owner #channel-name a');
    return {
      title: (meta && meta.title) || (h1 && h1.textContent.trim()) || document.title.replace(/ - YouTube$/, ''),
      channel: (meta && meta.artist) || (owner && owner.textContent.trim()) || '',
    };
  }

  function getAudioGraph(video) {
    let graph = graphs.get(video);
    if (!graph) {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(video);
      source.connect(ctx.destination);
      graph = { ctx, source };
      graphs.set(video, graph);
    }
    return graph;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, onClick, primary) {
    const b = el('button', primary ? 'ytbpm-btn ytbpm-btn-primary' : 'ytbpm-btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function link(label, href) {
    const a = el('a', 'ytbpm-link', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function bpmValues(bpm) {
    const doubledValue = Math.round(bpm * 2);
    const row = el('div', 'ytbpm-result');
    const primary = el('div', 'ytbpm-value');
    primary.append(el('span', 'ytbpm-number', String(doubledValue / 2)), el('span', 'ytbpm-unit', 'BPM'));
    const doubled = el('div', 'ytbpm-value ytbpm-value-sub');
    doubled.append(
      el('span', 'ytbpm-label', '×2'),
      el('span', 'ytbpm-number', String(doubledValue)),
      el('span', 'ytbpm-unit', 'BPM'),
    );
    row.append(primary, doubled);
    return row;
  }

  function ensurePanel() {
    if (panel && panel.isConnected) return;
    panel = el('div', 'ytbpm-panel');
    onlineArea = el('section', 'ytbpm-section');
    measureArea = el('section', 'ytbpm-section');
    actions = el('div', 'ytbpm-actions');
    panel.append(onlineArea, measureArea, actions);
    document.body.appendChild(panel);
  }

  function renderIdle() {
    ensurePanel();
    panel.dataset.state = 'idle';
    onlineArea.replaceChildren();
    measureArea.replaceChildren();
    actions.replaceChildren(button('♪ BPM を測定', start, true));
  }

  function renderActions() {
    panel.dataset.state = 'active';
    if (session) {
      actions.replaceChildren(button('測定を中止', () => { stopSession(); renderMeasure('stopped'); renderActions(); }));
    } else {
      actions.replaceChildren(button('再測定', start), button('閉じる', close));
    }
  }

  function renderOnline(state, data) {
    onlineArea.replaceChildren(el('div', 'ytbpm-heading', 'from Web'));
    if (state === 'loading') {
      onlineArea.append(el('div', 'ytbpm-status', '検索中…'));
    } else if (state === 'found') {
      onlineArea.append(bpmValues(data.bpm));
      const source = el('div', 'ytbpm-source');
      source.append(link(`${data.artist} – ${data.title}`, data.link), document.createTextNode(`（${data.source}）`));
      onlineArea.append(source);
      if (!data.artistMatched) {
        onlineArea.append(el('div', 'ytbpm-warning', '※ アーティスト名が一致しません（同名の別の曲かも）'));
      }
    } else {
      const q = data.query || {};
      const words = [q.artist, q.track].filter(Boolean).join(' ');
      onlineArea.append(
        el('div', 'ytbpm-status', data.error ? '検索に失敗しました' : '見つかりませんでした'),
        link('Web で検索', `https://www.google.com/search?q=${encodeURIComponent(`${words} BPM`)}`),
      );
    }
  }

  function renderMeasure(state, data) {
    if (state === 'measuring' && measureArea.dataset.state === 'measuring') {
      measureArea.querySelector('.ytbpm-status').textContent = data.message;
      measureArea.querySelector('.ytbpm-bar-fill').style.width = `${Math.round(data.progress * 100)}%`;
      return;
    }
    measureArea.dataset.state = state;
    measureArea.replaceChildren(el('div', 'ytbpm-heading', '実測'));
    if (state === 'measuring') {
      measureArea.append(el('div', 'ytbpm-status', data.message));
      const bar = el('div', 'ytbpm-bar');
      const fill = el('div', 'ytbpm-bar-fill');
      fill.style.width = `${Math.round(data.progress * 100)}%`;
      bar.append(fill);
      measureArea.append(bar);
    } else if (state === 'result') {
      measureArea.append(bpmValues(data.bpm));
    } else if (state === 'stopped') {
      measureArea.append(el('div', 'ytbpm-status', '中止しました'));
    } else if (state === 'error') {
      measureArea.append(el('div', 'ytbpm-error', data.message));
    }
  }

  function close() {
    stopSession();
    lookupToken++;
    renderIdle();
  }

  function start() {
    ensurePanel();
    stopSession();
    startLookup();
    startMeasure();
    renderActions();
  }

  async function startLookup() {
    const token = ++lookupToken;
    const id = videoId();
    if (!lookupCache.has(id)) {
      const { title, channel } = videoMetadata();
      renderOnline('loading');
      const promise = browser.runtime
        .sendMessage({ type: 'lookup', title, channel })
        .catch((e) => ({ found: false, error: String(e) }));
      lookupCache.set(id, promise);
    }
    const result = await lookupCache.get(id);
    if (result.error) lookupCache.delete(id);
    if (token !== lookupToken) return;
    renderOnline(result.found ? 'found' : 'missing', result);
  }

  function stopSession() {
    measureToken++;
    if (!session) return;
    const { processor, graph } = session;
    processor.onaudioprocess = null;
    try { graph.source.disconnect(processor); } catch (e) { }
    processor.disconnect();
    session = null;
  }

  function finishMeasure(state, data) {
    stopSession();
    renderMeasure(state, data);
    renderActions();
  }

  async function startMeasure() {
    const video = findVideo();
    if (!video) {
      renderMeasure('error', { message: '動画が見つかりませんでした。' });
      return;
    }

    const token = ++measureToken;

    let graph;
    try {
      graph = getAudioGraph(video);
      await graph.ctx.resume();
    } catch (e) {
      console.error('[YouTube BPM]', e);
      finishMeasure('error', { message: '音声を取得できませんでした。ページを再読み込みしてから試してください。' });
      return;
    }
    if (token !== measureToken) return;

    const detector = new YtBpm.OnsetDetector(graph.ctx.sampleRate);
    const targetFrames = Math.ceil(MEASURE_SECONDS * detector.frameRate);
    const processor = graph.ctx.createScriptProcessor(4096, 2, 1);
    const current = { processor, graph };
    session = current;

    const showProgress = (note) => {
      const elapsed = Math.floor(detector.frameCount / detector.frameRate);
      renderMeasure('measuring', {
        message: note || `測定中… ${elapsed} / ${MEASURE_SECONDS} 秒`,
        progress: detector.frameCount / targetFrames,
      });
    };

    processor.onaudioprocess = (event) => {
      if (session !== current) return;
      if (video.paused || video.seeking) {
        showProgress('動画を再生すると測定が進みます');
        return;
      }
      if (isAdPlaying()) {
        showProgress('広告終了待機中…');
        return;
      }

      const input = event.inputBuffer;
      const left = input.getChannelData(0);
      const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;
      const mono = new Float32Array(left.length);
      for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) / 2;
      detector.push(mono);

      if (detector.frameCount < targetFrames) {
        showProgress();
        return;
      }

      if (detector.rms < 1e-4) {
        finishMeasure('error', { message: 'ミュートを解除して再試行してください。' });
        return;
      }
      const result = YtBpm.estimateTempo(detector.envelope, detector.frameRate);
      if (!result) {
        finishMeasure('error', { message: 'BPM を推定できませんでした。' });
        return;
      }
      finishMeasure('result', result);
    };

    graph.source.connect(processor);
    processor.connect(graph.ctx.destination);
    showProgress(video.paused ? '動画を再生すると測定が進みます' : undefined);
    renderActions();
  }

  function onNavigate() {
    stopSession();
    lookupToken++;
    if (isVideoPage()) {
      renderIdle();
      panel.hidden = false;
    } else if (panel) {
      panel.hidden = true;
    }
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', onNavigate);
  onNavigate();
})();
