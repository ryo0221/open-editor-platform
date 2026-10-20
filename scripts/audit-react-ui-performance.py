#!/usr/bin/env python3
"""Recompute fixed #24 gates from complete raw samples; refuse partial runs."""
import argparse
import hashlib
import json
import math
from pathlib import Path

NATIVE = {'prop': 100, 'insert': 100, 'move': 100, 'undo': 100,
          'native-roundtrip': 500, 'tsx-export': 500, 'host-resolution': 100}
BROWSER = {'initial': 5000, 'prop-preview': 100, 'insert-preview': 100,
           'move-preview': 100, 'undo-preview': 100, 'width-preview': 500,
           'save': 1000, 'reload': 5000}
INDEPENDENT = {'typecheck': 10000, 'production-build': 15000}


def verify_metric(metric, budget, kind):
    assert metric['budgetMs'] == budget, 'Changed budget'
    target = budget / 2
    assert metric['targetMs'] == target, 'Changed target'
    cold = metric['name'] == 'initial'
    maximum = cold or kind == 'independent'
    count = 3 if kind == 'independent' else 1 if cold else 25
    samples = metric['samples']
    assert len(samples) == count, 'Missing or extra samples'
    assert all(type(value) in (float, int) and math.isfinite(value) and value >= 0
               for value in samples), 'Invalid sample'
    warmups = 0 if maximum else 5
    if kind != 'independent':
        assert metric['warmups'] == warmups, 'Changed warm-up count'
    measured = sorted(samples[warmups:])
    recomputed = measured[-1] if maximum else measured[math.ceil(len(measured) * .95) - 1]
    maximum_ms = measured[-1]
    assert abs(metric['maxMs'] - maximum_ms) < 1e-6, 'Incorrect maximum'
    if maximum:
        assert metric.get('p95Ms') is None, 'Cold/CLI samples cannot claim p95'
    else:
        assert abs(metric['p95Ms'] - recomputed) < 1e-6, 'Incorrect p95'
    return {'name': metric['name'], 'statistic': 'maximum' if maximum else 'p95',
            'valueMs': recomputed, 'maxMs': maximum_ms, 'maxAllMs': max(samples),
            'budgetMs': budget, 'targetMs': target, 'passed': recomputed <= budget,
            'targetMet': recomputed <= target, 'rawSamples': len(samples)}


def compare_native(current, previous):
    comparisons = []
    for name in NATIVE:
        old = [row['valueMs'] for row in previous if row['name'] == name]
        new = [row['valueMs'] for row in current if row['kind'] == 'native' and row['name'] == name]
        assert len(old) == len(new) == 3, 'Native comparison requires all three repetitions'
        baseline = max(old)
        assert baseline > 0, 'Non-positive native baseline'
        value = max(new)
        comparisons.append({'name': name, 'baselineP95MaxMs': baseline,
                            'currentP95MaxMs': value, 'limitMs': baseline * 1.2,
                            'changePercent': (value / baseline - 1) * 100,
                            'passed': value <= baseline * 1.2 + 1e-9})
    return comparisons


def audit(native, browser, independent, fixture, native_baseline=None):
    digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
    output = []
    commits, nodes, engines = set(), set(), set()
    native_environments = []

    def add(file, kind, expected, repetition):
        data = json.loads(file.read_text())
        assert data['kind'] == kind and data['fixtureSha256'] == digest, 'Fixture/kind mismatch'
        assert set(metric['name'] for metric in data['metrics']) == set(expected), 'Missing/extra metric'
        assert len(data['metrics']) == len(expected), 'Duplicated metric'
        commits.add(data['commit'])
        nodes.add(data.get('node', data.get('environment', {}).get('node')))
        if kind == 'native':
            assert data['shape'] == {'nodes': 500, 'components': 21, 'depth': 4}, 'Changed shape'
            native_environments.append(data['environment'])
        if kind == 'browser':
            assert data['width'] in (390, 1024, 1400), 'Changed viewport'
            engines.add(data['browser'])
        for metric in data['metrics']:
            result = verify_metric(metric, expected[metric['name']], kind)
            output.append(dict(result, kind=kind, repetition=repetition,
                               width=data.get('width'), file=str(file)))
        return data

    for repetition in (1, 2, 3):
        add(native / f'run-{repetition}' / 'results.json', 'native', NATIVE, repetition)
        files = sorted((browser / f'run-{repetition}').rglob('results.json'))
        assert len(files) == 3, 'Each browser invocation requires all three widths'
        widths = [add(file, 'browser', BROWSER, repetition)['width'] for file in files]
        assert sorted(widths) == [390, 1024, 1400], 'Duplicated/missing width'
    add(independent / 'results.json', 'independent', INDEPENDENT, None)
    assert len(commits) == 1 and len(nodes) == 1 and len(engines) == 1, 'Mixed source/engine versions'
    assert next(iter(nodes)) == 'v20.20.2', 'Missing/unpinned Node version'
    assert all(isinstance(commit, str) and len(commit) == 40 for commit in commits), 'Missing source identity'
    comparisons = []
    baseline_commit = None
    if native_baseline is not None:
        previous, previous_commits = [], set()
        for repetition in (1, 2, 3):
            data = json.loads((native_baseline / f'run-{repetition}' / 'results.json').read_text())
            assert data['kind'] == 'native' and data['fixtureSha256'] == digest, 'Baseline fixture mismatch'
            assert data['shape'] == {'nodes': 500, 'components': 21, 'depth': 4}, 'Baseline shape mismatch'
            for key in ('node', 'cpu', 'visibleCpus'):
                assert all(env[key] == data['environment'][key] for env in native_environments), 'Baseline environment mismatch'
            assert len(data['metrics']) == len(NATIVE) and {row['name'] for row in data['metrics']} == set(NATIVE), 'Baseline metric mismatch'
            previous_commits.add(data['commit'])
            previous.extend(verify_metric(metric, NATIVE[metric['name']], 'native') for metric in data['metrics'])
        assert len(previous_commits) == 1, 'Mixed baseline sources'
        baseline_commit = next(iter(previous_commits))
        comparisons = compare_native(output, previous)
    return {'fixtureSha256': digest, 'sourceCommit': next(iter(commits)),
            'node': next(iter(nodes)), 'browser': next(iter(engines)),
            'passed': sum(row['passed'] for row in output), 'gates': len(output),
            'rawSamples': sum(row['rawSamples'] for row in output),
            'targetMisses': [row for row in output if not row['targetMet']],
            'hardMisses': [row for row in output if not row['passed']], 'results': output,
            'nativeBaselineCommit': baseline_commit, 'nativeComparisons': comparisons,
            'regressionMisses': [row for row in comparisons if not row['passed']]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for field in ('native', 'browser', 'independent', 'fixture', 'output'):
        parser.add_argument(field, type=Path)
    parser.add_argument('--native-baseline', type=Path)
    args = parser.parse_args()
    result = audit(args.native, args.browser, args.independent, args.fixture, args.native_baseline)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ('sourceCommit', 'fixtureSha256', 'passed', 'gates', 'rawSamples')}))
    raise SystemExit(bool(result['hardMisses'] or result['regressionMisses']))
