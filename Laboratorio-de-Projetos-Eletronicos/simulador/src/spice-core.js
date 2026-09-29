export const BUILTIN_MODELS = {
  BC548C: `.MODEL BC548C NPN(IS=1.95E-14 ISE=1.31f ISC=1.00E-13 XTI=3.00 BF=4.66E2 BR=2.42 IKF=1.80E-1 IKR=1.00 XTB=1.5 VAF=9.17E1 VAR=2.47E1 VJE=6.32E-1 VJC=3.39E-1 RE=1.00 RC=1.73 RB=2.65E1 RBM=1.00E1 IRB=1.00E1 CJE=1.33E-11 CJC=5.17p FC=9.00E-1 NF=9.93E-1 NR=1.20 NE=1.32 NC=2.00 MJE=3.26E-1 MJC=3.19E-1 TF=6.52E-10 TR=0 ITF=1.03 VTF=1.65 XTF=1.00E2 EG=1.11)`
};

const PREFIX = { R: 'R', C: 'C', D: 'D', VDC: 'V', VSIN: 'V', NPN: 'Q' };

export function parseSpiceNumber(value, fallback = NaN) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const text = String(value ?? '').trim().replace(/\s+/g, '');
  const match = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i);
  if (!match) return fallback;
  const scale = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  const number = Number(match[1]) * (scale[(match[2] || '').toLowerCase()] || 1);
  return Number.isFinite(number) ? number : fallback;
}

export function parseModelCards(source) {
  const cards = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    const text = current.lines.join(' ').replace(/\s+/g, ' ').trim();
    const name = current.name;
    if (text && name) cards.push({ name, text });
    current = null;
  };
  for (const raw of String(source ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('*') || line.startsWith(';') || line.startsWith('//')) continue;
    if (/^\.model\b/i.test(line)) {
      finish();
      const match = line.match(/^\.model\s+(\S+)\s+(.+)$/i);
      if (match) current = { name: match[1], lines: [`.model ${match[1]} ${match[2]}`], depth: (match[2].match(/\(/g) || []).length - (match[2].match(/\)/g) || []).length };
      continue;
    }
    if (current && (/^\+/.test(line) || current.depth > 0)) {
      const continuation = line.replace(/^\+\s*/, '');
      current.lines.push(continuation);
      current.depth += (continuation.match(/\(/g) || []).length - (continuation.match(/\)/g) || []).length;
      continue;
    }
    finish();
  }
  finish();
  return cards;
}

export function buildNetGraph(circuit) {
  const pins = new Map();
  for (const part of circuit.components) {
    const count = part.type === 'NPN' ? 3 : part.type === 'JUNCTION' ? 4 : ['GND', 'PROBE', 'LABEL'].includes(part.type) ? 1 : 2;
    for (let i = 0; i < count; i++) pins.set(`${part.id}:${i}`, `${part.id}:${i}`);
  }
  const find = key => {
    if (!pins.has(key)) return null;
    let root = key;
    while (pins.get(root) !== root) root = pins.get(root);
    let next = key;
    while (pins.get(next) !== next) { const parent = pins.get(next); pins.set(next, root); next = parent; }
    return root;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra && rb && ra !== rb) pins.set(rb, ra); };
  for (const wire of circuit.wires) union(wire.a, wire.b);
  for (const part of circuit.components.filter(item => item.type === 'JUNCTION')) {
    for (let i = 1; i < 4; i++) union(`${part.id}:0`, `${part.id}:${i}`);
  }
  const labels = new Map();
  for (const label of circuit.components.filter(item => item.type === 'LABEL')) {
    const name = String(label.name || '').trim();
    if (!name) continue;
    const key = name.toUpperCase();
    if (labels.has(key)) union(`${label.id}:0`, labels.get(key));
    else labels.set(key, `${label.id}:0`);
  }
  const groundPart = circuit.components.find(item => item.type === 'GND');
  const ground = groundPart ? find(`${groundPart.id}:0`) : null;
  const roots = [...pins.keys()].map(find).filter((key, index, all) => all.indexOf(key) === index && key !== ground);
  const rootLabels = new Map();
  for (const [name, key] of labels) {
    const root = find(key);
    if (root !== ground && !rootLabels.has(root)) rootLabels.set(root, name);
  }
  const nodeByRoot = new Map();
  let index = 1;
  for (const root of roots) nodeByRoot.set(root, rootLabels.get(root) || `N${index++}`);
  const node = key => {
    const root = find(key);
    return root === ground ? '0' : nodeByRoot.get(root) || `N${index++}`;
  };
  return { find, node, ground, roots };
}

