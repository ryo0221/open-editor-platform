import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('React UI acceptance auditor uses all twenty samples and rejects incomplete or altered gates', () => {
  const result = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `
import importlib.util
spec=importlib.util.spec_from_file_location('audit','scripts/audit-react-ui-performance.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
m={'name':'prop','budgetMs':100,'targetMs':50,'warmups':5,'samples':[999]*5+list(range(1,21)),'p95Ms':19,'maxMs':20}
r=audit.verify_metric(m,100,'native')
assert r['valueMs']==19 and r['maxAllMs']==999 and r['passed']
bad=[dict(m,samples=m['samples'][:-1]),dict(m,p95Ms=18),dict(m,budgetMs=200),dict(m,samples=[float('nan')]*25)]
for value in bad:
 try:audit.verify_metric(value,100,'native')
 except AssertionError:pass
 else:raise AssertionError('accepted corrupt gate')
initial={'name':'initial','budgetMs':5000,'targetMs':2500,'warmups':0,'samples':[600],'p95Ms':None,'maxMs':600}
assert audit.verify_metric(initial,5000,'browser')['statistic']=='maximum'
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('native regression compares all three p95 values and blocks changes over twenty percent', () => {
  const result = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `
import importlib.util
spec=importlib.util.spec_from_file_location('audit','scripts/audit-react-ui-performance.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
old=[{'name':name,'valueMs':value} for name in audit.NATIVE for value in (8,9,10)]
new=[{'kind':'native','name':name,'valueMs':value} for name in audit.NATIVE for value in (10,11,12)]
assert all(row['passed'] for row in audit.compare_native(new,old))
new[2]['valueMs']=12.001
assert not audit.compare_native(new,old)[0]['passed']
try:audit.compare_native(new[:-1],old)
except AssertionError:pass
else:raise AssertionError('accepted incomplete comparison')
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
