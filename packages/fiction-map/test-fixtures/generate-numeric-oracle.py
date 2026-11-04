"""Independent Fraction oracle for represented binary64 inputs; no timing workload."""
from fractions import Fraction as F
from pathlib import Path
import json, random, math
rng=random.Random(592)
def frac(v): return F.from_float(float(v))
def point(p): return tuple(map(frac,p))
def norm(v): return sum(x*x for x in v)
def sub(a,b): return tuple(x-y for x,y in zip(a,b))
values=[0.0,-0.0,math.ulp(0.0),-math.ulp(0.0),2.0**-500,-2.0**-500,2.0**-40,-2.0**-40,0.5,-0.5,1.0,-1.0,2.0**20,-2.0**20]
rows=[]
for i in range(24):
    a=[rng.choice(values),rng.choice(values)]; b=[rng.choice(values),rng.choice(values)]
    r=rng.choice([0.0,math.ulp(0.0),2.0**-500,2.0**-40,0.5,1.0,2.0**20,float.fromhex('0x1.fffffffffffffp+1023')])
    rows.append(dict(kind='near',a=a,b=b,r=r,expected=norm(sub(point(a),point(b)))<=frac(r)**2))
for i in range(24):
    a=[rng.choice(values),rng.choice(values)]; b=[rng.choice(values),rng.choice(values)]
    if a==b: b=[1.0,2.0]
    p=[rng.choice(values),rng.choice(values)]; r=rng.choice([0.0,math.ulp(0.0),2.0**-40,1.0,2.0**20])
    v=sub(point(b),point(a)); w=sub(point(p),point(a)); l=norm(v); t=max(F(0),min(F(1),sum(x*y for x,y in zip(v,w))/l))
    distance=norm(tuple(x-t*y for x,y in zip(w,v)))
    rows.append(dict(kind='segment',a=a,b=b,p=p,r=r,expected=distance<=frac(r)**2))
for i in range(24):
    s=rng.choice([math.ulp(0.0),2.0**-500,2.0**-40,0.5,1.0,1024.0,2.0**20])
    ring=[[0.0,0.0],[s,0.0],[0.0,s],[0.0,0.0]]
    threshold=rng.choice([0.0,math.ulp(0.0),2.0**-1000,0.5,1.0,2.0**40,float.fromhex('0x1.fffffffffffffp+1023')])
    rows.append(dict(kind='area',ring=ring,threshold=threshold,expected=frac(s)**2>=2*frac(threshold)))
for i in range(24):
    v=rng.choice(values+[1.5,-1.5,2.5,-2.5,rng.uniform(-1024,1024)]); step=2.0**rng.randint(-20,20)
    n=round(frac(v)/frac(step)); snapped=float(n*frac(step))
    rows.append(dict(kind='snap',value=v,step=step,expected=snapped))
Path(__file__).with_name('numeric-oracle.json').write_text(json.dumps(rows,indent=2,allow_nan=False)+'\n')
