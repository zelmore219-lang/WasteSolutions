#!/usr/bin/env python3
"""Package only the hosted portable client and instructions, never local state."""
from pathlib import Path
import hashlib, json, shutil, zipfile
root=Path(__file__).resolve().parent.parent
exe=root/'.local/windows-test/CoreWaste-Test-0.2.0-x64.exe'
if not exe.is_file() or exe.open('rb').read(2)!=b'MZ':
 raise SystemExit('Build the Windows portable executable first')
out=root/'.local/firebase-download'
out.mkdir(parents=True,exist_ok=True)
name='CoreWaste-Firebase-0.2.0-x64.exe'
shutil.copyfile(exe,out/name)
archive=out/'CoreWaste-Firebase-Windows-0.2.0-x64.zip'
temporary=archive.with_suffix('.zip.tmp')
with zipfile.ZipFile(temporary,'w') as z:
 z.write(out/name,name,compress_type=zipfile.ZIP_STORED)
 z.write(root/'distribution/firebase/START-HERE.txt','START-HERE.txt',compress_type=zipfile.ZIP_DEFLATED)
with zipfile.ZipFile(temporary) as z:
 if z.testzip() or set(z.namelist())!={name,'START-HERE.txt'}:raise SystemExit('Package integrity check failed')
temporary.replace(archive)
digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
Path(str(archive)+'.sha256').write_text(digest+'  '+archive.name+'\n')
print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'sha256':digest,'docker_required':False,'cloud_activation':'pending'},indent=2))
