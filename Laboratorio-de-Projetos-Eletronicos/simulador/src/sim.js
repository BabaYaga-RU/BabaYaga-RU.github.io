import { applyCoupling, BUILTIN_MODELS, buildNetGraph, createTbjPreset, makeNetlist, measureWave, parseModelCards, parseSpiceNumber } from './spice-core.js';

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const svg = $('circuit'), scene = $('scene'), partsLayer = $('parts'), wiresLayer = $('wires'), previewLayer = $('wirePreview');
  const NS = 'http://www.w3.org/2000/svg';
  const paletteItems = [
    ['R', 'Resistor', 'Resistência'], ['C', 'Capacitor', 'Capacitância'], ['D', 'Diodo', 'Ânodo → cátodo'],
    ['VDC', 'Fonte DC', 'Tensão ajustável'], ['VSIN', 'Fonte senoidal', 'Amplitude, frequência e offset'],
    ['NPN', 'NPN BC548C', 'C · B · E'], ['GND', 'GND', 'Referência 0 V'], ['PROBE', 'Probe de tensão', 'Ponto de medida'],
    ['LABEL', 'Etiqueta de nó', 'Nós de mesmo nome se conectam'], ['JUNCTION', 'Junção', 'Ramificação com 4 terminais']
  ];
  const paletteMeta = Object.fromEntries(paletteItems.map(([type, name]) => [type, { name }]));
  const pinNames = { R: ['1', '2'], C: ['1', '2'], D: ['A', 'K'], VDC: ['+', '−'], VSIN: ['+', '−'], NPN: ['C', 'B', 'E'], GND: ['0'], PROBE: ['V'], LABEL: ['nó'], JUNCTION: ['N', 'E', 'S', 'W'] };
  const symbols = {
    R: 'M0 36H30l8-12 10 24 10-24 10 24 10-24 10 24 8-12h32',
    C: 'M0 36H54m0-24v48m14-48v48m0-24h60',
    D: 'M0 36h42m0-20 32 20-32 20zm32-20v40m0-20h54',
    NPN: 'M0 36H48M48 11V61M48 19L86 11H128M48 53L86 61H128M74 55l-7-3 2 8',
    VSIN: 'M49 36c6-18 12-18 18 0s12 18 18 0',
    VDC: 'M64 18v14m-7-7h14m-7 15v14m-7-7h14',
    GND: 'M64 0v20m-20 0h40m-32 9h24m-16 9h8',
    PROBE: 'M0 36H34L62 8',
    LED: 'M12 36h24m28 0h24m-34-15 20 15-20 15zm20-15v30m11-34 10-10m-4 12 4-12-12 4m12 28 10 10m-2-12 2 12-12-2',
    SW: 'M0 36H36m0 0 38-23m0 23h54',
    AND: 'M15 10H58A26 26 0 0 1 58 62H15Z',
    OR: 'M15 10Q42 36 15 62Q56 62 108 36Q56 10 15 10Z',
    NOT: 'M25 12L87 36 25 60Z',
    JUNCTION: 'M64 0v64m-64 0h128m-64 0v64'
  };

  let circuit = emptyCircuit(), selection = null, activeDrag = null, wireStart = null, pan = null, spaceDown = false, suppressPaletteClick = false;
  let view = { x: 0, y: 0, w: 1600, h: 1000 }, history = [], redoHistory = [], sim = null, lastRun = null, lastGraph = null, selectedModel = null;
  const STORAGE_KEY = 'lab-analog-circuits-v3';

  function emptyCircuit() { return { version: 3, mode: 'analog', components: [], wires: [], models: {}, nextId: 1, settings: { transient: { stop: '2m', step: '2u' }, channels: [{ probe: '', coupling: 'DC' }, { probe: '', coupling: 'DC' }] } }; }
  function esc(text) { return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
  function svgEl(tag, attrs = {}, text) { const el = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value); if (text != null) el.textContent = text; return el; }
  function pinKey(id, i) { return `${id}:${i}`; }
  function pins(part) { return pinNames[part.type] || []; }
  function pinLocal(part, index) {
    if (part.type === 'GND') return [64, 0];
    if (part.type === 'PROBE' || part.type === 'LABEL') return [0, 36];
    if (part.type === 'NPN') return index === 0 ? [128, 11] : index === 1 ? [0, 36] : [128, 61];
    if (part.type === 'JUNCTION') return [[64, 0], [128, 64], [64, 128], [0, 64]][index];
    return index === 0 ? [0, 36] : [128, 36];
  }
  function componentTransform(part) { const angle = Number(part.rotation) || 0; return `translate(${part.x} ${part.y})${angle ? ` rotate(${angle} 64 36)` : ''}`; }
  function pinWorld(part, index) {
    const [x, y] = pinLocal(part, index), angle = (Number(part.rotation) || 0) * Math.PI / 180;
    const dx = x - 64, dy = y - 36;
    return { x: part.x + 64 + dx * Math.cos(angle) - dy * Math.sin(angle), y: part.y + 36 + dx * Math.sin(angle) + dy * Math.cos(angle) };
  }
  function checkpoint() { history.push(JSON.stringify(circuit)); if (history.length > 60) history.shift(); redoHistory = []; updateHistoryButtons(); }
  function updateHistoryButtons() { $('undo').disabled = !history.length; $('redo').disabled = !redoHistory.length; }
  function restoreSnapshot(from, to) { if (!from.length) return; to.push(JSON.stringify(circuit)); circuit = JSON.parse(from.pop()); selection = null; lastRun = null; renderAll(); updateHistoryButtons(); }
  function addPart(type, x, y, properties = {}) {
    checkpoint(); const id = circuit.nextId++;
    let name = properties.name;
    if (!name) name = type === 'PROBE' ? `CH${1 + circuit.components.filter(part => part.type === 'PROBE').length}` : `${({ VDC: 'V', VSIN: 'V', NPN: 'Q', LABEL: '' })[type] ?? type}${id}`;
    const defaults = { R: { resistance: '1k' }, C: { capacitance: '100u' }, VDC: { voltage: 5 }, VSIN: { amp: 1, freq: 1000, offset: 0 }, NPN: { model: 'BC548C' } };
    circuit.components.push({ id, type, name, x: Math.round(x / 20) * 20, y: Math.round(y / 20) * 20, ...(defaults[type] || {}), ...properties });
    selection = id; lastRun = null; renderAll(); setStatus(`${name} inserido. Passe o cursor nos terminais para ver seus nomes.`);
  }
  function partSymbol(part, mini = false) {
    const g = svgEl('g', { class: 'component-symbol' });
    const yOffset = mini ? 0 : 0;
    const circle = ['VDC', 'VSIN'].includes(part.type);
    if (circle) g.append(svgEl('circle', { class: 'component-body', cx: 64, cy: 36, r: 24 }));
    if (part.type === 'SW') g.append(svgEl('rect', { class: 'component-body', x: 30, y: 22, width: 68, height: 28, rx: 4 }));
    if (part.type === 'AND' || part.type === 'OR' || part.type === 'NOT') g.append(svgEl('path', { class: 'component-body', d: symbols[part.type] }));
    if (part.type === 'JUNCTION') g.append(svgEl('circle', { class: 'component-body', cx: 64, cy: 64, r: 7 }));
    if (part.type === 'LABEL') {
      g.append(svgEl('path', { class: 'label-flag', d: 'M0 36H28V20H78L92 36 78 52H28V36' }));
      g.append(svgEl('text', { class: 'label-name', x: 55, y: 40, 'text-anchor': 'middle' }, part.name || 'Nó'));
    } else if (part.type === 'PROBE') {
      g.append(svgEl('path', { class: 'symbol-line', d: 'M0 36H34L62 8' }));
      g.append(svgEl('circle', { class: 'probe-tip', cx: 65, cy: 7, r: 5 }));
    } else if (part.type === 'GND') {
      g.append(svgEl('path', { class: 'symbol-line', d: symbols.GND }));
    } else if (part.type === 'NPN') {
      g.append(svgEl('path', { class: 'symbol-line', d: symbols.NPN }));
    } else if (part.type === 'R' || part.type === 'C' || part.type === 'D' || part.type === 'VSIN' || part.type === 'VDC') {
      g.append(svgEl('path', { class: 'symbol-line', d: symbols[part.type] }));
    } else if (part.type === 'LED') {
      g.append(svgEl('path', { class: 'symbol-line', d: symbols.LED }));
      g.append(svgEl('circle', { class: 'led-lens', cx: 50, cy: 36, r: 8, fill: part.level ? '#67e7aa' : '#24333d' }));
    } else if (part.type === 'SW') {
      g.append(svgEl('path', { class: 'symbol-line', d: part.value ? 'M0 36H42m0 0h44m0 0h42' : 'M0 36H42m0 0 40-24m0 24h46' }));
      g.append(svgEl('circle', { class: 'switch-contact', cx: 42, cy: 36, r: 4 }));
      g.append(svgEl('circle', { class: 'switch-contact', cx: 82, cy: 12, r: 4 }));
    }
    if (part.type === 'VSIN') g.append(svgEl('path', { class: 'source-wave', d: 'M49 36c6-15 12-15 18 0s12 15 18 0' }));
    if (part.type === 'VDC') g.append(svgEl('g', {}, null));
    if (part.type === 'AND' || part.type === 'OR' || part.type === 'NOT') {
      const label = part.type;
      g.append(svgEl('text', { class: 'gate-label', x: 62, y: 40, 'text-anchor': 'middle' }, label));
      if (['NAND', 'NOR', 'XNOR'].includes(part.type)) g.append(svgEl('circle', { cx: 118, cy: 36, r: 5, fill: '#101923', stroke: '#e8f0f4', 'stroke-width': 2 }));
    }
    if (!mini && part.type !== 'GND' && part.type !== 'JUNCTION') {
      const value = part.type === 'R' ? part.resistance : part.type === 'C' ? part.capacitance : part.type === 'VDC' ? `${part.voltage} V` : part.type === 'VSIN' ? `${part.amp} Vp · ${part.freq} Hz` : part.type === 'NPN' ? part.model : '';
      g.append(svgEl('text', { class: 'component-name', x: 64, y: part.type === 'LABEL' ? 71 : 86, 'text-anchor': 'middle' }, part.type === 'LABEL' ? '' : (part.name || '')));
      if (value) g.append(svgEl('text', { class: 'component-value', x: 64, y: 101, 'text-anchor': 'middle' }, String(value)));
    }
    return g;
  }
  function pinNamesNear(part, index) {
    if (part.type === 'NPN') return ['C', 'B', 'E'][index];
    return pins(part)[index] || '';
  }
  function renderPart(part) {
    const g = svgEl('g', { class: `component${selection === part.id ? ' selected' : ''}`, transform: componentTransform(part), 'data-id': part.id, tabindex: 0 });
    g.append(partSymbol(part));
    const angle = Number(part.rotation) || 0;
    if (angle) for (const text of g.querySelectorAll('text')) {
      const x = text.getAttribute('x') || 0, y = text.getAttribute('y') || 0;
      text.setAttribute('transform', `rotate(${-angle} ${x} ${y})`);
    }
    pins(part).forEach((pin, index) => {
      const [x, y] = pinLocal(part, index);
      const circle = svgEl('circle', { class: 'pin', cx: x, cy: y, r: 6, 'data-pin': pinKey(part.id, index) });
      circle.append(svgEl('title', {}, pinNamesNear(part, index)));
      g.append(circle);
      const label = pinNamesNear(part, index);
      if (label && !['JUNCTION', 'LABEL'].includes(part.type)) g.append(svgEl('text', { class: 'terminal-name', x: x + (x < 64 ? -5 : 5), y: y - 9, 'text-anchor': x < 64 ? 'end' : 'start' }, label));
      circle.addEventListener('click', event => {
        event.stopPropagation();
        const p = pinWorld(part, index);
        if (lastRun) setStatus(`${part.name} · terminal ${label} · ${formatVolts(lastRun.valuesByNode.get(lastRun.graph.node(pinKey(part.id, index))) ?? (lastRun.graph.node(pinKey(part.id, index)) === '0' ? 0 : NaN))}`);
      });
    });
    g.addEventListener('pointerdown', event => {
      if (event.target.closest('.pin')) return;
      if (event.button === 1 || spaceDown) { beginPan(event); return; }
      event.preventDefault(); selection = part.id; activeDrag = { id: part.id, start: worldPoint(event), x: part.x, y: part.y, snapshot: JSON.stringify(circuit), moved: false }; renderProperties();
    });
    g.addEventListener('dblclick', event => { event.stopPropagation(); selection = part.id; renderAll(); $('propertiesPanel').scrollIntoView({ block: 'nearest' }); $('properties').querySelector('input,select')?.focus(); });
    g.addEventListener('click', event => { if (event.target.closest('.pin') || activeDrag?.moved) return; selection = part.id; renderProperties(); renderParts(); });
    partsLayer.append(g);
  }
  function renderWire(wire) {
    const startPart = circuit.components.find(part => String(part.id) === String(wire.a).split(':')[0]);
    const endPart = circuit.components.find(part => String(part.id) === String(wire.b).split(':')[0]);
    if (!startPart || !endPart) return;
    const a = pinWorld(startPart, Number(wire.a.split(':')[1])), b = pinWorld(endPart, Number(wire.b.split(':')[1]));
    const mid = Math.round((a.x + b.x) / 2);
    let d;
    if (wire.points?.length) {
      const vertices = [a];
      for (const [x, y] of wire.points) {
        const previous = vertices[vertices.length - 1];
        if (previous.x !== x && previous.y !== y) vertices.push({ x, y: previous.y });
        vertices.push({ x, y });
      }
      const previous = vertices[vertices.length - 1];
      if (previous.x !== b.x && previous.y !== b.y) vertices.push({ x: b.x, y: previous.y });
      vertices.push(b);
      d = vertices.map(({ x, y }, index) => `${index ? 'L' : 'M'}${x} ${y}`).join('');
    } else d = `M${a.x} ${a.y}H${mid}V${b.y}H${b.x}`;
    const path = svgEl('path', { class: `wire${selection === wire.id ? ' selected' : ''}`, d, 'data-wire': wire.id });
    path.addEventListener('click', event => { event.stopPropagation(); selection = wire.id; renderProperties(); renderWires(); });
    wiresLayer.append(path);
  }
  function renderWires() { wiresLayer.replaceChildren(); circuit.wires.forEach(renderWire); }
  function renderParts() { partsLayer.replaceChildren(); circuit.components.forEach(renderPart); }
  function renderAll() { renderWires(); renderParts(); populateChannels(); refreshNetlist(); updateTbjTools(); renderProperties(); }
  function worldPoint(event) { const p = svg.createSVGPoint(); p.x = event.clientX; p.y = event.clientY; const ctm = svg.getScreenCTM(); if (!ctm) return { x: 0, y: 0 }; const out = p.matrixTransform(ctm.inverse()); return { x: out.x, y: out.y }; }
  function setStatus(message, kind = '') { $('engineStatus').textContent = message; $('engineStatus').className = `engine-status ${kind}`; }

  function renderPalette() {
    const host = $('palette'); host.replaceChildren();
    for (const [type, label, hint] of paletteItems) {
      const button = document.createElement('button'); button.className = 'part'; button.draggable = true; button.title = hint;
      const icon = document.createElementNS(NS, 'svg'); icon.setAttribute('viewBox', '0 0 128 72'); icon.classList.add('part-icon');
      if (['VDC', 'VSIN'].includes(type)) icon.append(svgEl('circle', { class: 'component-body', cx: 64, cy: 36, r: 24 }));
      if (['AND', 'OR', 'NOT'].includes(type)) icon.append(svgEl('path', { class: 'component-body', d: symbols[type] }));
      if (type === 'R' || type === 'C' || type === 'D' || type === 'NPN' || type === 'GND' || type === 'PROBE' || type === 'VSIN') icon.append(svgEl('path', { class: 'symbol-line', d: symbols[type] }));
      if (type === 'VDC') icon.append(svgEl('path', { class: 'symbol-line', d: symbols.VDC }));
      if (type === 'LABEL') { icon.append(svgEl('path', { class: 'label-flag', d: 'M0 36H28V20H78L92 36 78 52H28V36' })); icon.append(svgEl('text', { class: 'label-name', x: 55, y: 40, 'text-anchor': 'middle' }, 'Nó')); }
      if (type === 'JUNCTION') icon.append(svgEl('path', { class: 'symbol-line', d: symbols.JUNCTION }));
      if (type === 'PROBE') icon.append(svgEl('circle', { class: 'probe-tip', cx: 65, cy: 7, r: 5 }));
      if (type === 'GND') icon.append(svgEl('path', { class: 'symbol-line', d: symbols.GND }));
      const copy = document.createElement('span'); copy.className = 'part-copy'; copy.innerHTML = `<b>${esc(label)}</b><small>${esc(hint)}</small>`;
      button.append(icon, copy);
      button.addEventListener('dragstart', event => { suppressPaletteClick = true; event.dataTransfer.setData('text/plain', type); event.dataTransfer.effectAllowed = 'copy'; });
      button.addEventListener('dragend', () => setTimeout(() => { suppressPaletteClick = false; }, 0));
      button.addEventListener('click', () => { if (suppressPaletteClick) return; const center = { x: view.x + view.w * .48, y: view.y + view.h * .48 }; addPart(type, center.x, center.y); });
      host.append(button);
    }
  }
  function beginPan(event) { event.preventDefault(); pan = { start: worldPoint(event), x: view.x, y: view.y }; svg.style.cursor = 'grabbing'; }
  function applyView() { svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); }
  function zoom(factor, at = { x: view.x + view.w / 2, y: view.y + view.h / 2 }) {
    const nextW = Math.max(250, Math.min(5000, view.w * factor)), nextH = nextW * (view.h / view.w);
    const rx = (at.x - view.x) / view.w, ry = (at.y - view.y) / view.h;
    view = { x: at.x - rx * nextW, y: at.y - ry * nextH, w: nextW, h: nextH }; applyView();
  }
  function fitView(reset = false) {
    if (reset || !circuit.components.length) { view = { x: 0, y: 0, w: 1600, h: 1000 }; applyView(); return; }
    const xs = circuit.components.map(part => part.x), ys = circuit.components.map(part => part.y);
    const minX = Math.min(...xs) - 100, minY = Math.min(...ys) - 60, maxX = Math.max(...xs) + 150, maxY = Math.max(...ys) + 80;
    view = { x: minX, y: minY, w: Math.max(900, maxX - minX), h: Math.max(650, maxY - minY) }; applyView();
  }
  svg.addEventListener('dragover', event => { event.preventDefault(); $('canvasWrap').classList.add('drop-active'); });
  svg.addEventListener('dragleave', () => $('canvasWrap').classList.remove('drop-active'));
  svg.addEventListener('drop', event => { event.preventDefault(); $('canvasWrap').classList.remove('drop-active'); const type = event.dataTransfer.getData('text/plain'); if (paletteMeta[type]) { const p = worldPoint(event); addPart(type, p.x - 64, p.y - 36); } });
  svg.addEventListener('pointerdown', event => {
    const pin = event.target.closest?.('.pin');
    if (pin) { wireStart = pin.dataset.pin; selection = null; const p = worldPoint(event); previewLayer.replaceChildren(svgEl('path', { class: 'wire-preview', d: `M${p.x} ${p.y}L${p.x} ${p.y}` })); $('canvasTip').textContent = `Ligando terminal ${pin.querySelector('title')?.textContent || ''}… solte no terminal de destino`; event.preventDefault(); return; }
    if (event.button === 1 || spaceDown) { beginPan(event); return; }
    if (event.button === 0 && (event.target === svg || event.target.id === 'gridBackground' || event.target === scene)) { selection = null; renderProperties(); beginPan(event); svg.style.cursor = 'grabbing'; }
  });
  svg.addEventListener('pointermove', event => {
    if (activeDrag) { const current = worldPoint(event), part = circuit.components.find(item => item.id === activeDrag.id); if (!part) return; const dx = current.x - activeDrag.start.x, dy = current.y - activeDrag.start.y; activeDrag.moved ||= Math.hypot(dx, dy) > 2; if (activeDrag.moved) { part.x = activeDrag.x + dx; part.y = activeDrag.y + dy; const group = partsLayer.querySelector(`[data-id="${part.id}"]`); group?.setAttribute('transform', componentTransform(part)); renderWires(); } }
    if (wireStart) { const source = wireStart.split(':').map(Number), part = circuit.components.find(item => item.id === source[0]), start = pinWorld(part, source[1]), p = worldPoint(event), mid = Math.round((start.x + p.x) / 2); previewLayer.replaceChildren(svgEl('path', { class: 'wire-preview', d: `M${start.x} ${start.y}H${mid}V${p.y}H${p.x}` })); }
    if (pan) { const now = worldPoint(event); view.x = pan.x - (now.x - pan.start.x); view.y = pan.y - (now.y - pan.start.y); applyView(); }
  });
  svg.addEventListener('pointerup', event => {
    if (activeDrag) { const move = activeDrag; activeDrag = null; if (move.moved) { history.push(move.snapshot); if (history.length > 60) history.shift(); redoHistory = []; const part = circuit.components.find(item => item.id === move.id); if (part) { part.x = Math.round(part.x / 10) * 10; part.y = Math.round(part.y / 10) * 10; renderAll(); updateHistoryButtons(); } } return; }
    if (wireStart) {
      const target = event.target.closest?.('.pin')?.dataset.pin;
      if (target && target !== wireStart) { checkpoint(); circuit.wires.push({ id: `w${Date.now()}${Math.random().toString(16).slice(2, 6)}`, a: wireStart, b: target }); selection = null; lastRun = null; renderAll(); setStatus('Ligação criada. Terminais compartilhados formam o mesmo nó.'); }
      else setStatus('Para concluir, solte sobre um terminal destacado.');
      wireStart = null; previewLayer.replaceChildren(); $('canvasTip').textContent = 'Arraste de um terminal para outro; espaço + arraste move a folha.';
    }
    pan = null; svg.style.cursor = spaceDown ? 'grab' : '';
  });
  svg.addEventListener('pointercancel', () => { activeDrag = null; wireStart = null; pan = null; previewLayer.replaceChildren(); svg.style.cursor = spaceDown ? 'grab' : ''; });
  svg.addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY < 0 ? .85 : 1.18, worldPoint(event)); }, { passive: false });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('canvas-expanded')) { event.preventDefault(); setCanvasExpanded(false); return; }
    if (event.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { spaceDown = true; svg.style.cursor = 'grab'; event.preventDefault(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); restoreSnapshot(event.shiftKey ? redoHistory : history, event.shiftKey ? history : redoHistory); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); restoreSnapshot(redoHistory, history); }
    else if (['Delete', 'Backspace'].includes(event.key) && selection && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { event.preventDefault(); deleteSelected(); }
  });
  window.addEventListener('keyup', event => { if (event.code === 'Space') { spaceDown = false; svg.style.cursor = ''; } });
  window.addEventListener('blur', () => { spaceDown = false; pan = null; });
  $('zoomIn').onclick = () => zoom(.8); $('zoomOut').onclick = () => zoom(1.25); $('fitView').onclick = () => fitView(); $('resetView').onclick = () => fitView(true);

  function deleteSelected() {
    if (!selection) return; checkpoint();
    if (typeof selection === 'number') { circuit.components = circuit.components.filter(part => part.id !== selection); circuit.wires = circuit.wires.filter(wire => ![wire.a, wire.b].some(pin => Number(pin.split(':')[0]) === selection)); }
    else circuit.wires = circuit.wires.filter(wire => wire.id !== selection);
    selection = null; lastRun = null; renderAll(); renderProperties();
  }
  function renderProperties() {
    const host = $('properties'); host.replaceChildren();
    const part = circuit.components.find(item => item.id === selection);
    if (!part) {
      const wire = circuit.wires.find(item => item.id === selection);
      host.innerHTML = wire ? '<p>Ligação selecionada · Delete remove somente este fio.</p>' : '<p class="empty-state">Selecione um componente ou uma ligação.</p>';
      $('selectionHint').textContent = wire ? 'Fio selecionado · Delete para remover' : 'Solte componentes na grade ou clique na biblioteca';
      return;
    }
    $('selectionHint').textContent = `${part.name} · ${paletteMeta[part.type]?.name || part.type}`;
    const title = document.createElement('p'); title.textContent = `${part.name} · ${paletteMeta[part.type]?.name || part.type}`; host.append(title);
    propertyField(host, 'Referência / nome', part.name, 'text', value => { part.name = value; lastRun = null; renderParts(); populateChannels(); refreshNetlist(); });
    if (part.type === 'R') propertyField(host, 'Resistência (Ω)', part.resistance, 'text', value => { part.resistance = value; changedPart(); });
    if (part.type === 'C') propertyField(host, 'Capacitância (F)', part.capacitance, 'text', value => { part.capacitance = value; changedPart(); });
    if (part.type === 'VDC') propertyField(host, 'Tensão (V)', part.voltage, 'text', value => { part.voltage = value; changedPart(); });
    if (part.type === 'VSIN') {
      propertyField(host, 'Amplitude de pico (V)', part.amp, 'text', value => { part.amp = value; changedPart(); });
      propertyField(host, 'Frequência (Hz)', part.freq, 'text', value => { part.freq = value; changedPart(); });
      propertyField(host, 'Offset DC (V)', part.offset, 'text', value => { part.offset = value; changedPart(); });
    }
    if (part.type === 'NPN') {
      const label = document.createElement('label'); label.textContent = 'Modelo SPICE (pinos C · B · E)'; const select = document.createElement('select');
      for (const name of new Set(['BC548C', ...Object.keys(circuit.models || {})])) { const option = document.createElement('option'); option.value = name; option.textContent = name; option.selected = name.toUpperCase() === String(part.model || 'BC548C').toUpperCase(); select.append(option); }
      select.onchange = () => { part.model = select.value; changedPart(); }; label.append(select); host.append(label);
    }
    if (part.type === 'PROBE') propertyField(host, 'Nome do ponto', part.name, 'text', value => { part.name = value; changedPart(); populateChannels(); });
    if (part.type === 'LABEL') propertyField(host, 'Nome do nó', part.name, 'text', value => { part.name = value; changedPart(); });
    if (part.type === 'SW') propertyField(host, 'Nível lógico', part.value ? 1 : 0, 'number', value => { part.value = Number(value) ? 1 : 0; changedPart(); });
    if (part.type === 'NPN') { const hint = document.createElement('p'); hint.textContent = 'Ordem SPICE: coletor, base, emissor. O emissor deve ir ao nó de referência conforme o roteiro.'; host.append(hint); }
    const remove = document.createElement('button'); remove.className = 'delete-part'; remove.textContent = 'Excluir componente e seus fios'; remove.onclick = deleteSelected; host.append(remove);
  }
  function changedPart() { lastRun = null; renderParts(); refreshNetlist(); }
  function propertyField(host, labelText, value, type, change) {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = document.createElement('input'); input.type = type; input.value = value ?? ''; input.spellcheck = false;
    input.addEventListener('focus', checkpoint, { once: true });
    input.addEventListener('change', () => change(input.value)); label.append(input); host.append(label);
  }
  function graphAndCards(analysisType = selectedAnalysis()) {
    const modelCards = { ...BUILTIN_MODELS, ...(circuit.models || {}) };
    return makeNetlist({ circuit, analysis: analysisType, transient: { stop: $('tranStop').value, step: $('tranStep').value }, modelCards });
  }
  function selectedAnalysis() { return document.querySelector('[data-tab].active')?.dataset.tab || 'dc'; }
  function refreshNetlist() {
    try { const { netlist, graph } = graphAndCards(); $('netlistText').textContent = netlist; lastGraph = graph; }
    catch (error) { $('netlistText').textContent = `* Netlist pendente: ${error.message}`; }
  }

  function populateChannels() {
    if (!$('probe1')) return;
    const probes = circuit.components.filter(part => part.type === 'PROBE');
    for (const [id, slot] of [['probe1', 0], ['probe2', 1]]) {
      const select = $(id), old = circuit.settings?.channels?.[slot]?.probe || select.value;
      select.replaceChildren(); const off = document.createElement('option'); off.value = ''; off.textContent = slot ? 'Canal desligado' : 'Selecione probe'; select.append(off);
      for (const probe of probes) { const option = document.createElement('option'); option.value = String(probe.id); option.textContent = probe.name; select.append(option); }
      select.value = [...select.options].some(option => option.value === old) ? old : '';
      const coupling = $(`coupling${slot + 1}`); if (circuit.settings?.channels?.[slot]) coupling.value = circuit.settings.channels[slot].coupling || 'DC';
    }
  }
  for (const id of ['probe1', 'probe2', 'coupling1', 'coupling2']) $(id).addEventListener('change', () => {
    const channels = [1, 2].map(slot => ({ probe: $(`probe${slot}`).value, coupling: $(`coupling${slot}`).value })); circuit.settings.channels = channels; renderScope();
  });

  function traceValues(result, name) {
    const trace = (result?.data || []).find(item => item.name?.toLowerCase().replace(/\s/g, '') === name.toLowerCase().replace(/\s/g, ''));
    return trace?.values || null;
  }
  function scalar(value) { if (typeof value === 'number') return value; if (value && Number.isFinite(value.real)) return value.real; if (value && Number.isFinite(value.re)) return value.re; return Number(value); }
  function valuesForNode(result, node) {
    if (node === '0') return [0];
    return traceValues(result, `v(${node})`) || [];
  }
  async function getEngine() {
    if (!sim) { const { Simulation: Engine } = await import('eecircuit-engine'); sim = new Engine(); }
    if (!sim.isInitialized?.()) { setStatus('Inicializando ngspice WebAssembly…', 'busy'); await sim.start(); }
    return sim;
  }
  async function runSpice(analysisType, { quiet = false } = {}) {
    if (!quiet) { $('run').disabled = true; setStatus(`Executando ngspice · ${analysisType === 'dc' ? 'ponto DC' : 'transiente'}…`, 'busy'); }
    let netlist = '';
    try {
      const built = makeNetlist({ circuit, analysis: analysisType, transient: { stop: $('tranStop').value, step: $('tranStep').value }, modelCards: { ...BUILTIN_MODELS, ...(circuit.models || {}) } });
      netlist = built.netlist;
      const { graph } = built;
      $('netlistText').textContent = netlist;
      const engine = await getEngine(); engine.setNetList(netlist); const result = await engine.runSim();
      const errors = engine.getError?.() || [], info = engine.getInfo?.() || '';
      $('technicalOutput').textContent = `${info}${errors.length ? `\n\nERROS NGSPICE:\n${errors.join('\n')}` : '\n\nSem erro reportado pelo ngspice.'}`;
      if (errors.length) throw new Error(errors.join('\n'));
      if (!result?.data?.length) throw new Error('O ngspice terminou sem retornar vetores de resultado.');
      const timeTrace = analysisType === 'dc' ? [] : (result.data.find(item => item.name?.toLowerCase() === 'time' || item.type === 'time')?.values || []);
      const probes = circuit.components.filter(part => part.type === 'PROBE');
      const samples = analysisType === 'dc' ? 1 : timeTrace.length;
      const rows = Array.from({ length: samples }, (_, i) => ({ time: scalar(timeTrace[i]) }));
      const valuesByNode = new Map();
      const nodes = new Set(probes.map(probe => graph.node(`${probe.id}:0`)));
      for (const node of nodes) {
        const raw = valuesForNode(result, node), values = node === '0' ? Array(samples).fill(0) : raw.map(scalar);
        if (analysisType === 'dc') valuesByNode.set(node, values[0]);
        else for (let index = 0; index < samples; index++) rows[index][node] = values[index];
      }
      const data = { result, rows, probes, graph, valuesByNode, analysis: analysisType, netlist, info, errors };
      if (analysisType === 'dc') renderDc(data);
      else { lastRun = data; renderScope(); renderTransient(); }
      lastRun = data; lastGraph = graph; return data;
    } catch (error) {
      if (netlist) $('netlistText').textContent = netlist;
      $('technicalDetails').open = true;
      const engineOutput = $('technicalOutput').textContent;
      $('technicalOutput').textContent = `${netlist ? `NETLIST UTILIZADO:\n${netlist}\n\n` : 'NETLIST NÃO GERADO:\n'}${engineOutput}\n\nERRO TÉCNICO:\n${error?.stack || error}`;
      if (!quiet) setStatus(`Falha na simulação: ${error.message}`, 'error');
      throw error;
    } finally { if (!quiet) $('run').disabled = false; }
  }
  async function simulate() {
    const kind = selectedAnalysis();
    try { await runSpice(kind); setStatus(`Simulação ${kind === 'dc' ? 'DC concluída' : 'transiente concluída'} · resultado retornado pelo ngspice.`, ''); }
    catch (error) { console.error('SPICE run failed', error); }
  }
  function formatVolts(value) { return Number.isFinite(value) ? `${value.toFixed(Math.abs(value) < .01 ? 6 : 4)} V` : 'sem leitura; confira probe, referência e netlist'; }
  function renderDc(data) {
    const body = $('dcTable').querySelector('tbody'); body.replaceChildren();
    for (const probe of data.probes) {
      const node = data.graph.node(`${probe.id}:0`), voltage = data.valuesByNode.get(node) ?? (node === '0' ? 0 : NaN), row = document.createElement('tr');
      row.innerHTML = `<td>${esc(probe.name)}</td><td>${esc(node)}</td><td><b>${esc(formatVolts(voltage))}</b></td>`; body.append(row);
    }
    $('dcSummary').textContent = `${data.probes.length} probes · análise .op executada no ngspice. Altere V1 ou os componentes e simule novamente.`;
  }
  function activeChannelData(slot) {
    if (!lastRun || lastRun.analysis !== 'transient') return null;
    const selectedId = $(`probe${slot}`).value; if (!selectedId) return null;
    const probe = lastRun.probes.find(part => String(part.id) === selectedId); if (!probe) return null;
    const node = lastRun.graph.node(`${probe.id}:0`), coupling = $(`coupling${slot}`).value;
    const raw = node === '0' ? lastRun.rows.map(() => 0) : lastRun.rows.map(row => row[node]);
    const values = applyCoupling(raw, coupling);
    const times = lastRun.rows.map(row => row.time);
    return { id: selectedId, probe, node, coupling, values, times, metrics: measureWave(values, times), rawMetrics: measureWave(raw, times) };
  }
  function drawChart(canvas, channelData, { exportMode = false } = {}) {
    const ctx = canvas.getContext('2d'), width = canvas.width, height = canvas.height;
    ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#09141a'; ctx.fillRect(0, 0, width, height);
    const pad = { l: exportMode ? 130 : 88, r: exportMode ? 110 : 88, t: exportMode ? 105 : 34, b: exportMode ? 115 : 55 };
    const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    ctx.font = `${exportMode ? 22 : 13}px system-ui`; ctx.fillStyle = '#e9f1f5'; ctx.fillText(exportMode ? 'Osciloscópio · simulação ngspice' : 'Tensão em função do tempo', pad.l, exportMode ? 40 : 18);
    if (!channelData.some(Boolean)) { ctx.fillStyle = '#9eafbb'; ctx.fillText('Execute a análise transiente e escolha probes para exibir curvas.', pad.l, pad.t + 30); return; }
    const first = channelData.find(Boolean); const x0 = Math.min(...first.times.filter(Number.isFinite)), x1 = Math.max(...first.times.filter(Number.isFinite));
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return;
    ctx.strokeStyle = '#263b47'; ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) { const x = pad.l + plotW * i / 10; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + plotH); ctx.stroke(); }
    for (let i = 0; i <= 8; i++) { const y = pad.t + plotH * i / 8; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + plotW, y); ctx.stroke(); }
    ctx.strokeStyle = '#8ba0ab'; ctx.beginPath(); ctx.rect(pad.l, pad.t, plotW, plotH); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = '#c5d1d7';
    for (let i = 0; i <= 10; i++) { const time = x0 + (x1 - x0) * i / 10, label = formatTime(time); ctx.fillText(label, pad.l + plotW * i / 10, pad.t + plotH + (exportMode ? 34 : 20)); }
    ctx.fillText('Tempo (s)', pad.l + plotW / 2, height - (exportMode ? 38 : 12));
    ctx.textAlign = 'left';
    const colors = ['#f2c96a', '#65dbe8'];
    channelData.forEach((channel, index) => {
      if (!channel) return;
      const finite = channel.values.filter(Number.isFinite); if (!finite.length) return;
      let min = Math.min(...finite), max = Math.max(...finite); if (min === max) { const padY = Math.max(Math.abs(min) * .05, 1e-3); min -= padY; max += padY; }
      const range = max - min, color = colors[index];
      ctx.strokeStyle = color; ctx.lineWidth = exportMode ? 4 : 2.5; ctx.beginPath(); let started = false;
      for (let i = 0; i < channel.values.length; i++) {
        const value = channel.values[i], time = channel.times[i]; if (!Number.isFinite(value) || !Number.isFinite(time)) continue;
        const x = pad.l + (time - x0) / (x1 - x0) * plotW, y = pad.t + (max - value) / range * plotH;
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
      ctx.stroke();
      ctx.fillStyle = color; ctx.font = `${exportMode ? 20 : 11}px system-ui`; ctx.fillText(`${index + 1}: ${channel.probe.name} · ${channel.coupling} · ${(range / 8).toPrecision(3)} V/div`, pad.l + 8, pad.t + 20 + index * (exportMode ? 30 : 17));
      ctx.textAlign = 'right'; ctx.fillStyle = color; ctx.font = `${exportMode ? 17 : 10}px system-ui`;
      for (let t = 0; t <= 4; t++) { const value = max - range * t / 4; ctx.fillText(`${value.toPrecision(3)} V`, pad.l + plotW + pad.r - 4, pad.t + plotH * t / 4 + 4); }
      ctx.textAlign = 'left';
      if (exportMode) {
        const m = channel.metrics || measureWave(channel.values, channel.times);
        const f = m.frequency ? `${(m.frequency / 1000).toPrecision(4)} kHz medidos` : '';
        ctx.fillStyle = color; ctx.font = '16px system-ui';
        ctx.fillText(`CH${index + 1} ${channel.probe.name} · Vmax ${m.max.toPrecision(5)} V · Vmin ${m.min.toPrecision(5)} V · Vpp ${m.vpp.toPrecision(5)} V · Vp ${m.peak.toPrecision(5)} V · média ${m.mean.toPrecision(5)} V${f ? ` · ${f}` : ''}`, pad.l + 8, 75 + index * 23);
      }
    });
    ctx.textAlign = 'left';
  }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const abs = Math.abs(seconds);
    if (abs >= 1) return `${seconds.toFixed(2)}s`;
    if (abs >= 1e-3) return `${(seconds * 1e3).toPrecision(3)}m`;
    if (abs >= 1e-6) return `${(seconds * 1e6).toPrecision(3)}µ`;
    return `${(seconds * 1e9).toPrecision(3)}n`;
  }
  function renderScope() { drawChart($('scope'), [activeChannelData(1), activeChannelData(2)]); renderReadings(); }
  function renderTransient() {
    const all = lastRun?.probes || [], channels = all.slice(0, 2).map((probe, index) => {
      const node = lastRun.graph.node(`${probe.id}:0`), raw = node === '0' ? lastRun.rows.map(() => 0) : lastRun.rows.map(row => row[node]);
      const coupling = 'DC', values = applyCoupling(raw, coupling), times = lastRun.rows.map(row => row.time);
      return { probe, node, coupling, values, times, metrics: measureWave(values, times), index };
    });
    drawChart($('transientPlot'), [channels[0] || null, channels[1] || null]);
  }
  function renderReadings() {
    const host = $('readings'); host.replaceChildren();
    [activeChannelData(1), activeChannelData(2)].forEach((channel, index) => {
      if (!channel) return;
      const m = channel.metrics, chip = document.createElement('div'); chip.className = 'reading'; chip.style.color = index ? '#65dbe8' : '#f2c96a';
      const freq = m.frequency ? `${(m.frequency / 1000).toPrecision(4)} kHz (medida)` : `${parseSpiceNumber(circuit.components.find(part => String(part.id) === channel.id)?.freq, NaN) / 1000} kHz (configurada)`;
      chip.innerHTML = `<b>CH${index + 1} · ${esc(channel.probe.name)} · ${channel.coupling}</b><br>Vmax ${m.max.toPrecision(5)} V · Vmin ${m.min.toPrecision(5)} V · Vpp ${m.vpp.toPrecision(5)} V · Vp ${m.peak.toPrecision(5)} V · média ${m.mean.toPrecision(5)} V · ${esc(freq)}`;
      host.append(chip);
    });
  }
  function exportPng(source) {
    const channels = source === 'scope' ? [activeChannelData(1), activeChannelData(2)] : (() => {
      if (!lastRun || lastRun.analysis !== 'transient') return [null, null];
      const all = lastRun.probes.slice(0, 2).map(probe => { const node = lastRun.graph.node(`${probe.id}:0`), raw = node === '0' ? lastRun.rows.map(() => 0) : lastRun.rows.map(row => row[node]), times = lastRun.rows.map(row => row.time); return { probe, node, coupling: 'DC', values: raw, times, metrics: measureWave(raw, times) }; }); return [all[0] || null, all[1] || null];
    })();
    if (!channels.some(Boolean)) { setStatus('Rode uma análise transiente antes de exportar o gráfico.', 'error'); return; }
    const canvas = document.createElement('canvas'); canvas.width = 2800; canvas.height = 1120; drawChart(canvas, channels, { exportMode: true });
    const link = document.createElement('a'); link.download = source === 'scope' ? 'osciloscopio.png' : 'transiente.png'; link.href = canvas.toDataURL('image/png'); link.click();
  }

  function updateTbjTools() {
    const present = circuit.components.some(part => part.type === 'NPN'); $('tbjTools').hidden = !present;
  }
  async function adjustV1() {
    const source = circuit.components.find(part => part.type === 'VDC' && part.name.toUpperCase() === 'V1');
    if (!source) { $('adjustStatus').textContent = 'Carregue o preset TBJ primeiro.'; return; }
    $('adjustV1').disabled = true; const initial = source.voltage; checkpoint();
    try {
      let lo = 0, hi = 10, best = null;
      for (let i = 0; i < 14; i++) {
        source.voltage = (lo + hi) / 2;
        const data = await runSpice('dc', { quiet: true }); const probe = data.probes.find(part => part.name.toUpperCase() === 'C'); if (!probe) throw new Error('Probe C não está conectado.');
        const vc = data.valuesByNode.get(data.graph.node(`${probe.id}:0`)); best = { voltage: source.voltage, vc };
        if (vc > 5) lo = source.voltage; else hi = source.voltage;
      }
      source.voltage = best.voltage; checkpoint(); renderAll(); renderProperties(); $('adjustStatus').textContent = `SPICE encontrou V1=${best.voltage.toFixed(4)} V → VC=${best.vc.toFixed(4)} V.`;
    } catch (error) { source.voltage = initial; $('adjustStatus').textContent = `Ajuste interrompido: ${error.message}`; }
    finally { $('adjustV1').disabled = false; }
  }
  async function adjustVsig() {
    const source = circuit.components.find(part => part.type === 'VSIN' && part.name.toUpperCase() === 'VSIG');
    if (!source) { $('adjustStatus').textContent = 'Carregue o preset TBJ primeiro.'; return; }
    $('adjustVsig').disabled = true; const initial = source.amp; checkpoint(); $('tranStop').value = '5m'; $('tranStep').value = '2u';
    try {
      let lo = 0, hi = 1, best = null;
      for (let i = 0; i < 9; i++) {
        source.amp = (lo + hi) / 2;
        const data = await runSpice('transient', { quiet: true }), probe = data.probes.find(part => part.name.toUpperCase() === 'C');
        if (!probe) throw new Error('Probe C não está conectado.');
        const node = data.graph.node(`${probe.id}:0`), raw = data.rows.map(row => row[node]), values = applyCoupling(raw, 'AC'), stats = measureWave(values, data.rows.map(row => row.time));
        best = { amplitude: source.amp, vp: stats.peak }; if (stats.peak < 1) lo = source.amp; else hi = source.amp;
      }
      source.amp = best.amplitude; renderAll(); renderProperties(); $('adjustStatus').textContent = `Varredura ngspice: VSIG=${best.amplitude.toPrecision(4)} Vp → VC(ac)=${best.vp.toPrecision(4)} Vp.`;
    } catch (error) { source.amp = initial; $('adjustStatus').textContent = `Ajuste interrompido: ${error.message}`; }
    finally { $('adjustVsig').disabled = false; }
  }

  function loadTbjPreset() { checkpoint(); circuit = createTbjPreset(); circuit.settings.channels = [{ probe: String(circuit.components.find(part => part.type === 'PROBE' && part.name === 'A').id), coupling: 'AC' }, { probe: String(circuit.components.find(part => part.type === 'PROBE' && part.name === 'C').id), coupling: 'AC' }]; $('tranStop').value = circuit.settings.transient.stop; $('tranStep').value = circuit.settings.transient.step; selection = null; lastRun = null; renderAll(); renderProperties(); fitView(); setStatus('Preset TBJ carregado. Etapa 1: rode DC e ajuste V1 para VC ≈ 5 V.'); }
  function loadRectifier() {
    checkpoint(); circuit = emptyCircuit(); const add = (type, name, x, y, props = {}) => { const part = { id: circuit.nextId++, type, name, x, y, ...props }; circuit.components.push(part); return part; };
    const vs = add('VSIN', 'VSIG', 120, 200, { amp: 7.07, freq: 60, offset: 0 }), diode = add('D', 'D1', 390, 200), resistor = add('R', 'R1', 660, 200, { resistance: '1k' }), ground = add('GND', 'GND', 1000, 500), probeIn = add('PROBE', 'A', 120, 80), probeOut = add('PROBE', 'B', 820, 100);
    circuit.wires = [{ id: 'w1', a: `${vs.id}:0`, b: `${diode.id}:0` }, { id: 'w2', a: `${diode.id}:1`, b: `${resistor.id}:0` }, { id: 'w3', a: `${resistor.id}:1`, b: `${ground.id}:0` }, { id: 'w4', a: `${vs.id}:1`, b: `${ground.id}:0` }, { id: 'w5', a: `${probeIn.id}:0`, b: `${vs.id}:0` }, { id: 'w6', a: `${probeOut.id}:0`, b: `${resistor.id}:0` }];
    circuit.settings.transient = { stop: '40m', step: '50u' }; circuit.settings.channels = [{ probe: String(probeIn.id), coupling: 'DC' }, { probe: String(probeOut.id), coupling: 'DC' }]; selection = null; renderAll(); fitView(); setStatus('Retificador carregado.');
  }

  function saveCircuit() {
    const name = prompt('Nome do circuito JSON:', 'pratica-analogica'); if (!name) return;
    const payload = { format: 'lab-spice-circuit-v3', savedAt: new Date().toISOString(), circuit };
    const saves = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]').filter(item => item.name !== name);
    saves.unshift({ name, payload }); localStorage.setItem(STORAGE_KEY, JSON.stringify(saves.slice(0, 20))); renderSaved();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Circuito “${name}” salvo no navegador e exportado como JSON.`);
  }
  function openPayload(payload) {
    const next = payload?.circuit || payload;
    if (!next || !Array.isArray(next.components) || !Array.isArray(next.wires)) throw new Error('JSON inválido: componentes ou ligações ausentes.');
    circuit = { ...emptyCircuit(), ...next, models: next.models || {}, settings: { ...emptyCircuit().settings, ...(next.settings || {}) } };
    selection = null; lastRun = null; history = []; redoHistory = []; renderAll(); renderProperties(); fitView();
  }
  function renderSaved() {
    let host = $('savedList'); if (!host) return; host.replaceChildren();
    for (const item of JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')) { const button = document.createElement('button'); button.textContent = item.name; button.title = 'Abrir circuito salvo no navegador'; button.onclick = () => { try { openPayload(item.payload); setStatus(`“${item.name}” aberto.`); } catch (error) { setStatus(error.message, 'error'); } }; host.append(button); }
  }
  $('saveCircuit').onclick = saveCircuit; $('openCircuit').onclick = () => $('circuitFile').click();
  $('circuitFile').onchange = async event => { const file = event.target.files[0]; if (!file) return; try { openPayload(JSON.parse(await file.text())); setStatus(`Arquivo ${file.name} aberto.`); } catch (error) { setStatus(`Não foi possível abrir o arquivo: ${error.message}`, 'error'); } event.target.value = ''; };
  $('importModel').onclick = () => $('modelFile').click();
  $('modelFile').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    const cards = parseModelCards(await file.text());
    if (!cards.length) { setStatus('Nenhum cartão .MODEL válido foi encontrado.', 'error'); return; }
    checkpoint(); circuit.models ||= {}; for (const card of cards) circuit.models[card.name] = card.text;
    $('modelStatus').textContent = `Modelos disponíveis: BC548C interno · ${cards.map(card => card.name).join(' · ')}`;
    setStatus(`${cards.length} modelo(s) importado(s): ${cards.map(card => card.name).join(', ')}`); renderProperties(); refreshNetlist(); event.target.value = '';
  };
  $('tbjExample').onclick = loadTbjPreset; $('rectifierExample').onclick = loadRectifier; $('run').onclick = simulate;
  $('adjustV1').onclick = adjustV1; $('adjustVsig').onclick = adjustVsig;
  $('deleteSelected').onclick = deleteSelected;
  $('clearWires').onclick = () => { if (!circuit.wires.length) return; checkpoint(); circuit.wires = []; lastRun = null; renderAll(); renderProperties(); };
  $('undo').onclick = () => restoreSnapshot(history, redoHistory); $('redo').onclick = () => restoreSnapshot(redoHistory, history);
  document.querySelectorAll('[data-tab]').forEach(tab => tab.onclick = () => {
    document.querySelectorAll('[data-tab]').forEach(item => { item.classList.toggle('active', item === tab); item.setAttribute('aria-selected', String(item === tab)); });
    for (const id of ['dc', 'transient', 'scope']) $(`${id}Panel`).hidden = id !== tab.dataset.tab;
    if (tab.dataset.tab === 'scope') renderScope(); if (tab.dataset.tab === 'transient') renderTransient();
  });
  $('tranStop').addEventListener('change', () => { circuit.settings.transient.stop = $('tranStop').value; refreshNetlist(); });
  $('tranStep').addEventListener('change', () => { circuit.settings.transient.step = $('tranStep').value; refreshNetlist(); });
  $('exportScopePng').onclick = () => exportPng('scope'); $('exportTransientPng').onclick = () => exportPng('transient');
  $('copyNetlist').onclick = async () => { try { await navigator.clipboard.writeText($('netlistText').textContent); setStatus('Netlist copiado.'); } catch { $('technicalDetails').open = true; setStatus('Selecione e copie o netlist manualmente.', 'error'); } };
  $('toggleLibrary').onclick = event => { $('layout').classList.toggle('library-collapsed'); event.currentTarget.setAttribute('aria-expanded', String(!$('layout').classList.contains('library-collapsed'))); };
  $('toggleProperties').onclick = event => { $('layout').classList.toggle('properties-collapsed'); event.currentTarget.setAttribute('aria-expanded', String(!$('layout').classList.contains('properties-collapsed'))); };
  $('toggleResults').onclick = event => { document.body.classList.toggle('results-collapsed'); event.currentTarget.setAttribute('aria-expanded', String(!document.body.classList.contains('results-collapsed'))); };

  let enteredNativeFullscreen = false;
  function setCanvasExpanded(expanded, syncFullscreen = true) {
    document.body.classList.toggle('canvas-expanded', expanded);
    const button = $('toggleCanvasExpanded');
    button.setAttribute('aria-pressed', String(expanded));
    button.textContent = expanded ? '⤢ Sair do modo expandido' : '⛶ Expandir esquema';
    $('canvasTip').textContent = expanded
      ? 'Terminais: arraste para ligar · Espaço ou botão do meio + arraste move · roda do mouse dá zoom · Esc sai'
      : 'Arraste entre terminais para ligar · Espaço + arraste, botão do meio ou arraste no fundo para mover · roda dá zoom · “Expandir esquema” ocupa a tela';
    if (!syncFullscreen) return;
    if (expanded && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      try { document.documentElement.requestFullscreen().catch(() => {}); } catch {}
    } else if (!expanded && document.fullscreenElement && document.exitFullscreen) {
      try { document.exitFullscreen().catch(() => {}); } catch {}
    }
    requestAnimationFrame(() => { if (expanded) $('toggleCanvasExpanded').focus({ preventScroll: true }); });
  }
  $('toggleCanvasExpanded').onclick = () => setCanvasExpanded(!document.body.classList.contains('canvas-expanded'));
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) enteredNativeFullscreen = true;
    else if (enteredNativeFullscreen) {
      enteredNativeFullscreen = false;
      if (document.body.classList.contains('canvas-expanded')) setCanvasExpanded(false, false);
    }
  });
  $('expandedTools').addEventListener('click', event => {
    const action = event.target.closest('[data-view]')?.dataset.view;
    if (action === 'in') zoom(.8); else if (action === 'out') zoom(1.25); else if (action === 'fit') fitView(); else if (action === 'reset') fitView(true);
  });
  for (const [id, label, shown] of [['toggleLibrary', 'biblioteca', 'library-collapsed'], ['toggleProperties', 'propriedades', 'properties-collapsed'], ['toggleResults', 'resultados', 'results-collapsed']]) {
    const button = $(id), update = () => {
      const collapsed = label === 'resultados' ? document.body.classList.contains('results-collapsed') : $('layout').classList.contains(shown);
      button.textContent = `${collapsed ? 'Mostrar' : 'Ocultar'} ${label}`;
      button.setAttribute('aria-expanded', String(!collapsed));
    };
    button.addEventListener('click', update); update();
  }

  renderPalette(); renderSaved(); renderAll(); renderProperties(); applyView(); updateHistoryButtons();
})();
