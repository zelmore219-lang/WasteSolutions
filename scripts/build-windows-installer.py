#!/usr/bin/env python3
"""Build a per-user Windows NSIS installer without executing Windows code."""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, struct, zlib

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.local/windows-test/win-unpacked'
OUT = ROOT / '.local/firebase-installer'
VERSION = json.loads((ROOT/'apps/desktop/package.json').read_text())['version']
EXE = OUT / f'CoreWaste-Setup-{VERSION}-x64.exe'

def quote(value):
    text = str(value)
    if any(c in text for c in '\r\n\0'): raise ValueError('Invalid installer path')
    return '"'+text.replace('$','$$').replace('"','$\\"')+'"'

def build():
    if not (RUNTIME/'CoreWaste.exe').is_file(): raise SystemExit('Build the Windows runtime first')
    if (RUNTIME/'CoreWaste.exe').open('rb').read(2) != b'MZ': raise SystemExit('Invalid Windows executable')
    files = []
    for p in sorted(RUNTIME.rglob('*')):
        if p.is_symlink(): raise SystemExit('Runtime symlinks are not allowed')
        if not p.is_file(): continue
        if any(x in p.relative_to(RUNTIME).parts for x in ['.state','.env','logins.json','database.env','startup.log']):
            raise SystemExit('Private state must not be packaged')
        files.append(p)
    if not files: raise SystemExit('Empty Windows runtime')
    candidates = []
    if os.environ.get('COREWASTE_MAKENSIS'): candidates.append(Path(os.environ['COREWASTE_MAKENSIS']))
    cache_roots = [ROOT.parent/'.cache/electron-builder',Path(os.environ.get('XDG_CACHE_HOME',Path.home()/'.cache'))/'electron-builder']
    for cache in cache_roots:
        if cache.is_dir(): candidates.extend(p for p in cache.rglob('makensis') if p.parent.name=='linux' and 'nsis-3.0.4.1' in str(p))
    compiler = next((p.resolve() for p in candidates if p.is_file()),None)
    if compiler is None: raise SystemExit('NSIS Linux compiler not cached. Run the portable Windows build first or set COREWASTE_MAKENSIS.')
    OUT.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(ROOT/'distribution/firebase/INSTALLER-README.txt',OUT/'START-HERE.txt')
    install=[]
    uninstall=[]
    directories=set()
    for p in files:
        rel=p.relative_to(RUNTIME)
        suffix='' if rel.parent==Path('.') else '\\'+str(rel.parent).replace('/','\\')
        # Variable prefixes are emitted literally; only the relative path is escaped.
        install.extend(['SetOutPath "$INSTDIR'+suffix+'"','File '+quote(p)])
        escaped=str(rel).replace('/','\\').replace('$','$$').replace('"','$\\"')
        uninstall.append('Delete "$INSTDIR\\'+escaped+'"')
        parent=rel.parent
        while parent!=Path('.'):
            directories.add(str(parent).replace('/','\\'));parent=parent.parent
    for directory in sorted(directories,key=lambda d:len(d.split('\\')),reverse=True):
        uninstall.append('RMDir "$INSTDIR\\'+directory+'"')
    (OUT/'payload-install.nsh').write_text('\n'.join(install)+'\n')
    (OUT/'payload-uninstall.nsh').write_text('\n'.join(uninstall)+'\n')
    env={**os.environ,'NSISDIR':str(compiler.parent.parent)}
    subprocess.run([str(compiler),'-V3','-DOUTPUT='+str(EXE),'-DBUILD_DIR='+str(OUT),'-DVERSION='+VERSION,str(ROOT/'distribution/firebase/installer.nsi')],env=env,check=True,cwd=ROOT)
    data=EXE.read_bytes()
    pe=struct.unpack_from('<I',data,0x3c)[0]
    if data[:2]!=b'MZ' or data[pe:pe+4]!=b'PE\0\0' or b'NullsoftInst' not in data: raise SystemExit('Installer header is invalid')
    if zlib.crc32(data[512:-4]) & 0xffffffff != struct.unpack('<I',data[-4:])[0]: raise SystemExit('NSIS integrity CRC failed')
    digest=hashlib.file_digest(EXE.open('rb'),'sha256').hexdigest()
    Path(str(EXE)+'.sha256').write_text(digest+'  '+EXE.name+'\n')
    result={'installer':str(EXE),'bytes':EXE.stat().st_size,'sha256':digest,'payload_files':len(files),'integrity_crc':'passed','per_user':True,'docker_required':False,'signed':False,'windows_execution':'not tested','cloud_activation':'pending'}
    (OUT/'installer-manifest.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__': build()