function spiceReference(part, used) {
  const prefix = PREFIX[part.type];
  if (!prefix) return null;
  const raw = String(part.name || `${prefix}${part.id}`).replace(/[^a-z0-9_]/gi, '');
  const tail = raw.toUpperCase().startsWith(prefix) ? raw.slice(prefix.length) || String(part.id) : raw;
  let ref = `${prefix}${tail}`;
  if (used.has(ref.toLowerCase())) ref = `${prefix}${part.id}`;
  if (used.has(ref.toLowerCase())) throw new Error(`Referência SPICE duplicada: ${ref}`);
  used.add(ref.toLowerCase());
  return ref;
}

export function makeNetlist({ circuit, analysis = 'dc', transient = {}, modelCards = {} }) {
  const graph = buildNetGraph(circuit);
  const used = new Set();
  const lines = ['Laboratorio de Projetos Eletronicos'];
  const terminal = (part, index) => graph.node(`${part.id}:${index}`);
  for (const part of circuit.components) {
    if (['GND', 'PROBE', 'LABEL', 'JUNCTION'].includes(part.type)) continue;
    const ref = spiceReference(part, used);
    const a = terminal(part, 0), b = terminal(part, 1);
    if (part.type === 'R') lines.push(`${ref} ${a} ${b} ${parseSpiceNumber(part.resistance, 1000)}`);
    else if (part.type === 'C') lines.push(`${ref} ${a} ${b} ${parseSpiceNumber(part.capacitance, 100e-6)}`);
    else if (part.type === 'D') lines.push(`${ref} ${a} ${b} D_SILICON`);
    else if (part.type === 'VDC') lines.push(`${ref} ${a} ${b} DC ${parseSpiceNumber(part.voltage, 0)}`);
    else if (part.type === 'VSIN') lines.push(`${ref} ${a} ${b} SIN(${parseSpiceNumber(part.offset, 0)} ${parseSpiceNumber(part.amp, 0)} ${parseSpiceNumber(part.freq, 1000)})`);
    else if (part.type === 'NPN') {
      const model = String(part.model || 'BC548C').trim();
      if (!Object.keys(modelCards).some(name => name.toUpperCase() === model.toUpperCase())) throw new Error(`O modelo SPICE “${model}” não foi carregado.`);
      lines.push(`${ref} ${terminal(part, 0)} ${terminal(part, 1)} ${terminal(part, 2)} ${model}`);
    }
  }
  if (circuit.components.some(part => part.type === 'D')) lines.push('.model D_SILICON D(Is=2.5n N=1.7)');
  const models = new Map(Object.entries({ ...BUILTIN_MODELS, ...(circuit.models || {}), ...modelCards }).map(([name, text]) => [name.toUpperCase(), text]));
  for (const model of models.values()) lines.push(model);
  const nodes = [...new Set(circuit.components.filter(part => part.type === 'PROBE').map(part => terminal(part, 0)).filter(node => node !== '0'))];
  if (nodes.length) lines.push(`.save ${nodes.map(node => `v(${node})`).join(' ')}`);
  else if (circuit.components.some(part => part.type === 'PROBE')) lines.push('.save all');
  if (analysis === 'dc') lines.push('.op');
  else {
    const stop = parseSpiceNumber(transient.stop, 0.002);
    const step = parseSpiceNumber(transient.step, stop / 1000);
    if (!(stop > 0) || !(step > 0) || step > stop) throw new Error('Revise tempo total e passo da análise transiente.');
    lines.push(`.tran ${step} ${stop}`);
  }
  lines.push('.end');
  return { netlist: lines.join('\n'), graph };
}

