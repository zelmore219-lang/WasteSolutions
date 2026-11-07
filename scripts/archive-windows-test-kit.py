#!/usr/bin/env python3
"""Archive only public runtime/test-kit files; never include generated user state."""
from pathlib import Path
import hashlib,json,os,sys,zipfile
root=Path(sys.argv[1]).resolve()
runtime=Path('.local/windows-test/win-unpacked').resolve()
if not (root/'CoreWaste.exe').is_file() or not (runtime/'resources/app.asar').is_file():
 raise SystemExit('Build and prepare the full Windows client before archiving')
files=[]
for item in runtime.rglob('*'):
 if item.is_symlink(): raise SystemExit('Runtime symlinks are not accepted')
 if item.is_file(): files.append(item.relative_to(runtime).as_posix())
files += ['START-HERE.txt','Start-CoreWaste.cmd','Open-Hosted-CoreWaste.cmd']
files += ['local-test/'+name for name in ['compose.yaml','bootstrap.cjs','checkpoint.cjs','images.tar.gz','manifest.json']]
if len(files)!=len(set(files)):raise SystemExit('Duplicate package entries')
manifest=json.loads((root/'local-test/manifest.json').read_text())
for entry in manifest['files']:
 file=root/'local-test'/entry['path']
 if not file.is_file() or file.stat().st_size!=entry['bytes'] or hashlib.file_digest(file.open('rb'),'sha256').hexdigest()!=entry['sha256']:raise SystemExit('Local test service integrity check failed')
archive=root.parent/(root.name+'.zip')
temporary=Path(str(archive)+'.tmp')
with zipfile.ZipFile(temporary,'w',allowZip64=True) as output:
 for name in files:
  file=root/name
  if not file.is_file() or file.is_symlink() or '.state' in Path(name).parts or Path(name).name in ['.env','logins.json','database.env','startup.log']:raise SystemExit('Private or invalid package entry rejected')
  output.write(file,root.name+'/'+name,compress_type=zipfile.ZIP_STORED if name.endswith('.tar.gz') else zipfile.ZIP_DEFLATED,compresslevel=3)
with zipfile.ZipFile(temporary) as check:
 bad=check.testzip()
 if bad:raise SystemExit('ZIP integrity failure: '+bad)
 with check.open(root.name+'/CoreWaste.exe') as executable:
  if executable.read(2)!=b'MZ':raise SystemExit('Windows executable header is missing')
 if len(check.namelist())!=len(files):raise SystemExit('Archive member mismatch')
os.replace(temporary,archive)
digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
Path(str(archive)+'.sha256').write_text(digest+'  '+archive.name+'\n')
print(json.dumps({'archive':str(archive),'size_bytes':archive.stat().st_size,'sha256':digest,'files':len(files),'private_state_included':False},indent=2))
