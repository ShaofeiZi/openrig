import json,collections
recs=json.load(open('../_records.json'))
st=collections.Counter(r['status'] for r in recs)
done=[r for r in recs if r['status']=='done']
val=collections.Counter(r.get('validation_state') for r in done)
out=[]
out.append("== 自动快照（gen-snapshot.py 读 _records.json，勿手改）==")
out.append("total %d  status %s"%(len(recs),dict(st)))
out.append("done %d  validation %s"%(len(done),dict(val)))
bycat=collections.Counter(r.get('category') for r in done if r.get('validation_state')=='self_reported')
out.append("self_reported-by-category %s"%dict(bycat))
open('LEDGER-SNAPSHOT-AUTO.txt','w').write("\n".join(out)+"\n")
print("\n".join(out))
