import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from 'eecircuit-engine';
import { applyCoupling, BUILTIN_MODELS, createTbjPreset, makeNetlist, measureWave, parseModelCards, parseSpiceNumber } from './spice-core.js';

test('SPICE engineering suffixes accept normal lab values', () => {
  for (const [text, expected] of [['100', 100], ['1k', 1000], ['10k', 10000], ['100k', 100000], ['1m', .001], ['10u', 10e-6], ['100n', 100e-9], ['2meg', 2e6]]) assert.ok(Math.abs(parseSpiceNumber(text) - expected) <= Math.abs(expected) * 1e-12);
});

test('MODEL parser retains multiline continuation, comments, blanks, and multiple cards', () => {
  const cards = parseModelCards(`* top comment\n\n.MODEL BC548C NPN(\n+ BF=420 VAF=90\n* inner comment\n+ IS=2E-14\n )\n; spacer\n.model DFAST D(Is=1n N=1.2)\n`);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, 'BC548C');
  assert.match(cards[0].text, /BF=420 VAF=90 IS=2E-14/);
  assert.match(cards[0].text, /\)$/);
  assert.equal(cards[1].name, 'DFAST');
});

test('an imported multiline NPN model is emitted and executed by ngspice', async () => {
  const cards = parseModelCards(`* vendor model\n.model LABNPN NPN(\n+ IS=1e-14 BF=250\n+ VAF=80\n)`);
  const circuit = createTbjPreset();
  circuit.models = Object.fromEntries(cards.map(card => [card.name, card.text]));
  circuit.components.find(part => part.type === 'NPN').model = 'LABNPN';
  circuit.components.find(part => part.type === 'VDC' && part.name === 'V1').voltage = 7;
  const { built, result } = await run(circuit);
  assert.match(built.netlist, /Q1 C B 0 LABNPN/i);
  assert.match(built.netlist, /\.model LABNPN NPN\( IS=1e-14 BF=250 VAF=80 \)/i);
  const probe = circuit.components.find(part => part.type === 'PROBE' && part.name === 'C');
  const node = built.graph.node(pin(probe, 0));
  assert.ok(Number.isFinite(vector(result, `v(${node})`)[0]) && vector(result, `v(${node})`)[0] < 10, `collector vector ${node}: ${JSON.stringify(result.data.map(item => item.name))}`);
});

const pin = (part, index) => `${part.id}:${index}`;
function dividerCircuit() {
  const v = { id: 1, type: 'VDC', name: 'V1', voltage: 10 }, r1 = { id: 2, type: 'R', name: 'R1', resistance: '10k' }, r2 = { id: 3, type: 'R', name: 'R2', resistance: '10k' }, g = { id: 4, type: 'GND', name: 'GND' }, p = { id: 5, type: 'PROBE', name: 'B' };
  return { mode: 'analog', components: [v, r1, r2, g, p], models: {}, wires: [
    { a: pin(v, 0), b: pin(r1, 0) }, { a: pin(r1, 1), b: pin(r2, 0) }, { a: pin(r1, 1), b: pin(p, 0) }, { a: pin(r2, 1), b: pin(g, 0) }, { a: pin(v, 1), b: pin(g, 0) }
  ] };
}
function sineCircuit() {
  const v = { id: 1, type: 'VSIN', name: 'VSIG', amp: 1, freq: 1000, offset: 0 }, g = { id: 2, type: 'GND', name: 'GND' }, p = { id: 3, type: 'PROBE', name: 'A' };
  return { mode: 'analog', components: [v, g, p], models: {}, wires: [{ a: pin(v, 1), b: pin(g, 0) }, { a: pin(v, 0), b: pin(p, 0) }] };
}
const engine = new Simulation();
async function run(circuit, analysis = 'dc', transient = { stop: '3m', step: '1u' }) {
  if (!engine.isInitialized()) await engine.start();
  const built = makeNetlist({ circuit, analysis, transient, modelCards: { ...BUILTIN_MODELS, ...(circuit.models || {}) } });
  engine.setNetList(built.netlist);
  const result = await engine.runSim();
  assert.deepEqual(engine.getError(), [], engine.getInfo());
  assert.ok(result.data?.length, 'engine returns result vectors');
  return { built, result };
}
function vector(result, name) { return result.data.find(item => item.name.toLowerCase() === name.toLowerCase())?.values || []; }

