import concurrent.futures,hashlib,json,os,sys,urllib.request,tarfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'data'/'runtime'
root.mkdir(parents=True,exist_ok=True)
def download(url,path):
    if path.exists(): return
    req=urllib.request.Request(url,headers={'User-Agent':'Rahban-local-setup'})
    partial=path.with_suffix(path.suffix+'.part')
    with urllib.request.urlopen(req,timeout=60) as response,open(partial,'wb') as out:
        while True:
            chunk=response.read(1024*1024)
            if not chunk:break
            out.write(chunk)
    partial.replace(path)
def grafana():
    path=root/'grafana.tar.gz'
    download('https://dl.grafana.com/grafana/release/13.2.4/grafana_13.2.4_38252365904_windows_amd64.tar.gz',path)
    actual=hashlib.sha256(path.read_bytes()).hexdigest()
    if actual!='3e005ff50fe3bb6b8cb428ef127636fac4ee676bf9b6d819c6a2297d21f4bcbd': raise ValueError('Grafana checksum mismatch')
    with tarfile.open(path) as archive:
        for m in archive.getmembers():
            if m.name.startswith('/') or '..' in Path(m.name).parts or m.issym() or m.islnk():raise ValueError('unsafe archive')
        archive.extractall(root/'grafana')
    print('Grafana downloaded, SHA256 verified, extracted',flush=True)
def prometheus():
    # Fixed official release; independently verify its published SHA256SUMS.
    version='3.8.0';name=f'prometheus-{version}.windows-amd64.zip'
    base=f'https://github.com/prometheus/prometheus/releases/download/v{version}/'
    path=root/name;sums=root/'prometheus-sha256sums.txt'
    download(base+'sha256sums.txt',sums);download(base+name,path)
    expected=next(line.split()[0] for line in sums.read_text().splitlines() if line.endswith(name))
    if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise ValueError('Prometheus checksum mismatch')
    with zipfile.ZipFile(path) as archive:
        if any('..' in Path(n).parts or n.startswith('/') for n in archive.namelist()):raise ValueError('unsafe archive')
        archive.extractall(root/'prometheus')
    print('Prometheus downloaded, SHA256 verified, extracted',flush=True)
failed=False
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    futures=[pool.submit(f) for f in [grafana,prometheus]]
    for f in concurrent.futures.as_completed(futures):
        try:f.result()
        except Exception as e:
            failed=True
            print(type(e).__name__,str(e),flush=True)
if failed:sys.exit(1)
