import { describe, expect, it } from 'vitest';
import {
  LadderXmlError,
  ladderBlinkExample,
  ladderCanonical,
  ladderCounterExample,
  ladderFromPlcopen,
  ladderInitialState,
  ladderOutputs,
  ladderScan,
  ladderSelfHoldExample,
  ladderTimeLiteral,
  ladderToPlcopen,
  parseXml,
  validateLadder,
  type LadderDocument,
  type LadderNode,
} from './index';

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof LadderXmlError) return [e.code, e.detail.what];
    throw e;
  }
  throw new Error('no error');
};

/** A program touching every element kind the mapping covers. */
function everything(): LadderDocument {
  return {
    schemaVersion: 1,
    name: 'All <kinds> & "quotes"',
    scanMs: 20,
    variables: [
      { name: 'A', type: 'BOOL', role: 'input', comment: 'Input A' },
      { name: 'B', type: 'BOOL', role: 'input', initial: true },
      { name: 'C', type: 'BOOL', role: 'input' },
      { name: 'Y', type: 'BOOL', role: 'output' },
      { name: 'Z', type: 'BOOL', role: 'output' },
      { name: 'LIMIT', type: 'INT', role: 'internal', initial: -3 },
      { name: 'WAIT', type: 'TIME', role: 'internal', initial: 1500 },
      { name: 'T1', type: 'TOF', role: 'internal' },
      { name: 'T2', type: 'TP', role: 'internal' },
      { name: 'K', type: 'CTD', role: 'internal' },
      { name: 'K2', type: 'CTU', role: 'internal' },
    ],
    rungs: [
      {
        id: 'r1',
        comment: 'Nested branches, edges and a timer',
        network: {
          id: 'n1',
          kind: 'series',
          items: [
            { id: 'n2', kind: 'contact', variable: 'A', contact: 'rising' },
            {
              id: 'n3',
              kind: 'parallel',
              branches: [
                {
                  id: 'n4',
                  kind: 'series',
                  items: [
                    { id: 'n5', kind: 'contact', variable: 'B', contact: 'falling' },
                    {
                      id: 'n6',
                      kind: 'parallel',
                      branches: [
                        { id: 'n7', kind: 'contact', variable: 'C', contact: 'no' },
                        { id: 'n8', kind: 'series', items: [] },
                      ],
                    },
                  ],
                },
                { id: 'n9', kind: 'timer', instance: 'T1', presetMs: 250 },
              ],
            },
            { id: 'n10', kind: 'contact', variable: 'C', contact: 'nc' },
          ],
        },
        coils: [
          { id: 'c1', variable: 'Y', coil: 'normal' },
          { id: 'c2', variable: 'Z', coil: 'negated' },
        ],
      },
      {
        id: 'r2',
        network: { id: 'n11', kind: 'series', items: [] },
        coils: [{ id: 'c3', variable: 'Y', coil: 'set' }],
      },
      {
        id: 'r3',
        network: {
          id: 'n12',
          kind: 'series',
          items: [
            { id: 'n13', kind: 'counter', instance: 'K', preset: 4, reset: 'B' },
            { id: 'n14', kind: 'counter', instance: 'K2', preset: -2 },
            {
              id: 'n15',
              kind: 'compare',
              op: 'lt',
              a: { variable: 'K', member: 'CV' },
              b: { variable: 'LIMIT' },
            },
            {
              id: 'n16',
              kind: 'compare',
              op: 'ne',
              a: { variable: 'T2', member: 'ET' },
              b: { value: 7 },
            },
            { id: 'n17', kind: 'timer', instance: 'T2', presetMs: 3_600_000 },
          ],
        },
        coils: [{ id: 'c4', variable: 'Z', coil: 'reset' }],
      },
    ],
  };
}