export function createTbjPreset() {
  const components = [];
  let id = 1;
  const add = (type, name, x, y, properties = {}) => {
    const part = { id: id++, type, name, x, y, ...properties };
    components.push(part);
    return part;
  };
  // Match the lab drawing: vertical bias/load resistors, a horizontal input
  // resistor, collector above the NPN, and one shared ground rail at the bottom.
  const vertical = { rotation: 90 };
  const v1 = add('VDC', 'V1', 406, 64, { voltage: 0, rotation: 180, symbolStyle: 'supply' });
  const v2 = add('VDC', 'V2', 766, 64, { voltage: 10, symbolStyle: 'supply' });
  const rb = add('R', 'RB', 436, 139, { resistance: '100k', ...vertical });
  const rc = add('R', 'RC', 736, 139, { resistance: '10k', ...vertical });
  const q = add('NPN', 'Q1', 660, 284, { model: 'BC548C' });
  const rsig = add('R', 'RSIG', 436, 374, { resistance: '10k', ...vertical });
  const r1 = add('R', 'R1', 286, 504, { resistance: '1k' });
  const r2 = add('R', 'R2', 436, 574, { resistance: '100', ...vertical });
  const vsig = add('VSIN', 'VSIG', 186, 584, { amp: 0, freq: 1000, offset: 0, ...vertical });
  const ground = add('GND', 'GND', 436, 800);
  const probeA = add('PROBE', 'A', 500, 504);
  const probeB = add('PROBE', 'B', 500, 284);
  const probeC = add('PROBE', 'C', 800, 248);
  const label = (name, x, y) => add('LABEL', name, x, y);
  const la1 = label('A', 500, 504);
  const lb1 = label('B', 500, 284);
  const lc1 = label('C', 800, 248);
  const wires = [];
  const connect = (a, ai, b, bi, points = undefined) => wires.push({ id: `w${wires.length + 1}`, a: `${a.id}:${ai}`, b: `${b.id}:${bi}`, ...(points ? { points } : {}) });
  connect(v2, 0, rc, 0); connect(rc, 1, q, 0, [[800, 284]]); connect(rc, 1, probeC, 0, [[800, 284]]); connect(rc, 1, lc1, 0, [[800, 284]]);
  connect(v2, 1, ground, 0, [[930, 100], [930, 800], [500, 800]]); wires[wires.length - 1].hidden = true;
  connect(q, 2, ground, 0, [[800, 356], [800, 800], [500, 800]]);
  connect(v1, 1, ground, 0, [[330, 100], [330, 800], [500, 800]]); wires[wires.length - 1].hidden = true;
  connect(vsig, 1, ground, 0, [[250, 800], [500, 800]]);
  connect(r2, 1, ground, 0);
  connect(v1, 0, rb, 0, [[500, 100]]);
  connect(rb, 1, q, 1, [[500, 320]]); connect(rb, 1, rsig, 0, [[500, 320]]); connect(rb, 1, probeB, 0, [[500, 320]]); connect(rb, 1, lb1, 0, [[500, 320]]);
  connect(rsig, 1, r1, 1, [[500, 540]]); connect(rsig, 1, r2, 0, [[500, 540]]); connect(rsig, 1, probeA, 0, [[500, 540]]); connect(r1, 1, la1, 0, [[500, 540]]);
  connect(vsig, 0, r1, 0, [[250, 540]]);
  return { version: 3, mode: 'analog', components, wires, models: {}, nextId: id, frequency: 1000, settings: { transient: { stop: '5m', step: '2u' }, channels: [] } };
}

export function applyCoupling(values, coupling = 'DC') {
  const finite = values.map(value => Number(value)).filter(Number.isFinite);
  const mean = finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
  return values.map(value => Number.isFinite(Number(value)) ? Number(value) - (coupling === 'AC' ? mean : 0) : NaN);
}

export function measureWave(values, times = []) {
  const points = values.map((value, index) => ({ value: Number(value), time: Number(times[index]) })).filter(point => Number.isFinite(point.value));
  if (!points.length) return { min: NaN, max: NaN, vpp: NaN, peak: NaN, mean: NaN, frequency: null };
  const data = points.map(point => point.value), mean = data.reduce((sum, value) => sum + value, 0) / data.length;
  const min = Math.min(...data), max = Math.max(...data);
  const crossings = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (a.value <= mean && b.value > mean && Number.isFinite(a.time) && Number.isFinite(b.time) && b.time > a.time) {
      const ratio = (mean - a.value) / (b.value - a.value);
      crossings.push(a.time + (b.time - a.time) * ratio);
    }
  }
  const periods = crossings.slice(1).map((time, index) => time - crossings[index]).filter(period => period > 0);
  const period = periods.length ? periods.reduce((sum, value) => sum + value, 0) / periods.length : null;
  return { min, max, vpp: max - min, peak: Math.max(Math.abs(min - mean), Math.abs(max - mean)), mean, frequency: period ? 1 / period : null };
}