test('ngspice computes a 10 kΩ / 10 kΩ divider from the generated netlist', async () => {
  const circuit = dividerCircuit(), { built, result } = await run(circuit);
  const probe = circuit.components.find(part => part.type === 'PROBE'), node = built.graph.node(pin(probe, 0));
  assert.match(built.netlist, /\.op/);
  assert.ok(Math.abs(vector(result, `v(${node})`)[0] - 5) < 1e-4);
});

test('ngspice generates 1 V peak, 1 kHz sine with 2 Vpp and 1 ms period', async () => {
  const circuit = sineCircuit(), { built, result } = await run(circuit, 'transient', { stop: '4m', step: '1u' });
  const probe = circuit.components.find(part => part.type === 'PROBE'), node = built.graph.node(pin(probe, 0)), values = vector(result, `v(${node})`), time = vector(result, 'time');
  assert.ok(values.length > 3000);
  const m = measureWave(values, time);
  assert.ok(m.vpp > 1.95 && m.vpp < 2.05, `Vpp=${m.vpp}`);
  assert.ok(m.frequency > 990 && m.frequency < 1010, `frequency=${m.frequency}`);
});

test('preset BC548C executes with correct Q C/B/E order and collector responds to V1', async () => {
  const circuit = createTbjPreset();
  assert.match(BUILTIN_MODELS.BC548C, /^\.MODEL BC548C NPN\(/i);
  const { built: offNet, result: off } = await run(circuit);
  assert.match(offNet.netlist, /Q1 C B 0 BC548C/i);
  assert.match(offNet.netlist, /\.MODEL BC548C NPN/i);
  const nodeC = offNet.graph.node(`${circuit.components.find(part => part.type === 'PROBE' && part.name === 'C').id}:0`);
  const vcOff = vector(off, `v(${nodeC})`)[0];
  circuit.components.find(part => part.type === 'VDC' && part.name === 'V1').voltage = 7;
  const { result: on } = await run(circuit);
  const vcOn = vector(on, `v(${nodeC})`)[0];
  assert.ok(vcOff > 9.9, `cutoff collector=${vcOff}`);
  assert.ok(vcOn < vcOff - 2, `biased collector=${vcOn}`);
});

test('preset transient returns probe A/B/C and AC coupling removes only the mean', async () => {
  const circuit = createTbjPreset();
  circuit.components.find(part => part.type === 'VDC' && part.name === 'V1').voltage = 6.85;
  circuit.components.find(part => part.type === 'VSIN').amp = .01;
  const { built, result } = await run(circuit, 'transient', { stop: '5m', step: '2u' });
  for (const name of ['A', 'B', 'C']) assert.match(built.netlist, new RegExp(`v\\(${name}\\)`, 'i'));
  const probeB = circuit.components.find(part => part.type === 'PROBE' && part.name === 'B'), nodeB = built.graph.node(pin(probeB, 0));
  const b = vector(result, `v(${nodeB})`), time = vector(result, 'time'), ac = applyCoupling(b, 'AC'), dc = applyCoupling(b, 'DC');
  assert.ok(b.length > 2000);
  assert.ok(Math.abs(ac.reduce((sum, value) => sum + value, 0) / ac.length) < 1e-8);
  assert.ok(Math.abs(dc.reduce((sum, value) => sum + value, 0) / dc.length) > .5);
  assert.ok(measureWave(ac, time).vpp > 0);
});