// TS-2111: PLCopen TC6 XML out and back.
describe('PLCopen TC6 XML (TS-2111)', () => {
  it('reads back the examples unchanged, and writes the same text again', () => {
    for (const doc of [ladderSelfHoldExample(), ladderBlinkExample(), ladderCounterExample()]) {
      const xml = ladderToPlcopen(doc);
      const back = ladderFromPlcopen(xml);
      expect(back).toEqual(doc);
      expect(ladderToPlcopen(back)).toBe(xml);
    }
  });

  it('round-trips every element kind, nested branches and escaped text', () => {
    const doc = everything();
    const xml = ladderToPlcopen(doc, { created: '2026-11-12T00:00:00' });
    expect(xml).toContain('<project xmlns="http://www.plcopen.org/xml/tc6_0201">');
    expect(xml).toContain('contentHeader name="All &lt;kinds&gt; &amp; &quot;quotes&quot;"');
    expect(xml).toContain('<contact localId="3" height="20" width="20" edge="rising">');
    expect(xml).toContain('typeName="TOF" instanceName="T1"');
    expect(xml).toContain('<expression>T#250ms</expression>');
    expect(xml).toContain('<task name="Scan" interval="T#20ms" priority="0">');
    const back = ladderFromPlcopen(xml);
    expect(back).toEqual(ladderCanonical(doc));
    expect(ladderToPlcopen(back, { created: '2026-11-12T00:00:00' })).toBe(xml);
  });

  it('round-trips bypass branches (an empty branch beside a later element)', () => {
    const k = (id: string, variable: string): LadderNode => ({
      id,
      kind: 'contact',
      variable,
      contact: 'no',
    });
    const bypass = (network: LadderNode): LadderDocument => ({
      schemaVersion: 1,
      name: 'Bypass',
      scanMs: 10,
      variables: [
        ...['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({
          name,
          type: 'BOOL' as const,
          role: 'input' as const,
        })),
        { name: 'Y', type: 'BOOL', role: 'output' },
      ],
      rungs: [{ id: 'r1', network, coils: [{ id: 'c1', variable: 'Y', coil: 'normal' }] }],
    });
    const empty: LadderNode = { id: 'e', kind: 'series', items: [] };
    const ab: LadderNode = { id: 'p', kind: 'parallel', branches: [k('a', 'A'), k('b', 'B')] };
    const cases: LadderNode[] = [
      // series(parallel(A, B), parallel(empty, C))
      {
        id: 's',
        kind: 'series',
        items: [ab, { id: 'q', kind: 'parallel', branches: [empty, k('c', 'C')] }],
      },
      // the empty branch last, then D
      {
        id: 's',
        kind: 'series',
        items: [ab, { id: 'q', kind: 'parallel', branches: [k('c', 'C'), empty] }, k('d', 'D')],
      },
      // a composite branch before the bypass: series(parallel(series(A, E), B), parallel(empty, C))
      {
        id: 's',
        kind: 'series',
        items: [
          {
            id: 'p',
            kind: 'parallel',
            branches: [
              { id: 'x', kind: 'series', items: [k('a', 'A'), k('kE', 'E')] },
              k('b', 'B'),
            ],
          },
          { id: 'q', kind: 'parallel', branches: [empty, k('c', 'C')] },
        ],
      },
      // two bypasses in a row
      {
        id: 's',
        kind: 'series',
        items: [
          ab,
          { id: 'q', kind: 'parallel', branches: [empty, k('c', 'C')] },
          {
            id: 'u',
            kind: 'parallel',
            branches: [k('f', 'F'), { id: 'e2', kind: 'series', items: [] }],
          },
        ],
      },
      // a nested fan-out before the bypass:
      // series(parallel(A, series(B, parallel(C, D))), parallel(empty, E))
      {
        id: 's',
        kind: 'series',
        items: [
          {
            id: 'p',
            kind: 'parallel',
            branches: [
              k('a', 'A'),
              {
                id: 'x',
                kind: 'series',
                items: [
                  k('b', 'B'),
                  { id: 'y', kind: 'parallel', branches: [k('c', 'C'), k('d', 'D')] },
                ],
              },
            ],
          },
          { id: 'q', kind: 'parallel', branches: [empty, k('kE', 'E')] },
        ],
      },
      // eighteen parallels of two empty branches in a row (each passes on one point, not two)
      {
        id: 's',
        kind: 'series',
        items: [
          k('a', 'A'),
          ...Array.from(
            { length: 18 },
            (_, i): LadderNode => ({
              id: `z${i}`,
              kind: 'parallel',
              branches: [
                { id: `z${i}a`, kind: 'series', items: [] },
                { id: `z${i}b`, kind: 'series', items: [] },
              ],
            }),
          ),
        ],
      },
    ];
    for (const network of cases) {
      const doc = bypass(network);
      expect(validateLadder(doc).filter((d) => d.severity === 'error')).toEqual([]);
      const xml = ladderToPlcopen(doc);
      const back = ladderFromPlcopen(xml);
      expect(back).toEqual(ladderCanonical(doc));
      // Written again, the same text (the empty parallels are gone from the canonical form, so
      // that one is laid out narrower but reads back the same).
      if (network.kind === 'series' && network.items.length > 2 && network.items[1].id === 'z0')
        expect(ladderFromPlcopen(ladderToPlcopen(back))).toEqual(back);
      else expect(ladderToPlcopen(back)).toBe(xml);
    }
  });

  it('compares variables grouped by role, as the file writes them', () => {
    const doc = ladderSelfHoldExample();
    doc.variables = [doc.variables[2], doc.variables[0], doc.variables[1]];
    expect(doc.variables.map((v) => v.name)).toEqual(['LAMP', 'START', 'STOP']);
    const back = ladderFromPlcopen(ladderToPlcopen(doc));
    expect(back).toEqual(ladderCanonical(doc));
    expect(back.variables.map((v) => v.name)).toEqual(['START', 'STOP', 'LAMP']);
  });

  it('keeps leading and trailing spaces and newlines of comments', () => {
    const doc = ladderSelfHoldExample();
    doc.variables[0].comment = '  Preserve this note\n';
    doc.rungs[0].comment = '\n Rung note ';
    expect(ladderFromPlcopen(ladderToPlcopen(doc))).toEqual(doc);
  });

  it('writes tabs, line feeds and carriage returns as character references', () => {
    const doc = ladderSelfHoldExample();
    doc.name = 'Line\tOne\nTwo';
    doc.rungs[0].comment = 'Line one\r\nLine two';
    const xml = ladderToPlcopen(doc);
    expect(xml).toContain('Line&#9;One&#10;Two');
    expect(xml).toContain('Line one&#13;&#10;Line two');
    expect(xml).not.toMatch(/\r|\t/);
    expect(ladderFromPlcopen(xml)).toEqual(doc);
  });

  it('refuses inputs and initial values it cannot keep', () => {
    const xml = ladderToPlcopen(ladderCounterExample());
    const inline = xml.replace(
      'formalParameter="R"><connectionPointIn><connection refLocalId="3"/></connectionPointIn>',
      'formalParameter="R"><connectionPointIn><expression>RESET</expression></connectionPointIn>',
    );
    expect(inline).not.toBe(xml);
    expect(code(() => ladderFromPlcopen(inline))).toEqual([
      'plcopen-unsupported',
      'inline expression input',
    ]);
    const struct = xml.replace(
      '<variable name="COUNT"><type><derived name="CTU"/></type>',
      '<variable name="COUNT"><type><derived name="CTU"/></type><initialValue><structValue>' +
        '<value member="CV"><simpleValue value="4"/></value></structValue></initialValue>',
    );
    expect(struct).not.toBe(xml);
    expect(code(() => ladderFromPlcopen(struct))).toEqual([
      'plcopen-unsupported',
      'initialValue other than simpleValue',
    ]);
  });

  it('refuses coils that share a feed with another rung between them', () => {
    const xml = ladderToPlcopen(ladderSelfHoldExample());
    const coil = (id: number, from: number) =>
      `<coil localId="${id}"><position x="0" y="0"/><connectionPointIn><connection refLocalId="${from}"/>` +
      '</connectionPointIn><connectionPointOut/><variable>LAMP</variable></coil>';
    const ld = (body: string) =>
      xml.replace(
        /<LD>[\s\S]*<\/LD>/,
        '<LD><leftPowerRail localId="1"><position x="0" y="0"/><connectionPointOut/></leftPowerRail>' +
          '<contact localId="3"><position x="0" y="0"/><connectionPointIn><connection refLocalId="1"/>' +
          '</connectionPointIn><connectionPointOut/><variable>START</variable></contact>' +
          body +
          '</LD>',
      );
    // Rail → LAMP, START → LAMP, rail → LAMP: grouping the third with the first would reorder.
    expect(code(() => ladderFromPlcopen(ld(coil(2, 1) + coil(4, 3) + coil(5, 1))))).toEqual([
      'plcopen-unsupported',
      'coils sharing a feed with other rungs between them',
    ]);
    // Consecutive coils on one feed are one rung, as before.
    const back = ladderFromPlcopen(ld(coil(2, 1) + coil(5, 1) + coil(4, 3)));
    expect(back.rungs.map((r) => r.coils.length)).toEqual([2, 1]);
  });

  it('refuses an execution order that disagrees with the document order', () => {
    const xml = ladderToPlcopen(ladderSelfHoldExample());
    const coil = (id: number, ord: number, storage: string) =>
      `<coil localId="${id}" executionOrderId="${ord}" storage="${storage}"><position x="0" y="0"/>` +
      `<connectionPointIn><connection refLocalId="${id - 1}"/></connectionPointIn>` +
      '<connectionPointOut/><variable>LAMP</variable></coil>';
    const rail = (id: number) =>
      `<leftPowerRail localId="${id}"><position x="0" y="0"/><connectionPointOut/></leftPowerRail>`;
    const ld = (a: number, b: number) =>
      xml.replace(
        /<LD>[\s\S]*<\/LD>/,
        `<LD>${rail(1)}${coil(2, a, 'set')}${rail(3)}${coil(4, b, 'reset')}</LD>`,
      );
    expect(code(() => ladderFromPlcopen(ld(2, 1)))).toEqual([
      'plcopen-unsupported',
      'executionOrderId out of document order',
    ]);
    const back = ladderFromPlcopen(ld(1, 2));
    expect(back.rungs.map((r) => r.coils[0].coil)).toEqual(['set', 'reset']);
  });

  it('refuses memory qualifiers and addresses it cannot keep', () => {
    const xml = ladderToPlcopen(ladderCounterExample());
    expect(xml).toContain('<localVars>');
    for (const q of ['retain="true"', 'persistent="1"', 'constant="true"']) {
      const marked = xml.replace('<localVars>', `<localVars ${q}>`);
      expect(code(() => ladderFromPlcopen(marked))[0]).toBe('plcopen-unsupported');
    }
    expect(ladderFromPlcopen(xml.replace('<localVars>', '<localVars retain="false">'))).toEqual(
      ladderFromPlcopen(xml),
    );
    const located = xml.replace(/<variable name="(\w+)">/, '<variable name="$1" address="%IX0.0">');
    expect(located).not.toBe(xml);
    expect(code(() => ladderFromPlcopen(located))).toEqual([
      'plcopen-unsupported',
      'address %IX0.0',
    ]);
  });

  it('refuses characters XML cannot carry', () => {
    const doc = ladderSelfHoldExample();
    doc.rungs[0].comment = 'Hello\u0001world';
    expect(code(() => ladderToPlcopen(doc))).toEqual(['xml-char', 'U+0001']);
    doc.rungs[0].comment = 'lone \uD800';
    expect(code(() => ladderToPlcopen(doc))).toEqual(['xml-char', 'U+D800']);
    doc.rungs[0].comment = 'pair \u{1F600} ok';
    expect(ladderFromPlcopen(ladderToPlcopen(doc))).toEqual(doc);
    expect(code(() => parseXml('<x>a\u0001b</x>'))[0]).toBe('xml-syntax');
    expect(code(() => parseXml('<x>&#1;</x>'))[0]).toBe('xml-syntax');
  });

  it('refuses to write a file it could not read back', () => {
    // A valid program whose file is past the reader's size limit.
    const big: LadderDocument = {
      schemaVersion: 1,
      name: 'Big',
      scanMs: 10,
      variables: [
        { name: 'A', type: 'BOOL', role: 'input' },
        { name: 'Y', type: 'BOOL', role: 'output' },
      ],
      rungs: Array.from({ length: 210 }, (_, r) => ({
        id: `r${r}`,
        network: {
          id: `s${r}`,
          kind: 'series' as const,
          items: Array.from(
            { length: 100 },
            (_, i): LadderNode => ({
              id: `k${r}x${i}`,
              kind: 'contact',
              variable: 'A',
              contact: 'no',
            }),
          ),
        },
        coils: [{ id: `c${r}`, variable: 'Y', coil: 'normal' as const }],
      })),
    };
    expect(validateLadder(big).filter((d) => d.severity === 'error')).toEqual([]);
    expect(code(() => ladderToPlcopen(big))[0]).toBe('limit-xml-size');
  });

  it('runs the same after the round trip', () => {
    const doc = ladderSelfHoldExample();
    const back = ladderFromPlcopen(ladderToPlcopen(doc));
    const inputs: Record<string, boolean>[] = [
      { START: true },
      { START: false },
      { STOP: true },
      { STOP: false },
      { START: true },
    ];
    const run = (d: LadderDocument) => {
      let state = ladderInitialState(d);
      return inputs.map((i) => {
        state = ladderScan(d, state, i).state;
        return ladderOutputs(d, state);
      });
    };
    expect(run(back)).toEqual(run(doc));
    expect(run(back).map((o) => o.LAMP)).toEqual([true, true, false, false, true]);
  });

  it('reads prefixed namespaces, numeric booleans and inline XHTML in order', () => {
    const xml = ladderToPlcopen(ladderSelfHoldExample());
    // The same document with a `tc6:` prefix on every PLCopen element.
    const prefixed = xml
      .replace('<project xmlns=', '<project xmlns:tc6=')
      .replace(/<(\/?)(?!xhtml:)([A-Za-z][\w]*)/g, '<$1tc6:$2')
      .replace('<?tc6:xml', '<?xml');
    expect(ladderFromPlcopen(prefixed)).toEqual(ladderSelfHoldExample());
    expect(code(() => parseXml('<a:x/>'))).toEqual(['xml-syntax', 'namespace prefix']);
    // negated="1" is TRUE (XML Schema boolean): still the NC STOP contact.
    const one = ladderFromPlcopen(xml.replace('negated="true"', 'negated="1"'));
    expect(one).toEqual(ladderSelfHoldExample());
    expect(code(() => ladderFromPlcopen(xml.replace('negated="true"', 'negated="yes"')))).toEqual([
      'plcopen-unsupported',
      'negated yes',
    ]);
    // Inline markup inside a comment keeps the text order.
    const rich = xml.replace(
      'START or the lamp itself',
      'START or the <xhtml:b>lamp</xhtml:b> itself',
    );
    expect(ladderFromPlcopen(rich).rungs[0].comment).toBe(ladderSelfHoldExample().rungs[0].comment);
  });

  it('refuses modifiers on block pins and their inputs', () => {
    const xml = ladderToPlcopen(ladderCounterExample());
    for (const [a, b, what] of [
      ['formalParameter="R">', 'formalParameter="R" negated="true">', 'CTU R negated'],
      ['formalParameter="CU">', 'formalParameter="CU" edge="rising">', 'CTU CU edge'],
      ['formalParameter="Q">', 'formalParameter="Q" negated="1">', 'CTU Q negated'],
    ]) {
      expect(xml).toContain(a);
      expect(code(() => ladderFromPlcopen(xml.replace(a, b)))).toEqual([
        'plcopen-unsupported',
        what,
      ]);
    }
    const inVar = xml.replace(
      /<inVariable localId="(\d+)"/,
      '<inVariable localId="$1" negated="true"',
    );
    expect(code(() => ladderFromPlcopen(inVar))[0]).toBe('plcopen-unsupported');
  });

  it('reads time literals', () => {
    expect(ladderTimeLiteral('T#500ms')).toBe(500);
    expect(ladderTimeLiteral('TIME#1s500ms')).toBe(1500);
    expect(ladderTimeLiteral('t#1h2m')).toBe(3_720_000);
    expect(ladderTimeLiteral('T#1.5s')).toBe(1500);
    expect(ladderTimeLiteral('T#0.5ms')).toBeUndefined();
    expect(ladderTimeLiteral('500')).toBeUndefined();
    expect(ladderTimeLiteral('T#')).toBeUndefined();
  });

  it('refuses what is outside the mapping', () => {
    const xml = ladderToPlcopen(ladderSelfHoldExample());
    const swap = (a: string, b: string) => {
      expect(xml).toContain(a);
      return xml.replace(a, b);
    };
    expect(code(() => ladderFromPlcopen(swap('<LD>', '<LD><jump localId="99"/>')))).toEqual([
      'plcopen-unsupported',
      'jump',
    ]);
    expect(
      code(() =>
        ladderFromPlcopen(
          swap('<outputVars>', '<tempVars>').replace('</outputVars>', '</tempVars>'),
        ),
      ),
    ).toEqual(['plcopen-unsupported', 'tempVars']);
    expect(
      code(() => ladderFromPlcopen(swap('<body><LD>', '<body><ST>').replace('</LD>', '</ST>'))),
    ).toEqual(['plcopen-unsupported', 'body (not LD)']);
    expect(code(() => ladderFromPlcopen(swap('<BOOL/>', '<REAL/>')))).toEqual([
      'plcopen-unsupported',
      'type REAL',
    ]);
    // A contact that reaches no coil.
    expect(
      code(() =>
        ladderFromPlcopen(
          swap(
            '</LD>',
            '<contact localId="90"><position x="0" y="0"/><connectionPointIn><connection refLocalId="1"/></connectionPointIn><connectionPointOut/><variable>START</variable></contact></LD>',
          ),
        ),
      ),
    ).toEqual(['plcopen-unsupported', 'unconnected contact 90']);
    // A bridge: START feeds both a branch with LAMP and, alone, another place.
    const c = (id: number, from: number[], v: string) =>
      `<contact localId="${id}"><position x="0" y="0"/><connectionPointIn>${from
        .map((f) => `<connection refLocalId="${f}"/>`)
        .join('')}</connectionPointIn><connectionPointOut/><variable>${v}</variable></contact>`;
    const body =
      '<leftPowerRail localId="1"><position x="0" y="0"/><connectionPointOut/></leftPowerRail>' +
      c(2, [1], 'START') +
      c(3, [1], 'LAMP') +
      c(4, [2, 3], 'STOP') +
      c(5, [2], 'STOP') +
      '<coil localId="6"><position x="0" y="0"/><connectionPointIn><connection refLocalId="4"/>' +
      '<connection refLocalId="5"/></connectionPointIn><connectionPointOut/><variable>LAMP</variable></coil>';
    const bridge = xml.replace(/<LD>[\s\S]*<\/LD>/, `<LD>${body}</LD>`);
    expect(code(() => ladderFromPlcopen(bridge))).toEqual([
      'plcopen-unsupported',
      'element shared between branches or rungs',
    ]);
    // The same without the bridge reads.
    expect(
      ladderFromPlcopen(
        bridge.replace('<connection refLocalId="5"/>', '').replace(c(5, [2], 'STOP'), ''),
      ).rungs[0].network,
    ).toMatchObject({ kind: 'series', items: [{ kind: 'parallel' }, { variable: 'STOP' }] });
    // Two tasks (another scan period) cannot be one program's scan.
    expect(
      code(() =>
        ladderFromPlcopen(
          swap(
            '</task>',
            '</task><task name="Slow" interval="T#100ms" priority="1"><pouInstance name="Second" typeName="Main"/></task>',
          ),
        ),
      ),
    ).toEqual(['plcopen-unsupported', 'task count 2']);
    // A chain longer than a rung may hold is refused before it is followed.
    const chain = Array.from({ length: 3000 }, (_, i) => c(i + 2, [i + 1], 'START')).join('');
    const long = xml.replace(
      /<LD>[\s\S]*<\/LD>/,
      '<LD><leftPowerRail localId="1"><position x="0" y="0"/><connectionPointOut/></leftPowerRail>' +
        chain +
        '<coil localId="9000"><position x="0" y="0"/><connectionPointIn><connection refLocalId="3001"/>' +
        '</connectionPointIn><connectionPointOut/><variable>LAMP</variable></coil></LD>',
    );
    expect(code(() => ladderFromPlcopen(long))[0]).toBe('limit-nodes');
    // Each contact fed by the two before it: shared sub-networks must not be expanded (fast refusal).
    const fib = Array.from({ length: 35 }, (_, i) =>
      c(i + 2, i === 0 ? [1] : i === 1 ? [1, 2] : [i, i + 1], 'START'),
    ).join('');
    const tangled = xml.replace(
      /<LD>[\s\S]*<\/LD>/,
      '<LD><leftPowerRail localId="1"><position x="0" y="0"/><connectionPointOut/></leftPowerRail>' +
        fib +
        '<coil localId="9000"><position x="0" y="0"/><connectionPointIn><connection refLocalId="36"/>' +
        '</connectionPointIn><connectionPointOut/><variable>LAMP</variable></coil></LD>',
    );
    expect(code(() => ladderFromPlcopen(tangled))[0]).toBe('plcopen-unsupported');
    // A block without its inputVariables section.
    const blink = ladderToPlcopen(ladderBlinkExample());
    const bare = blink.replace(/<inputVariables>[\s\S]*?<\/inputVariables>/, '');
    expect(code(() => ladderFromPlcopen(bare))).toEqual([
      'plcopen-unsupported',
      'TON without inputVariables or outputVariables',
    ]);
    expect(code(() => ladderFromPlcopen('<project xmlns="urn:other"/>'))).toEqual([
      'plcopen-shape',
      'namespace',
    ]);
  });

  it('reads XML strictly and safely', () => {
    const r = parseXml(
      '﻿<?xml version="1.0"?><!-- c --><a:x xmlns:a="u" k=\'1 &amp; 2\'><y>t&#x41;&#66;<![CDATA[<z>]]></y><y/></a:x>',
    );
    expect(r.name).toBe('x');
    expect(r.attrs.k).toBe('1 & 2');
    expect(r.children[0].text).toBe('tAB<z>');
    expect(code(() => parseXml('<!DOCTYPE x [<!ENTITY e "x">]><x>&e;</x>'))[0]).toBe('xml-doctype');
    expect(code(() => parseXml('<x>&e;</x>'))[0]).toBe('xml-syntax');
    expect(code(() => parseXml('<x><y></x>'))[0]).toBe('xml-syntax');
    expect(code(() => parseXml('<x a="1" a="2"/>'))[0]).toBe('xml-syntax');
    expect(code(() => parseXml('<x/><y/>'))[0]).toBe('xml-syntax');
    expect(code(() => parseXml(`${'<x>'.repeat(70)}${'</x>'.repeat(70)}`))[0]).toBe(
      'limit-xml-depth',
    );
  });
});
